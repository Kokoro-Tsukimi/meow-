import dotenv from 'dotenv';
import { request as undiciRequest } from 'undici';
import { redis } from './redis';
import { pool } from './db';
import { purgeExpired } from './services/debugCache';

dotenv.config();

// ============ 配置 ============
const STREAM_KEY = 'gateway:stream:billing';
const GROUP_NAME = 'group_billing_workers';
const CONSUMER_NAME = `worker_${process.pid}`;
const BLOCK_MS = 5000; // 没消息时阻塞等待5秒
// C+.5 容灾参数
const RECLAIM_IDLE_MS = 10 * 60 * 1000; // 超过10分钟未ACK的消息视为"幽灵消息",可被认领
const RECLAIM_INTERVAL_MS = 60 * 1000;  // 每60秒扫一次PEL
const MAX_DELIVERY_COUNT = 5;           // 投递超过5次仍失败 → 视为毒药消息,移入死信队列
const DLQ_KEY = 'gateway:dlq:billing';  // 死信队列(List)

// ============ E.2 影子流量搬运配置 ============
const SHADOW_STREAM_KEY = 'gateway:stream:shadow';       // proxy 命中 SHADOW 规则后,克隆体丢进这条传送带
const SHADOW_GROUP_NAME = 'group_shadow_workers';
// 影子消费者用固定名字(不掺pid):worker 重启后还是"同一个人",
// 能直接认领自己上次没ACK完的消息,不会留下无主的幽灵喵
const SHADOW_CONSUMER_NAME = 'shadow_worker_1';
const SHADOW_FLUSH_SIZE = 1000;          // 缓冲区攒满1000条 → 触发批量归档
const SHADOW_FLUSH_INTERVAL_MS = 5000;   // 或者每5秒 → 也触发一次(两个条件先到先触发)
const SHADOW_BUFFER_HARD_CAP = 5000;     // 缓冲区硬上限:ClickHouse宕机时停止收新件,防内存爆炸
const CLICKHOUSE_URL = process.env.CLICKHOUSE_URL || 'http://localhost:8123';
// E.2 修复: 新版 ClickHouse 镜像不许外来客匿名进门,带上工牌喵(开发期弱密码,收尾统一换强)
const CLICKHOUSE_USER = process.env.CLICKHOUSE_USER || 'meow_user';
const CLICKHOUSE_PASSWORD = process.env.CLICKHOUSE_PASSWORD || '666';

// ============ 初始化消费组 ============
async function ensureGroup() {
  try {
    // $ 表示只消费组创建后的新消息；MKSTREAM 自动建流
    await redis.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '$', 'MKSTREAM');
    console.info(`[WORKER][初始化] 消费组 ${GROUP_NAME} 创建成功`);
  } catch (err: any) {
    if (err.message && err.message.includes('BUSYGROUP')) {
      console.info(`[WORKER][初始化] 消费组 ${GROUP_NAME} 已存在,继续`);
    } else {
      throw err;
    }
  }
}

