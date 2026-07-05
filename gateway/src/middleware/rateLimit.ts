import { FastifyRequest, FastifyReply } from 'fastify';
import { redis } from '../redis';

/**
 * D.3 限流器: 固定窗口(Fixed Window)算法
 * - 每个用户每分钟最多 RATE_LIMIT_PER_MINUTE 次请求(默认60)
 * - Key: gateway:ratelimit:user:{user_id}:{分钟时间戳}, TTL 60秒自动过期,杜绝内存泄露
 * - INCR 和 EXPIRE 放进同一个 Lua 脚本保证原子性
 *   (否则 INCR 成功但 EXPIRE 没来得及执行时进程崩溃,会留下一个永不过期的计数器)
 * - 挂载位置: authMiddleware 之后(需要 req.user.id),只作用于 /v1 代理路由
 */
const luaScript = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])

local current = redis.call('INCR', key)
if current == 1 then
  redis.call('EXPIRE', key, 60)
end

if current > limit then
  return 0
end
return 1
`;

export async function rateLimitMiddleware(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user;
  if (!user) return; // 理论上不会发生(auth 在前),保险起见直接放行

  // 限额从 .env 读,没配默认 60/分钟。
  // (在函数内读取而非模块顶层,确保 dotenv.config() 已执行)
  const limit = Number(process.env.RATE_LIMIT_PER_MINUTE) || 60;

  const minuteWindow = Math.floor(Date.now() / 60000); // 当前是哪一分钟
  const key = `gateway:ratelimit:user:${user.id}:${minuteWindow}`;

  try {
    const allowed = await redis.eval(luaScript, 1, key, String(limit));
    if (allowed === 0) {
      console.warn(`[GATEWAY][限流] UserID: ${user.id} 超过每分钟 ${limit} 次限制,已拦截`);
      return reply.status(429).send({
        error: 'Too Many Requests',
        message: '点单太快啦,女仆猫端不过来了,请下一分钟再来喵~',
      });
    }
  } catch (err: any) {
    // fail-open: 限流器自身故障(如Redis抖动)时放行而不是阻断业务,
    // 宁可短暂限不住,也不能把正常用户全拦在门外。
    console.error('[GATEWAY][限流] 异常(已放行):', err.message);
  }
}
/**
 * S1.前哨 · 登录限流器(防机械化暴力试错)
 * ============================================================
 * 设计目标:防止 credential stuffing / brute force 攻击。
 * 与上面 D.3 限流器的区别:
 *   - D.3 是"已登录用户"维度,只作 /v1 代理路由的速率削峰
 *   - 这里是"未登录"维度,作用于 /auth/login + /admin/auth/login + /forgot-password/reset
 *
 * 双维度独立计数 + 锁:
 *   - email 维度:精准打击针对特定账号的暴力破解
 *   - IP    维度:防止单 IP 拿账号字典轮询
 *
 * 阈值配置见 SCOPE_CONFIG。任一维度达上限即锁该维度。
 *
 * 解锁策略(本窗已与小昙拍板):
 *   - 登录成功     → 仅清 email 维度的 fail + lock(不清 IP,防攻击者解套)
 *   - 找回密码成功 → 仅清 email 维度的 fail + lock(同上)
 *
 * Key 规约:
 *   - gateway:loginfail:{scope}:{dim}:{identifier}  失败计数器,TTL=failWindow
 *   - gateway:loginlock:{scope}:{dim}:{identifier}  锁定标记,TTL=lockSeconds
 *
 * fail-open 行为:Redis 异常时放行,理由同 D.3(宁可短暂限不住也别误伤好人)。
 */

type LoginScope = 'user_login' | 'admin_login' | 'forgot_reset';
type LoginDimension = 'email' | 'ip';

interface DimensionConfig {
  maxFails: number;       // 触发锁定的失败次数
  failWindow: number;     // 失败计数器 TTL(秒)
  lockSeconds: number;    // 触发锁定后的锁定时长(秒)
}

interface ScopeConfig {
  email: DimensionConfig;
  ip: DimensionConfig;
}

const SCOPE_CONFIG: Record<LoginScope, ScopeConfig> = {
  user_login: {
    email: { maxFails: 5, failWindow: 300, lockSeconds: 300 },
    ip:    { maxFails: 20, failWindow: 300, lockSeconds: 600 },
  },
  admin_login: {
    email: { maxFails: 3, failWindow: 600, lockSeconds: 600 },
    ip:    { maxFails: 10, failWindow: 300, lockSeconds: 1800 },
  },
  forgot_reset: {
    email: { maxFails: 5, failWindow: 300, lockSeconds: 300 },
    ip:    { maxFails: 20, failWindow: 300, lockSeconds: 600 },
  },
};

/**
 * Lua 脚本:原子地执行"查锁 / 记失败 / 清锁"三种动作。
 * 返回 [locked(0|1), info]:
 *   - action='check'       → [locked, ttlRemaining]
 *   - action='record_fail' → [locked, locked?lockTtl : remainingFails]
 *   - action='reset'       → [0, 0]
 */
const loginAttemptScript = `
local lockKey = KEYS[1]
local failKey = KEYS[2]
local action = ARGV[1]

if action == 'check' then
  local ttl = redis.call('TTL', lockKey)
  if ttl > 0 then
    return {1, ttl}
  end
  return {0, 0}
end

if action == 'reset' then
  redis.call('DEL', lockKey)
  redis.call('DEL', failKey)
  return {0, 0}
end

