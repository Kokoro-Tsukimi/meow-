import { FastifyRequest, FastifyReply } from 'fastify';
import { redis } from '../redis';
import { pool } from '../db';
// S1+(2026-06-23): RPM 限流配置 helper (进程内 cache, 启动时已加载)
import { getGlobalRpmLimit, getBlacklistRpmLimit } from '../services/systemSettings';

// Define custom properties on FastifyRequest
declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      token: string;
      token_id?: string;     // M3: Token主键id(老缓存可能没有,故可选)
      status: string;
      user_status?: string;  // S1+: Users 表 status(ACTIVE/BANNED/ARREARS/BLACKLIST)
      quota: string;
      ip_whitelist: string;
    };
  }
}

export async function authMiddleware(req: FastifyRequest, reply: FastifyReply) {
  // 第1步：从请求 Header 提取 Token
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    console.warn(`[GATEWAY][AUTH][缺失Token] IP: ${req.ip}`);
    return reply.status(401).send({ error: 'Missing or invalid Authorization header' });
  }

  const tokenString = authHeader.substring(7);

  // 第2步：查询 Redis 鉴权缓存
  const tokenKey = `gateway:token:info:${tokenString}`;
  let tokenInfo: Record<string, string> = await redis.hgetall(tokenKey);

  // C+.x: 缓存 miss → 回源 MySQL Tokens 表重建缓存(Redis 重启丢数据后自愈)
  // S1+(2026-06-23): JOIN Users 查 user_status, 用于 BANNED 拒 + BLACKLIST 走独立 RPM
  if (!tokenInfo || Object.keys(tokenInfo).length === 0) {
    const [rows]: any = await pool.query(
      `SELECT t.id, t.user_id, t.status, t.quota, t.ip_whitelist, u.status AS user_status
       FROM Tokens t
       JOIN Users u ON t.user_id = u.id
       WHERE t.token = ? LIMIT 1`,
      [tokenString]
    );
    if (rows.length > 0) {
      const t = rows[0];
      tokenInfo = {
        token_id: String(t.id),
        user_id: String(t.user_id),
        // DB 里是 ENABLE/DISABLE/EXPIRED,缓存里约定用 ACTIVE/DISABLED
        status: t.status === 'ENABLE' ? 'ACTIVE' : 'DISABLED',
        // S1+: Users.status 原值直接缓存(ACTIVE/BANNED/ARREARS/BLACKLIST)
        user_status: String(t.user_status),
        quota: String(t.quota),
        // JSON 列 mysql2 可能已解析成数组,统一转回字符串
        ip_whitelist: typeof t.ip_whitelist === 'string'
          ? t.ip_whitelist
          : JSON.stringify(t.ip_whitelist || []),
      };
      await redis.hset(tokenKey, tokenInfo);
      console.info(`[GATEWAY][AUTH][缓存回源] Token(id=${t.id}) 已从 MySQL 重建鉴权缓存(user_status=${t.user_status})`);
    }
  }

  if (!tokenInfo || Object.keys(tokenInfo).length === 0) {
    console.warn(`[GATEWAY][AUTH][Token不存在] Token: ${tokenString}`);
    return reply.status(401).send({ error: 'Invalid token' });
  }

  if (tokenInfo.status !== 'ACTIVE') {
    console.warn(`[GATEWAY][AUTH][Token已禁用] Token: ${tokenString}, Status: ${tokenInfo.status}`);
    return reply.status(403).send({ error: 'Token is disabled' });
  }

  // S1+(2026-06-23): 用户级状态校验
  //   - BANNED:    数据面拒绝(违规账号, 拒之门外)
  //   - BLACKLIST: 允许通过, 但下面走独立的更严 RPM 限流
  //   - ARREARS:   【收尾窗升级】欠费且余额未回正 → 拦(判决在第4步余额检查处, 带指名欠费文案);
  //                欠费但余额已回正(充值后标签未摘) → 放行, 避免"充了钱还进不了店"的充值黑洞。
  //                状态标签的摘除留给店长手动 / 将来的 arrears 队列异步消费者。
  //   - ACTIVE:    允许通过, 走全站 RPM 限流
  //   user_status 可能是 undefined(老缓存没存这个字段) → 容忍, 不当 BANNED 处理(下次 miss 回源会补)
  const userStatus = tokenInfo.user_status;
  if (userStatus === 'BANNED') {
    console.warn(`[GATEWAY][AUTH][账号已封禁] UserID: ${tokenInfo.user_id}, Token: ${tokenString}`);
    return reply.status(403).send({ error: 'Account is banned' });
  }

  // S1+(2026-06-23): RPM 限流 (User 维度, 防多 token 绕过)
  //   - 固定窗口实现: INCR + EXPIRE 60s, 首次 INCR 返回 1 时设置 TTL
  //   - BLACKLIST 用户走独立(更严)的阈值, 其他用户走全站默认阈值
  //   - fail-open: Redis 异常时放行(自愈优于误伤, 余额仍会自然拦)
  try {
    const isBlacklist = userStatus === 'BLACKLIST';
    const rpmLimit = isBlacklist ? getBlacklistRpmLimit() : getGlobalRpmLimit();
    const rpmKey = `gateway:rpm:user:${tokenInfo.user_id}`;
    const count = await redis.incr(rpmKey);
    if (count === 1) {
      // 首次写入, 设置 60s 滚动过期窗口
      await redis.expire(rpmKey, 60);
    }
    if (count > rpmLimit) {
      const ttl = await redis.ttl(rpmKey);
      console.warn(`[GATEWAY][AUTH][RPM超额] UserID: ${tokenInfo.user_id}, Status: ${userStatus || 'ACTIVE'}, ${count}/${rpmLimit}, TTL: ${ttl}s`);
      return reply
        .status(429)
        .header('Retry-After', String(Math.max(ttl, 1)))
        .send({
          error: 'Too Many Requests',
          message: isBlacklist
            ? `账号被拉黑, 每分钟最多 ${rpmLimit} 次喵`
            : `每分钟最多 ${rpmLimit} 次喵, ${ttl}s 后再试`
        });
    }
  } catch (err) {
    console.error(`[GATEWAY][AUTH][RPM限流异常,放行]`, err);
    // fail-open: 限流异常不拦请求, 由下游兜底
  }

  // 第3步：IP 白名单校验
  if (tokenInfo.ip_whitelist) {
    try {
      const whitelist: string[] = JSON.parse(tokenInfo.ip_whitelist);
      if (whitelist.length > 0 && !whitelist.includes(req.ip)) {
        console.warn(`[GATEWAY][AUTH][IP不在白名单] IP: ${req.ip}, Whitelist: ${tokenInfo.ip_whitelist}`);
        return reply.status(403).send({ error: 'IP not in whitelist' });
      }
    } catch (err) {
      console.error(`[GATEWAY][AUTH][白名单解析错误]`, err);
    }
  }

  // 第4步：余额检查(C+.x: key 不存在时先从 MySQL Users 表预热,再判断)
  // 之前的写法:key 不存在直接当 0 → Redis 重启后所有人误报 402。
  // 现在:null(key不存在) 和 0(真没钱) 是两回事,前者回源预热,后者才拦。
  // C窗后续加固(2026-07-01): 触发回源的条件从"仅 null"扩展到"null 或 非整数脏值"。
  //   历史遗留脏值(旧版回源把 DECIMAL 的 "xxx.00000" 原样 SET 进来)会让 parseInt 截断出错值,
  //   且原逻辑因 key 存在而永不回源、脏值永久卡住。现在非整数格式也触发 DEL+回源自愈。
  const balanceKey = `gateway:user:balance:${tokenInfo.user_id}`;
  let balanceStr = await redis.get(balanceKey);

  // null(不存在) 或 非纯整数字符串(脏值) 都要回源重建
  if (balanceStr === null || !/^-?\d+$/.test(balanceStr)) {
    if (balanceStr !== null) {
      console.warn(`[GATEWAY][AUTH][余额脏值自愈] UserID: ${tokenInfo.user_id}, 缓存值 "${balanceStr}" 非整数, 已清理并回源`);
    }
    const [urows]: any = await pool.query(
      'SELECT balance FROM Users WHERE id = ?',
      [tokenInfo.user_id]
    );
    const dbBalance = urows.length > 0 ? Math.round(Number(urows[0].balance)) : 0;
    await redis.set(balanceKey, dbBalance);
    balanceStr = String(dbBalance);
    console.info(`[GATEWAY][AUTH][余额回源] UserID: ${tokenInfo.user_id} 已从 MySQL 预热余额: ${dbBalance}`);
  }

  const balance = parseInt(balanceStr, 10);

  if (balance <= 0) {
    // 【收尾窗】ARREARS 拦截判决点: 欠费标签 + 余额未回正 → 指名道姓的欠费文案;
    // 无标签的普通穷猫 → 保持原通用文案。两者都是 402, 前端拦截器语义不变。
    if (tokenInfo.user_status === 'ARREARS') {
      console.warn(`[GATEWAY][AUTH][欠费拦截] UserID: ${tokenInfo.user_id}, Balance: ${balance}, Status: ARREARS`);
      return reply.status(402).send({ error: 'Account in arrears', message: '账号欠费中, 请充值回正后再使用喵' });
    }
    console.warn(`[GATEWAY][AUTH][余额不足] UserID: ${tokenInfo.user_id}, Balance: ${balance}`);
    return reply.status(402).send({ error: 'Insufficient balance' });
  }

  // 第5步：将 user_id 和 token 信息挂载到 request 对象上
  req.user = {
    id: tokenInfo.user_id,
    token: tokenString,
    token_id: tokenInfo.token_id,        // M3: 老缓存里没有此字段时为 undefined,下游需容忍
    status: tokenInfo.status,
    user_status: tokenInfo.user_status,  // S1+: 用户级状态(ACTIVE/BANNED/ARREARS/BLACKLIST), 老缓存可能为 undefined
    quota: tokenInfo.quota,
    ip_whitelist: tokenInfo.ip_whitelist
  };
}