// ============ 处理单条消息 ============
async function processMessage(messageId: string, fields: Record<string, string>) {
  const trace_id = fields.trace_id;
  const user_id = fields.user_id;
  const model = fields.model || 'unknown';
  const channel_id = fields.channel_id ? parseInt(fields.channel_id, 10) : null;
  const cost = fields.cost ? parseInt(fields.cost, 10) : 0; // 放大10w倍的整数
  // C+.4 (M2): proxy 现在会把这两个 token 数随消息一起入队,这里读出来写进 Logs
  // (字段缺失时兜底为 0,兼容修复前残留在队列里的老消息)
  const prompt_tokens = fields.prompt_tokens ? parseInt(fields.prompt_tokens, 10) : 0;
  const completion_tokens = fields.completion_tokens ? parseInt(fields.completion_tokens, 10) : 0;
  // C+.4 (M3): token_id 用于更新该召唤铃的 used_quota(老消息/老缓存可能没有,为 null 时跳过)
  const token_id = fields.token_id ? parseInt(fields.token_id, 10) : null;
  // F.5(B2): proxy 现在传真实 status_code + 两个 latency 字段, 老消息(B1 改之前残留)缺这三个字段时用合理默认值兜底
  const status_code = fields.status_code ? parseInt(fields.status_code, 10) : 200;
  const latency_upstream_ms = fields.latency_upstream_ms ? parseInt(fields.latency_upstream_ms, 10) : 0;
  const latency_proxy_ms = fields.latency_proxy_ms ? parseInt(fields.latency_proxy_ms, 10) : 0;
  // F5.2: proxy L761 isStream(从响应 Content-Type 推断) → ARGV[12] → 这里, 老消息(F5.2 之前残留)缺字段时默认 0
  const is_stream = fields.is_stream === '1' ? 1 : 0;
  // F5.3: 缓存命中 tokens。空串/缺字段 = 上游未回传 → 落库 NULL(与 0=零命中严格分家);
  // F5.3 之前残留在队列里的老消息无此字段, 同样落 NULL(历史上从未采集, 诚实标注未知)
  const cachedRaw = fields.cached_tokens;
  const parsedCached = cachedRaw !== undefined && cachedRaw !== '' ? parseInt(cachedRaw, 10) : NaN;
  const cached_tokens = Number.isFinite(parsedCached) ? parsedCached : null;

  if (!trace_id || !user_id) {
    console.warn(`[WORKER][跳过] 消息 ${messageId} 缺少 trace_id 或 user_id`);
    await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    // 阶段1: 幂等校验 - 先插 Logs(trace_id唯一)
    // C+.4 (M2): 补写 prompt_tokens / completion_tokens 两列(以前没传,恒为0)
    // F.5(B2): status_code 不再硬编码 200, 改读消息真实值; 新增 latency_upstream_ms / latency_proxy_ms 两列
    // F5.2: 新增 is_stream 列(流式响应标志)
    try {
      await connection.query(
        `INSERT INTO Logs (trace_id, user_id, channel_id, model, prompt_tokens, cached_tokens, completion_tokens, cost, status_code, latency_upstream_ms, latency_proxy_ms, is_stream, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [trace_id, user_id, channel_id, model, prompt_tokens, cached_tokens, completion_tokens, cost, status_code, latency_upstream_ms, latency_proxy_ms, is_stream]
      );
    } catch (e: any) {
      if (e.code === 'ER_DUP_ENTRY') {
        // 这条消息已经处理过了,直接ACK跳过(幂等)
        await connection.rollback();
        await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
        console.info(`[WORKER][幂等跳过] trace_id: ${trace_id} 已处理过`);
        return;
      }
      throw e;
    }

    // 阶段2: 扣减 Users 总余额(防超卖兜底)
    // C+.4 (M4): 把"扣余额"挪到"写 Bills"之前,这样能先拿到扣完后的余额快照,
    //            再写进 Bills.balance_after。balanceAfter 用变量记下,供阶段3回填。
    let balanceAfter: number;
    const [updateRes]: any = await connection.query(
      `UPDATE Users SET balance = balance - ? WHERE id = ? AND balance >= ?`,
      [cost, user_id, cost]
    );

    if (updateRes.affectedRows === 0) {
      // 余额不足(透支),记录异常但不阻塞——余额扣到底为0的边界情况
      console.warn(`[WORKER][余额透支] user_id: ${user_id}, cost: ${cost}, 强制扣至0`);
      await connection.query(
        `UPDATE Users SET balance = 0 WHERE id = ?`,
        [user_id]
      );
      balanceAfter = 0; // 透支后强制扣到0,快照即为0
    } else {
      // 正常扣减:回查一次扣完后的真实余额作为快照
      const [balRows]: any = await connection.query(
        `SELECT balance FROM Users WHERE id = ?`,
        [user_id]
      );
      balanceAfter = balRows.length > 0 ? Number(balRows[0].balance) : 0;
    }

    // 阶段3: 写 Bills 财务流水(CONSUME)
    // C+.4 (M4): 回填 balance_after(本笔扣费后的余额快照,放大10万倍的整数)
    await connection.query(
      `INSERT INTO Bills (user_id, type, amount, balance_after, reference_id, model, created_at)
       VALUES (?, 'CONSUME', ?, ?, ?, ?, NOW())`,
      [user_id, -cost, balanceAfter, trace_id, model]
    );

    // 阶段4: 更新该召唤铃的累计用量 used_quota
    // C+.4 (M3): token_id 缺失(老消息/老缓存)时跳过,不影响其余结算
    if (token_id !== null && !Number.isNaN(token_id)) {
      await connection.query(
        `UPDATE Tokens SET used_quota = used_quota + ? WHERE id = ?`,
        [cost, token_id]
      );
    }

    await connection.commit();
    await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
    console.info(`[WORKER][结算完成] trace_id: ${trace_id}, user: ${user_id}, cost: ${(cost / 100000).toFixed(5)}, 余额: ${(balanceAfter / 100000).toFixed(5)}`);
  } catch (err: any) {
    await connection.rollback();
    console.error(`[WORKER][结算失败] trace_id: ${trace_id}, 错误:`, err.message);
    // 不ACK,消息留在PEL,下次重试
  } finally {
    connection.release();
  }
}

// ============ 主循环 ============
async function mainLoop() {
  console.info(`[WORKER][启动] 消费者 ${CONSUMER_NAME} 开始监听 ${STREAM_KEY}`);

  while (true) {
    try {
      // 阻塞读取新消息
      const result: any = await redis.xreadgroup(
        'GROUP', GROUP_NAME, CONSUMER_NAME,
        'COUNT', 10,
        'BLOCK', BLOCK_MS,
        'STREAMS', STREAM_KEY, '>'
      );

      if (!result || result.length === 0) {
        continue; // 超时无消息,继续循环
      }

      // result 格式: [[streamKey, [[messageId, [field1, val1, field2, val2, ...]], ...]]]
      for (const [, messages] of result) {
        for (const [messageId, fieldArr] of messages) {
          // 把 [k1,v1,k2,v2] 转成 {k1:v1, k2:v2}
          const fields: Record<string, string> = {};
          for (let i = 0; i < fieldArr.length; i += 2) {
            fields[fieldArr[i]] = fieldArr[i + 1];
          }
          await processMessage(messageId, fields);
        }
      }
    } catch (err: any) {
      console.error('[WORKER][主循环错误]', err.message);
      // 短暂等待后继续,避免疯狂报错刷屏
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ============ C+.5 容灾: PEL认领 + 死信队列 ============
/**
 * 扫描"幽灵消息":被某个worker拉走但超过10分钟没ACK的消息
 * (典型场景:那个worker处理到一半崩溃了,消息卡在它的PEL里没人管)
 * - 投递次数 <= 5: 认领到当前worker重新处理
 * - 投递次数 > 5: 毒药消息(比如格式坏了,谁处理谁崩),移入死信队列并告警,
 *   防止它永远堵着消费组。人工修复后可从 DLQ 手动补偿。
 */
async function reclaimStaleMessages() {
  try {
    // XPENDING 带 IDLE 过滤: 只看挂起超过 RECLAIM_IDLE_MS 的消息
    // 返回格式: [[messageId, consumer, idleMs, deliveryCount], ...]
    const pending: any = await redis.xpending(
      STREAM_KEY, GROUP_NAME,
      'IDLE', RECLAIM_IDLE_MS,
      '-', '+', 50
    );

    if (!pending || pending.length === 0) return;

    console.info(`[WORKER][PEL扫描] 发现 ${pending.length} 条超时未ACK的幽灵消息`);

    for (const [messageId, , , deliveryCount] of pending) {
      // 先把消息认领到自己名下(顺便拿到消息体)
      const claimed: any = await redis.xclaim(
        STREAM_KEY, GROUP_NAME, CONSUMER_NAME,
        RECLAIM_IDLE_MS, messageId
      );
      if (!claimed || claimed.length === 0) continue; // 被别的worker抢先认领了,跳过

      const [, fieldArr] = claimed[0];
      if (!fieldArr) {
        // 消息体已不存在(被trim),只能ACK掉
        await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
        continue;
      }

      if (Number(deliveryCount) > MAX_DELIVERY_COUNT) {
        // 毒药消息 → 进死信队列,从主队列抹除
        await redis.rpush(DLQ_KEY, JSON.stringify({
          message_id: messageId,
          delivery_count: Number(deliveryCount),
          fields: fieldArr,
          moved_at: new Date().toISOString(),
        }));
        await redis.xack(STREAM_KEY, GROUP_NAME, messageId);
        console.error(`[WORKER][死信队列] 消息 ${messageId} 已重试${deliveryCount}次仍失败,移入 ${DLQ_KEY},需人工介入排查!`);
      } else {
        // 普通幽灵消息 → 重新处理(processMessage 自带幂等,重复消费也不会重复扣账)
        const fields: Record<string, string> = {};
        for (let i = 0; i < fieldArr.length; i += 2) {
          fields[fieldArr[i]] = fieldArr[i + 1];
        }
        console.info(`[WORKER][PEL认领] 重新处理幽灵消息 ${messageId} (第${deliveryCount}次投递)`);
        await processMessage(messageId, fields);
      }
    }
  } catch (err: any) {
    console.error('[WORKER][PEL扫描错误]', err.message);
  }
}

// ============ E.2 影子流量搬运: Redis传送带 → ClickHouse档案柜 ============
/**
 * 工作方式(和计费链路互不干扰,各用各的消费组):
 * 1. 从 gateway:stream:shadow 拉克隆体,先放进内存缓冲区(不立刻写库)
 * 2. 缓冲区攒满 1000 条 或 距上次归档满 5 秒 → 把整批一次性写进 ClickHouse
 *    (ClickHouse 喜欢"少次大批",讨厌"频繁小笔",所以攒批是它的正确打开方式喵)
 * 3. 写库成功 → 统一ACK + 清空这批缓冲;写库失败 → 不清buffer不ACK,下个周期重试
 * 4. ClickHouse 长时间宕机时,缓冲区到达硬上限就暂停收新件(消息安全地留在Redis里),防内存爆炸
 * 注:极端情况下(写库成功但ACK前崩溃)重启会重复归档同一批——审计档案多一份副本无伤大雅,
 *    这里用"至少一次"换实现简单,和计费链路的严格幂等是两种取舍喵。
 */

// 内存缓冲区:每个元素带着 Redis 消息id(归档成功后要凭它去ACK)
const shadowBuffer: { messageId: string; row: Record<string, any> }[] = [];
let shadowFlushing = false;        // 归档进行中标记,防止定时器和攒满触发撞车
let lastShadowErrorLog = 0;        // 失败日志限流用,避免宕机时每5秒刷一条错误

async function ensureShadowGroup() {
  try {
    await redis.xgroup('CREATE', SHADOW_STREAM_KEY, SHADOW_GROUP_NAME, '$', 'MKSTREAM');
    console.info(`[WORKER][影子初始化] 消费组 ${SHADOW_GROUP_NAME} 创建成功`);
  } catch (err: any) {
    if (err.message && err.message.includes('BUSYGROUP')) {
      console.info(`[WORKER][影子初始化] 消费组 ${SHADOW_GROUP_NAME} 已存在,继续`);
    } else {
      throw err;
    }
  }
}

/**
 * 把缓冲区整批写进 ClickHouse(HTTP接口 + JSONEachRow 格式:一行一个JSON对象)
 * 成功 → ACK全部 + 从缓冲区移除;失败 → 原封不动留着,下次再试
 */
async function flushShadowBuffer() {
  if (shadowFlushing || shadowBuffer.length === 0) return;
  shadowFlushing = true;
  try {
    const batch = shadowBuffer.slice(); // 快照:归档期间新到的消息不掺进本批
    const lines = batch.map((b) => JSON.stringify(b.row)).join('\n');
    const insertSql = 'INSERT INTO meow_audit.AuditShadows (trace_id, user_id, rule_id, rule_name, model, request_body, response_body) FORMAT JSONEachRow';

    const res = await undiciRequest(`${CLICKHOUSE_URL}/?query=${encodeURIComponent(insertSql)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-ClickHouse-User': CLICKHOUSE_USER,
        'X-ClickHouse-Key': CLICKHOUSE_PASSWORD,
      },
      body: lines,
    });
    const resText = await res.body.text();
    if (res.statusCode !== 200) {
      throw new Error(`ClickHouse HTTP ${res.statusCode}: ${resText.slice(0, 200)}`);
    }

    // 写库成功 → 统一ACK,再把这批从缓冲区头部移走
    const ids = batch.map((b) => b.messageId);
    await redis.xack(SHADOW_STREAM_KEY, SHADOW_GROUP_NAME, ...ids);
    shadowBuffer.splice(0, batch.length);
    console.info(`[WORKER][影子归档] 已批量写入 ClickHouse ${batch.length} 条并ACK,缓冲区剩余 ${shadowBuffer.length}`);
  } catch (err: any) {
    // 失败:不清buffer不ACK,消息和缓冲都还在,下个触发点自动重试
    const now = Date.now();
    if (now - lastShadowErrorLog > 30000) { // 最多30秒报一次,防刷屏
      console.error(`[WORKER][影子归档失败] 本批保留在缓冲区稍后重试(当前积压 ${shadowBuffer.length} 条):`, err.message);
      lastShadowErrorLog = now;
    }
  } finally {
    shadowFlushing = false;
  }
}