if action == 'record_fail' then
  -- 已锁定的话直接告知,不再递增计数
  local ttl = redis.call('TTL', lockKey)
  if ttl > 0 then
    return {1, ttl}
  end

  local maxFails = tonumber(ARGV[2])
  local failWindow = tonumber(ARGV[3])
  local lockSeconds = tonumber(ARGV[4])

  local current = redis.call('INCR', failKey)
  if current == 1 then
    redis.call('EXPIRE', failKey, failWindow)
  end

  if current >= maxFails then
    redis.call('SET', lockKey, '1', 'EX', lockSeconds)
    redis.call('DEL', failKey)
    return {1, lockSeconds}
  end

  return {0, maxFails - current}
end

return {0, 0}
`;

export interface LoginAttemptResult {
  locked: boolean;
  /** 若 locked=true:锁还剩多少秒;若 locked=false 且来自 recordLoginFailure:还能错几次 */
  info: number;
  /** 哪个维度触发了锁(便于日志和提示文案区分,locked=false 时为 null) */
  lockedDimension: LoginDimension | null;
}

function failKey(scope: LoginScope, dim: LoginDimension, identifier: string): string {
  return `gateway:loginfail:${scope}:${dim}:${identifier}`;
}

function lockKey(scope: LoginScope, dim: LoginDimension, identifier: string): string {
  return `gateway:loginlock:${scope}:${dim}:${identifier}`;
}

/**
 * 从 FastifyRequest 提取真实客户端 IP。
 * 优先级:cf-connecting-ip (Cloudflare 标头) → x-forwarded-for 首段 → req.ip → 'unknown'
 * 即使 trustProxy 未开,这个函数也能拿到正确 IP。
 */
export function getClientIp(req: FastifyRequest): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return cf.trim();
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim();
  if (Array.isArray(xff) && xff.length > 0) return String(xff[0]).split(',')[0].trim();
  return req.ip || 'unknown';
}

/**
 * 进入登录路由前先 check:任一维度被锁则拦截。
 * fail-open:Redis 异常时返回 {locked:false} 放行。
 */
export async function checkLoginAttempt(
  scope: LoginScope,
  email: string,
  ip: string
): Promise<LoginAttemptResult> {
  try {
    const emailRes: any = await redis.eval(
      loginAttemptScript,
      2,
      lockKey(scope, 'email', email),
      failKey(scope, 'email', email),
      'check'
    );
    if (emailRes && emailRes[0] === 1) {
      return { locked: true, info: Number(emailRes[1]), lockedDimension: 'email' };
    }

    const ipRes: any = await redis.eval(
      loginAttemptScript,
      2,
      lockKey(scope, 'ip', ip),
      failKey(scope, 'ip', ip),
      'check'
    );
    if (ipRes && ipRes[0] === 1) {
      return { locked: true, info: Number(ipRes[1]), lockedDimension: 'ip' };
    }

    return { locked: false, info: 0, lockedDimension: null };
  } catch (err: any) {
    console.error('[GATEWAY][登录限流] check 异常(已放行):', err.message);
    return { locked: false, info: 0, lockedDimension: null };
  }
}

/**
 * 登录失败时调用:两个维度各自 +1,任一维度达上限即锁该维度。
 * 返回锁状态:若 locked=true,说明本次失败刚好触发了某维度的锁(或之前已锁)。
 * fail-open:Redis 异常时返回 {locked:false}。
 */
export async function recordLoginFailure(
  scope: LoginScope,
  email: string,
  ip: string
): Promise<LoginAttemptResult> {
  const cfg = SCOPE_CONFIG[scope];
  try {
    const emailRes: any = await redis.eval(
      loginAttemptScript,
      2,
      lockKey(scope, 'email', email),
      failKey(scope, 'email', email),
      'record_fail',
      String(cfg.email.maxFails),
      String(cfg.email.failWindow),
      String(cfg.email.lockSeconds)
    );

    const ipRes: any = await redis.eval(
      loginAttemptScript,
      2,
      lockKey(scope, 'ip', ip),
      failKey(scope, 'ip', ip),
      'record_fail',
      String(cfg.ip.maxFails),
      String(cfg.ip.failWindow),
      String(cfg.ip.lockSeconds)
    );

    // 优先报告 email 锁(更精准),其次 IP 锁
    if (emailRes && emailRes[0] === 1) {
      console.warn(`[GATEWAY][登录限流] ${scope} email 维度锁定: ${email}, 锁 ${emailRes[1]} 秒`);
      return { locked: true, info: Number(emailRes[1]), lockedDimension: 'email' };
    }
    if (ipRes && ipRes[0] === 1) {
      console.warn(`[GATEWAY][登录限流] ${scope} IP 维度锁定: ${ip}, 锁 ${ipRes[1]} 秒`);
      return { locked: true, info: Number(ipRes[1]), lockedDimension: 'ip' };
    }

    // 都未锁定,info 取较小剩余次数(给用户更紧迫的提示)
    const remainEmail = Number(emailRes ? emailRes[1] : cfg.email.maxFails);
    const remainIp = Number(ipRes ? ipRes[1] : cfg.ip.maxFails);
    return {
      locked: false,
      info: Math.min(remainEmail, remainIp),
      lockedDimension: null,
    };
  } catch (err: any) {
    console.error('[GATEWAY][登录限流] record_fail 异常(已放行):', err.message);
    return { locked: false, info: 0, lockedDimension: null };
  }
}

/**
 * 登录/找回密码成功时调用:仅清 email 维度的 fail + lock。
 * 不清 IP 维度——防止攻击者通过命中一个真账号给整个 IP 解套(本窗 v16 设计决策)。
 */
export async function resetLoginAttempts(
  scope: LoginScope,
  email: string
): Promise<void> {
  try {
    await redis.eval(
      loginAttemptScript,
      2,
      lockKey(scope, 'email', email),
      failKey(scope, 'email', email),
      'reset'
    );
  } catch (err: any) {
    console.error('[GATEWAY][登录限流] reset 异常:', err.message);
  }
}