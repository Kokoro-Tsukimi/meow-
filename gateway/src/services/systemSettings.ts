// E:\api中转站\meow-gateway\gateway\src\services\systemSettings.ts
// F.5 配套基础设施 · 系统级 key-value 配置的进程内缓存
//
// 定位:
//   - SystemSettings 表是 admin 端可调的全站配置(F.5 引入: 诊断模式总闸 / 货架 MB 上限)
//   - hot path(proxy.ts 每次请求三条件守门)每次穿 MySQL 太慢, 启动时加载进进程内 Map
//   - admin PATCH /api/v1/admin/settings 时同步刷新内存 + DB
//
// 调用方(F.5 后续阶段挂载):
//   - gateway/src/index.ts          启动时 await initSystemSettings()
//   - gateway/src/services/debugCache.ts  hot path 读 getDebugCachePerUserMaxMB() 等
//   - gateway/src/plugins/proxy.ts  三条件守门读 isDebugCacheEnabled()
//   - gateway/src/routes/admin.ts   GET /settings / PATCH /settings 调 list / updateSetting
//
// 设计:
//   - 进程内 Map 单实例存活(模块级变量, 多次 import 共享同一份)
//   - 未初始化或 key 缺失时 helper 回落到防御性默认值, 不抛错
//   - updateSetting 用 INSERT ... ON DUPLICATE KEY UPDATE, 表里没的 key 也能塞进去(G 阶段加新配置友好)
//   - 类型转换在 helper 里做, 调用方拿到的就是 boolean / number, 不需要自己 parse
//
// 错误处理:
//   - init/reload/update 遇到 MySQL 异常向上抛, 调用方决定怎么处理(启动期失败就让 gateway 启动失败)

import { pool } from '../db';

// 已知配置 key 的字面量类型, 给 IDE 自动补全 + 编译期防拼错
export type SystemSettingKey =
  | 'debug_cache_enabled'
  | 'debug_cache_per_user_max_mb'
  | 'global_rpm_limit'
  | 'blacklist_rpm_limit'
  | 'checkin_enabled'
  | 'checkin_reward_amount';

const cache = new Map<string, string>();

/**
 * 启动时调用一次, 从 MySQL 加载全部 SystemSettings 进进程内 Map
 */
export async function initSystemSettings(): Promise<void> {
  await reloadSystemSettings();
  console.info(`[SYS-SETTINGS][启动] 已加载 ${cache.size} 条配置`);
}

/**
 * 强制从 MySQL 重新加载所有配置覆盖内存
 * (admin updateSetting 之后会被调用; 也可手动调用做"配置漂移修复")
 */
export async function reloadSystemSettings(): Promise<void> {
  const [rows]: any = await pool.query('SELECT `key`, `value` FROM SystemSettings');
  cache.clear();
  for (const row of rows) {
    cache.set(row.key, row.value);
  }
}

/**
 * 通用 getter, 返回原始字符串值
 * @param key 配置 key
 * @returns 字符串 value 或 undefined(未初始化或 key 不存在)
 */
export function getSetting(key: SystemSettingKey | string): string | undefined {
  return cache.get(key);
}

/**
 * 列出当前所有配置(给 admin GET /settings 用)
 */
export function listSettings(): Array<{ key: string; value: string }> {
  return Array.from(cache.entries()).map(([key, value]) => ({ key, value }));
}

/**
 * 更新配置: 先写 MySQL, 成功后才更新内存, 避免内存超前于 DB
 * @param key 配置 key
 * @param value 新值(VARCHAR(255), 调用方负责字符串化 + 范围校验)
 */
export async function updateSetting(key: string, value: string): Promise<void> {
  await pool.query(
    'INSERT INTO SystemSettings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
    [key, value]
  );
  cache.set(key, value);
  console.info(`[SYS-SETTINGS][更新] ${key} = ${value}`);
}

// ============================================================
// 类型化 helper(给 hot path 用, 已做 parse + 防御性默认值)
// ============================================================

/**
 * admin 总闸: 全站是否允许写诊断缓存
 * 防御性默认 false: 配置丢失/未初始化时关闭功能比误开来得安全
 * (正常情况下 migration_F5.sql 已插入 'true', cache 会读到, 不会触发 fallback)
 */
export function isDebugCacheEnabled(): boolean {
  const v = cache.get('debug_cache_enabled');
  if (v === undefined) return false;
  return v === 'true';
}

/**
 * 每用户货架字节上限(从 MB 配置换算)
 * 默认 20 MB(跟 migration_F5.sql 初始值一致)
 */
export function getDebugCachePerUserMaxMB(): number {
  const v = cache.get('debug_cache_per_user_max_mb');
  if (v === undefined) return 20;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 20;
}

/**
 * S1+: 全站 RPM 上限(每用户每分钟最多请求次数)
 * 默认 5 RPM(贴合公益站 airp 实际使用频率, admin 可调)
 * 防御性默认值:配置丢失/未初始化时回落 5
 */
export function getGlobalRpmLimit(): number {
  const v = cache.get('global_rpm_limit');
  if (v === undefined) return 5;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 5;
}

/**
 * S1+: 拉黑账号 RPM 上限(BLACKLIST 状态用户的每分钟请求上限)
 * 默认 2 RPM("能用但不能滥用"——比正常用户更严, admin 可调)
 * 防御性默认值:配置丢失/未初始化时回落 2
 */
export function getBlacklistRpmLimit(): number {
  const v = cache.get('blacklist_rpm_limit');
  if (v === undefined) return 2;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

/**
 * F6: 签到系统总开关
 * 防御性默认 false: 配置丢失/未初始化时关闭功能比误开来得安全
 * (正常情况下 migration_F6_checkin.sql 已插入 'true', cache 会读到)
 */
export function isCheckinEnabled(): boolean {
  const v = cache.get('checkin_enabled');
  if (v === undefined) return false;
  return v === 'true';
}

/**
 * F6: 每日签到奖励咖啡豆数(人类可读豆数, 非放大值; 入账前 ×100000)
 * 默认 100 豆(跟 migration_F6_checkin.sql 初始值一致)
 * 防御性默认值:配置丢失/未初始化或非法值回落 100
 */
export function getCheckinRewardAmount(): number {
  const v = cache.get('checkin_reward_amount');
  if (v === undefined) return 100;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : 100;
}
