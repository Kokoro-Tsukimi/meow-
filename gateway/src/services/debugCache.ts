// E:\api中转站\meow-gateway\gateway\src\services\debugCache.ts
// F.5 核心 · Redis Stream 货架基础设施
//
// 定位:
//   - F.5 "中转站短期保管响应原文" 的存储层封装
//   - 每个 user 一条独立 Redis Stream, key = gateway:debug_cache:user:{user_id}
//   - 容量按 MB 控制(精确, 不是按条数), 超量 FIFO 淘汰
//   - admin 配置总闸 + 每用户上限通过 systemSettings 读取(已加载到进程内)
//
// entry 索引设计:
//   - 用 trace_id (跨 Bills/Logs/Cache 的统一语义键) 而非 log_id 作为查询锚点
//   - 原因: proxy.ts 写入这一刻还没有 logId(Logs 是 worker 异步写入后才生成主键),
//           trace_id 在请求第一行就生成, 是 proxy 当下唯一可用的稳定索引
//   - 前端 GET /bills/:id/details 时, user.ts 先用 Bill 主键查到 trace_id, 再调 readShelfItem
//
// 调用方(F.5 后续阶段挂载):
//   - gateway/src/plugins/proxy.ts   响应完成后异步调 writeToShelf(三条件守门通过后)
//   - gateway/src/routes/user.ts     GET /bills/:id/details 调 readShelfItem
//                                     GET /user/debug-mode/status 调 getShelfUsage
//                                     DELETE /bills/:id/cache 调 removeShelfItem
//   - gateway/src/worker.ts          每分钟一次 cron 调 purgeExpired
//
// 设计:
//   - 三条件守门由调用方做(admin 总闸 / user 开关 + TTL), 本文件只管第三条 "容量"
//   - 容量估算抽样: 取最近 N 条 entry 算平均字节, × XLEN 得总字节估算; 超就 XTRIM 近似裁剪
//   - readShelfItem/removeShelfItem 用 XRANGE 全扫 filter trace_id, 单 user 几千条以内可接受
//   - purgeExpired 用 SCAN 遍历所有 user stream, 不维护单独的 active_users 索引(一致性简单)
//
// 错误处理:
//   - 所有函数遇到 Redis 异常向上抛, 调用方自行 try/catch
//   - proxy.ts 调 writeToShelf 时建议 .catch 吞掉(缓存写失败不应影响主响应)

import { redis } from '../redis';
import { getDebugCachePerUserMaxMB } from './systemSettings';

const STREAM_KEY_PREFIX = 'gateway:debug_cache:user:';
const SAMPLE_SIZE = 10;          // 字节估算抽样条数
const SCAN_BATCH = 100;          // purgeExpired 每次 SCAN 的 COUNT 提示
const BYTES_PER_MB = 1024 * 1024;

export interface ShelfItem {
  responseBody: string;
  cachedAt: number;     // 入架时刻 (ms)
  expiresAt: number;    // 到期时刻 (ms)
}

export interface ShelfUsage {
  itemCount: number;
  usedBytes: number;
  usedMB: number;       // 保留 2 位小数
  maxMB: number;
}

function shelfKey(userId: number): string {
  return `${STREAM_KEY_PREFIX}${userId}`;
}

/**
 * 写入一条响应原文到该 user 的货架, 超量自动 FIFO 淘汰
 * @param userId        用户 ID
 * @param traceId       请求 trace_id (跨 Bills/Logs/Cache 的统一语义键)
 * @param responseBody  响应原文字符串
 * @param expiresAtMs   绝对到期时间戳(ms, Unix epoch)
 */
export async function writeToShelf(
  userId: number,
  traceId: string,
  responseBody: string,
  expiresAtMs: number
): Promise<void> {
  const key = shelfKey(userId);
  const maxMB = getDebugCachePerUserMaxMB();
  const maxBytes = maxMB * BYTES_PER_MB;
  const nowMs = Date.now();

  // ① 单条字节预检: 单条本身超 MB 上限直接拒(避免一条巨响应吃满整个货架)
  const newEntryBytes = Buffer.byteLength(responseBody, 'utf8');
  if (newEntryBytes > maxBytes) {
    console.warn(
      `[DEBUG-CACHE] userId=${userId} 单条响应 ${(newEntryBytes / BYTES_PER_MB).toFixed(2)}MB 超过货架上限 ${maxMB}MB, 拒绝入架`
    );
    return;
  }

  // ② XADD 新 entry
  await redis.xadd(
    key,
    '*',
    'trace_id', traceId,
    'response_body', responseBody,
    'cached_at', String(nowMs),
    'expires_at', String(expiresAtMs)
  );

  // ③ 估算总字节, 超就 XTRIM 近似裁剪
  const { count, bytes, avgBytes } = await estimateStreamBytes(key);
  if (avgBytes > 0 && bytes > maxBytes) {
    const targetLen = Math.max(1, Math.floor(maxBytes / avgBytes));
    if (targetLen < count) {
      // MAXLEN ~ N: 近似裁剪, 性能更好
      await redis.xtrim(key, 'MAXLEN', '~', targetLen);
      console.info(
        `[DEBUG-CACHE] userId=${userId} 货架估算占用 ${(bytes / BYTES_PER_MB).toFixed(2)}MB 超 ${maxMB}MB, XTRIM 到 ~${targetLen} 条`
      );
    }
  }
}