/**
 * 影子消费主循环(用独立的 Redis 连接做阻塞读,不和计费循环抢一条连接)
 */
async function shadowLoop() {
  const shadowRedis = redis.duplicate(); // 阻塞式XREADGROUP会霸占连接,所以复制一条专线喵
  await ensureShadowGroup();

  // 重启接管:固定消费者名 + '0' 起点,先把自己上次拉走但没ACK完的消息重新装回缓冲区
  try {
    const pending: any = await shadowRedis.xreadgroup(
      'GROUP', SHADOW_GROUP_NAME, SHADOW_CONSUMER_NAME,
      'COUNT', SHADOW_BUFFER_HARD_CAP,
      'STREAMS', SHADOW_STREAM_KEY, '0'
    );
    if (pending && pending.length > 0) {
      let recovered = 0;
      for (const [, messages] of pending) {
        for (const [messageId, fieldArr] of messages) {
          if (!fieldArr) { await redis.xack(SHADOW_STREAM_KEY, SHADOW_GROUP_NAME, messageId); continue; }
          const fields: Record<string, string> = {};
          for (let i = 0; i < fieldArr.length; i += 2) fields[fieldArr[i]] = fieldArr[i + 1];
          shadowBuffer.push({ messageId, row: buildShadowRow(fields) });
          recovered++;
        }
      }
      if (recovered > 0) console.info(`[WORKER][影子接管] 恢复上次未归档的 ${recovered} 条克隆体进缓冲区`);
    }
  } catch (err: any) {
    console.error('[WORKER][影子接管错误]', err.message);
  }

  // 定时器:每5秒尝试归档一次(攒不满1000条也别让档案积灰喵)
  setInterval(flushShadowBuffer, SHADOW_FLUSH_INTERVAL_MS);

  console.info(`[WORKER][影子启动] 消费者 ${SHADOW_CONSUMER_NAME} 开始监听 ${SHADOW_STREAM_KEY}`);

  while (true) {
    try {
      // 缓冲区满(ClickHouse多半宕机了)→ 暂停收件,消息安全地堆在Redis里等档案柜修好
      if (shadowBuffer.length >= SHADOW_BUFFER_HARD_CAP) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }

      const result: any = await shadowRedis.xreadgroup(
        'GROUP', SHADOW_GROUP_NAME, SHADOW_CONSUMER_NAME,
        'COUNT', 100,
        'BLOCK', BLOCK_MS,
        'STREAMS', SHADOW_STREAM_KEY, '>'
      );

      if (!result || result.length === 0) continue;

      for (const [, messages] of result) {
        for (const [messageId, fieldArr] of messages) {
          const fields: Record<string, string> = {};
          for (let i = 0; i < fieldArr.length; i += 2) fields[fieldArr[i]] = fieldArr[i + 1];
          shadowBuffer.push({ messageId, row: buildShadowRow(fields) });
        }
      }

      // 攒满就立刻归档,不等定时器
      if (shadowBuffer.length >= SHADOW_FLUSH_SIZE) {
        await flushShadowBuffer();
      }
    } catch (err: any) {
      console.error('[WORKER][影子主循环错误]', err.message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/** 把 Redis 消息字段整理成 ClickHouse 的一行(类型对齐建表语句) */
function buildShadowRow(fields: Record<string, string>): Record<string, any> {
  return {
    trace_id: fields.trace_id || '',
    user_id: fields.user_id || '',
    rule_id: Number(fields.rule_id) || 0,
    rule_name: fields.rule_name || '',
    model: fields.model || '',
    request_body: fields.request_body || '',
    response_body: fields.response_body || '',
  };
}

// ============ 心跳 ============
function startHeartbeat() {
  setInterval(async () => {
    try {
      await redis.set(`gateway:worker:heartbeat:${CONSUMER_NAME}`, Date.now(), 'EX', 30);
    } catch (err: any) {
      console.error('[WORKER][心跳错误]', err.message);
    }
  }, 15000);
}

// ============ 启动 ============
async function start() {
  try {
    await pool.query('SELECT 1'); // 确保DB可用
    await ensureGroup();
    startHeartbeat();
    // C+.5: 启动时先扫一遍PEL(接管上次崩溃留下的烂摊子),之后每分钟扫一次
    reclaimStaleMessages();
    setInterval(reclaimStaleMessages, RECLAIM_INTERVAL_MS);
    // F.5(B2): 每分钟扫一次诊断货架, 清掉过期 entry(诊断模式窗口期结束后的 cache)
    setInterval(() => {
      purgeExpired().catch((err) => console.error('[WORKER][F.5货架清理错误]', err.stack || err.message));
    }, 60 * 1000);
    // E.2: 拉起影子搬运循环(不await,和计费主循环并行各干各的喵)
    shadowLoop().catch((err) => console.error('[WORKER][影子循环崩溃]', err.stack || err.message));
    await mainLoop();
  } catch (err: any) {
    console.error('[WORKER][启动失败]', err.stack || err.message);
    process.exit(1);
  }
}

start();