/**
 * 读取一条 trace_id 对应的响应原文
 * @returns ShelfItem 或 null(不存在/已过期)
 */
export async function readShelfItem(userId: number, traceId: string): Promise<ShelfItem | null> {
  const key = shelfKey(userId);
  const entries = await redis.xrange(key, '-', '+');
  const nowMs = Date.now();

  for (const [, fields] of entries) {
    const map = fieldsToObject(fields);
    if (map.trace_id === traceId) {
      const expiresAt = Number(map.expires_at);
      if (expiresAt < nowMs) return null;  // 过期视同不存在(等 purgeExpired 真删)
      return {
        responseBody: map.response_body ?? '',
        cachedAt: Number(map.cached_at),
        expiresAt,
      };
    }
  }
  return null;
}

/**
 * 立即从货架移除一条 entry(给用户在前端点 🗑️ "立即移除" 用)
 * @returns 是否真的删了一条
 */
export async function removeShelfItem(userId: number, traceId: string): Promise<boolean> {
  const key = shelfKey(userId);
  const entries = await redis.xrange(key, '-', '+');

  for (const [entryId, fields] of entries) {
    const map = fieldsToObject(fields);
    if (map.trace_id === traceId) {
      const deleted = await redis.xdel(key, entryId);
      return deleted > 0;
    }
  }
  return false;
}

/**
 * 清理所有 user 货架上已过期的 entry
 * (给 worker.ts 每分钟 cron 调用)
 * @returns 本次清理的 entry 总数
 */
export async function purgeExpired(): Promise<number> {
  const nowMs = Date.now();
  let totalDeleted = 0;
  let cursor = '0';

  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      'MATCH',
      `${STREAM_KEY_PREFIX}*`,
      'COUNT',
      SCAN_BATCH
    );
    cursor = nextCursor;

    for (const key of keys) {
      const entries = await redis.xrange(key, '-', '+');
      const toDelete: string[] = [];
      for (const [entryId, fields] of entries) {
        const map = fieldsToObject(fields);
        if (Number(map.expires_at) < nowMs) {
          toDelete.push(entryId);
        }
      }
      if (toDelete.length > 0) {
        await redis.xdel(key, ...toDelete);
        totalDeleted += toDelete.length;
      }
    }
  } while (cursor !== '0');

  if (totalDeleted > 0) {
    console.info(`[DEBUG-CACHE][清理] 本轮清掉 ${totalDeleted} 条过期 entry`);
  }
  return totalDeleted;
}

/**
 * 查询某 user 当前货架占用情况(给前端 Tokens 诊断卡片显示用)
 */
export async function getShelfUsage(userId: number): Promise<ShelfUsage> {
  const key = shelfKey(userId);
  const maxMB = getDebugCachePerUserMaxMB();
  const { count, bytes } = await estimateStreamBytes(key);
  return {
    itemCount: count,
    usedBytes: bytes,
    usedMB: Math.round((bytes / BYTES_PER_MB) * 100) / 100,
    maxMB,
  };
}

// ============================================================
// 内部 helper
// ============================================================

/**
 * 估算一条 stream entry 的字节数(字段名 + 字段值的 UTF-8 字节数总和, 近似)
 */
function estimateEntryBytes(fields: string[]): number {
  let total = 0;
  for (const s of fields) {
    total += Buffer.byteLength(s, 'utf8');
  }
  return total;
}

/**
 * 估算指定 stream 当前总字节占用(抽样)
 */
async function estimateStreamBytes(
  key: string
): Promise<{ count: number; bytes: number; avgBytes: number }> {
  const count = await redis.xlen(key);
  if (count === 0) return { count: 0, bytes: 0, avgBytes: 0 };

  const sampleCount = Math.min(count, SAMPLE_SIZE);
  const sample = await redis.xrevrange(key, '+', '-', 'COUNT', sampleCount);
  // sample 形如 [[entryId, [field1, value1, field2, value2, ...]], ...]
  let sampleBytes = 0;
  for (const [, fields] of sample) {
    sampleBytes += estimateEntryBytes(fields);
  }
  const avgBytes = sampleBytes / sampleCount;
  const bytes = Math.round(avgBytes * count);
  return { count, bytes, avgBytes };
}

/**
 * Stream entry 的字段数组形如 [k1, v1, k2, v2, ...] 转 plain object
 */
function fieldsToObject(fields: string[]): Record<string, string> {
  const obj: Record<string, string> = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}
