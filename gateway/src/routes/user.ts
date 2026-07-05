import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../db';
import { redis } from '../redis';
import { purgeUser } from '../services/userPurge';
import { isDebugCacheEnabled, isCheckinEnabled, getCheckinRewardAmount } from '../services/systemSettings';
import { readShelfItem, removeShelfItem, getShelfUsage } from '../services/debugCache';

// ============ 工具函数 ============

/**
 * 生成新Token: sk-meow-{32位随机}
 */
function generateToken(): string {
  const random = crypto.randomBytes(24).toString('base64url');
  return `sk-meow-${random}`;
}

/**
 * 掩码Token: sk-meow-abcd...wxyz (前11后4)
 */
function maskToken(token: string): string {
  if (!token || token.length < 16) return token;
  return token.slice(0, 11) + '...' + token.slice(-4);
}

/**
 * 分页参数清洗(T-1 上限治理):防注入 + clamp 上下限
 * 默认 20 条/页, 硬上限 100 条/页, page 上限 10000(防 Infinity / 负数)
 * 返回值已是 Number, 可直接放进 SQL 占位符
 */
function parsePagination(query: any, maxLimit: number = 100, defaultLimit: number = 20) {
  let page = parseInt(String(query?.page ?? '1'), 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  if (page > 10000) page = 10000;

  let limit = parseInt(String(query?.limit ?? defaultLimit), 10);
  if (!Number.isFinite(limit) || limit < 1) limit = defaultLimit;
  if (limit > maxLimit) limit = maxLimit;

  const offset = (page - 1) * limit;
  return { page, limit, offset };
}

/**
 * 将Token信息同步写入Redis (鉴权用)
 */
async function syncTokenToRedis(token: string, info: {
  token_id: number | string;   // M3: Token主键id,用于Worker更新used_quota
  user_id: number | string;
  status: string;
  quota: number | string;
  ip_whitelist: string;
}) {
  const key = `gateway:token:info:${token}`;
  await redis.hset(key, {
    token_id: String(info.token_id),
    user_id: String(info.user_id),
    status: info.status,
    quota: String(info.quota),
    ip_whitelist: info.ip_whitelist || '[]',
  });
}

// ============ 路由 ============

export default async function userRoutes(fastify: FastifyInstance) {

  // GET /info - 用户基本信息
  fastify.get('/info', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    try {
      console.info(`[USER][查询信息] userId: ${userId}`);

      let balanceStr = await redis.get(`gateway:user:balance:${userId}`);
      let balance = balanceStr ? parseInt(balanceStr, 10) : null;

      const [rows]: any = await pool.query('SELECT id, email, balance, status, created_at FROM Users WHERE id = ?', [userId]);
      if (rows.length === 0) {
        return reply.status(404).send({ message: '用户不存在' });
      }

      const user = rows[0];
      if (balance === null) {
        balance = user.balance;
        await redis.set(`gateway:user:balance:${userId}`, balance!);
      }

      return reply.send({
        id: user.id,
        email: user.email,
        balance: (balance as number) / 100000,
        status: user.status,
        created_at: user.created_at
      });
    } catch (error) {
      console.error('[USER][查询信息] 发生错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // GET /profile - 客人餐桌(H-1):邮箱 / 余额 / 加入日期 / 注册方式
  // 注册方式推断:查首条 Bills(注册当下的入账或第一次充值都算)
  //   - 无任何 Bills → EMAIL(邮箱验证码注册 或 店长亲手登记自用账号)
  //   - 首条 ref 以 'admin_topup_' 开头 → ADMIN(店长亲手送豆接待)
  //   - 其他 → CDK(邀请码注册时事务内入账, ref 是 CDK 本身)
  //
  // 已知误判:邮箱注册者被店长后续手动送豆会被推断成 ADMIN(可接受 - 语义上"店长亲手接待过"也成立)
  fastify.get('/profile', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    try {
      console.info(`[USER][客人餐桌] userId: ${userId}`);

      const [userRows]: any = await pool.query(
        'SELECT email, balance, created_at FROM Users WHERE id = ?',
        [userId]
      );
      if (userRows.length === 0) {
        return reply.status(404).send({ message: '账号不存在喵' });
      }

      // 余额优先读 Redis, 没有再用 MySQL(同 /info 风格)
      const balanceStr = await redis.get(`gateway:user:balance:${userId}`);
      const balance = balanceStr !== null ? parseInt(balanceStr, 10) : userRows[0].balance;

      // 推断注册方式
      const [billRows]: any = await pool.query(
        'SELECT reference_id FROM Bills WHERE user_id = ? ORDER BY created_at ASC, id ASC LIMIT 1',
        [userId]
      );
      let registerSource: 'EMAIL' | 'CDK' | 'ADMIN' = 'EMAIL';
      if (billRows.length > 0) {
        const ref = String(billRows[0].reference_id || '');
        registerSource = ref.startsWith('admin_topup_') ? 'ADMIN' : 'CDK';
      }

      return reply.send({
        email: userRows[0].email,
        balance: (balance as number) / 100000,
        created_at: userRows[0].created_at,
        register_source: registerSource
      });
    } catch (error) {
      console.error('[USER][客人餐桌] 发生错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // GET /bills - 账单流水
  fastify.get('/bills', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    const { startDate, endDate } = req.query as {
      startDate?: string; endDate?: string
    };
    // T-1: 分页参数清洗(防注入 + clamp 上下限),limit 硬上限 100 防 limit=99999 拖垮 MySQL
    const { page, limit, offset } = parsePagination(req.query);

    // 日期筛选: 正则校验 YYYY-MM-DD, 非法格式静默忽略 (fail-soft)。
    // 用参数化查询 (?) 防注入; 用 >= / <= 而非 BETWEEN, 反向输入(start>end)自然返回空不报错。
    // 时区: MySQL 容器为 +08:00, created_at 与用户所选日期同处东八区语境, 直接比较无误。
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    let whereClause = 'WHERE user_id = ?';
    const whereParams: any[] = [userId];
    if (typeof startDate === 'string' && dateRe.test(startDate)) {
      whereClause += ' AND created_at >= ?';
      whereParams.push(`${startDate} 00:00:00`);
    }
    if (typeof endDate === 'string' && dateRe.test(endDate)) {
      whereClause += ' AND created_at <= ?';
      whereParams.push(`${endDate} 23:59:59`);
    }

    try {
      console.info(`[USER][查询账单] userId: ${userId}, page: ${page}, startDate: ${startDate || '-'}, endDate: ${endDate || '-'}`);

      const [countResult]: any = await pool.query(
        `SELECT COUNT(*) as total FROM Bills ${whereClause}`,
        whereParams
      );
      const total = countResult[0].total;

      const [items]: any = await pool.query(
        `SELECT id, type, amount, model, reference_id, created_at FROM Bills ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...whereParams, limit, offset]
      );

      return reply.send({
        items: items.map((i: any) => ({
          ...i,
          amount: i.amount / 100000
        })),
        total,
        page
      });
    } catch (error) {
      console.error('[USER][查询账单] 发生错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // POST /topup/redeem - 兑换CDK
  fastify.post('/topup/redeem', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    const { code } = req.body as { code: string };
    if (!code) return reply.status(400).send({ message: '兑换码不能为空' });

    const lockKey = `gateway:lock:cdk:${code}`;
    
    try {
      const lock = await redis.set(lockKey, '1', 'EX', 10, 'NX');
      if (!lock) {
        return reply.status(400).send({ message: '正在处理中，请稍后再试' });
      }

      const [codeRows]: any = await pool.query('SELECT id, amount FROM RedeemCodes WHERE code = ? AND status = "UNUSED"', [code]);
      if (codeRows.length === 0) {
        await redis.del(lockKey);
        return reply.status(404).send({ message: '兑换码无效或已被使用' });
      }

      const { amount } = codeRows[0];
      const connection = await pool.getConnection();

      try {
        await connection.beginTransaction();

        const [updateCodeRes]: any = await connection.query(
          'UPDATE RedeemCodes SET status = "USED", used_by = ?, used_at = NOW() WHERE code = ? AND status = "UNUSED"',
          [userId, code]
        );

        if (updateCodeRes.affectedRows === 0) {
          await connection.rollback();
          await redis.del(lockKey);
          return reply.status(400).send({ message: '兑换码已被使用' });
        }

        await connection.query('UPDATE Users SET balance = balance + ? WHERE id = ?', [amount, userId]);
        await connection.query(
          'INSERT INTO Bills (user_id, type, amount, reference_id, model) VALUES (?, ?, ?, ?, ?)',
          [userId, 'TOPUP', amount, code, 'system']
        );

        await connection.commit();
      } catch (txError) {
        await connection.rollback();
        throw txError;
      } finally {
        connection.release();
      }

      const amountInt = Math.round(Number(amount));
      const currentBalanceStr = await redis.get(`gateway:user:balance:${userId}`);
      let newBalance = 0;
      if (currentBalanceStr !== null) {
        newBalance = await redis.incrby(`gateway:user:balance:${userId}`, amountInt);
      } else {
        const [userRows]: any = await pool.query('SELECT balance FROM Users WHERE id = ?', [userId]);
        newBalance = Math.round(Number(userRows[0].balance));
        await redis.set(`gateway:user:balance:${userId}`, newBalance);
      }

      await redis.del(lockKey);

      console.info(`[USER][兑换CDK] userId: ${userId}, code: ${code}, amount: ${amount}`);
      return reply.send({ 
        message: '投喂成功！咖啡豆已到账~',
        balance: newBalance / 100000
      });
    } catch (error) {
      console.error('[USER][兑换CDK] 发生错误:', error);
      await redis.del(lockKey);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // POST /checkin - 每日签到领咖啡豆(F6)
  //   守门: 总闸关→403 / BLACKLIST·BANNED→403(拉黑不能领福利, BANNED 已被 jwtAuth 拦在更外层) / 今天已签→409
  //   入账: 照 CDK 兑换同款"事务内 UPDATE balance + INSERT Bills(TOPUP)", 金额 ×100000 存
  //   幂等: CheckIns 的 UNIQUE(user_id, check_date) + Bills 的 UNIQUE(reference_id) 双闸防重复领
  //   时区: check_date 取东八区当天(确定性, 不依赖容器时区), 与 reference_id 共用同一字符串防午夜错位
  fastify.post('/checkin', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    if (!isCheckinEnabled()) {
      return reply.status(403).send({ message: '签到功能暂时关闭了喵~' });
    }

    // 东八区当天日期 YYYY-MM-DD(check_date 与 reference_id 共用)
    const checkDate = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const lockKey = `gateway:lock:checkin:${userId}`;

    try {
      const lock = await redis.set(lockKey, '1', 'EX', 10, 'NX');
      if (!lock) {
        return reply.status(429).send({ message: '正在处理中, 请稍后再试喵' });
      }

      // 状态守门: BLACKLIST / BANNED 不能领福利(ARREARS / ACTIVE 允许)
      const [userRows]: any = await pool.query('SELECT status FROM Users WHERE id = ?', [userId]);
      if (userRows.length === 0) {
        await redis.del(lockKey);
        return reply.status(404).send({ message: '用户不存在' });
      }
      const status = userRows[0].status;
      if (status === 'BLACKLIST' || status === 'BANNED') {
        await redis.del(lockKey);
        return reply.status(403).send({ message: '当前账号状态无法领取签到福利喵' });
      }

      // 奖励豆数(人类可读)→ ×100000 放大整数(与 balance / Bills.amount 规约一致)
      const rewardBeans = getCheckinRewardAmount();
      const rewardScaled = Math.round(rewardBeans * 100000);
      const referenceId = `checkin_${userId}_${checkDate}`;

      const connection = await pool.getConnection();
      let dupHit = false;
      try {
        await connection.beginTransaction();
        // 1. 写签到记录(今天已签会撞 UNIQUE(user_id, check_date) → ER_DUP_ENTRY)
        await connection.query(
          'INSERT INTO CheckIns (user_id, check_date, reward_amount) VALUES (?, ?, ?)',
          [userId, checkDate, rewardScaled]
        );
        // 2. 加豆
        await connection.query('UPDATE Users SET balance = balance + ? WHERE id = ?', [rewardScaled, userId]);
        // 3. 记流水(TOPUP; reference_id 幂等第二道闸)
        await connection.query(
          'INSERT INTO Bills (user_id, type, amount, reference_id, model) VALUES (?, ?, ?, ?, ?)',
          [userId, 'TOPUP', rewardScaled, referenceId, 'daily_checkin']
        );
        await connection.commit();
      } catch (txError: any) {
        await connection.rollback();
        if (txError?.code === 'ER_DUP_ENTRY') {
          dupHit = true;  // 今天已签到(CheckIns 或 Bills 唯一键撞了)
        } else {
          throw txError;
        }
      } finally {
        connection.release();
      }

      if (dupHit) {
        await redis.del(lockKey);
        return reply.status(409).send({ message: '今天已经签到过了喵~明天再来~' });
      }

      // 4. Redis 余额同步(与 CDK 兑换完全一致: 存在 INCRBY, 不存在回源 SET)
      const currentBalanceStr = await redis.get(`gateway:user:balance:${userId}`);
      let newBalance = 0;
      if (currentBalanceStr !== null) {
        newBalance = await redis.incrby(`gateway:user:balance:${userId}`, rewardScaled);
      } else {
        const [balRows]: any = await pool.query('SELECT balance FROM Users WHERE id = ?', [userId]);
        newBalance = Math.round(Number(balRows[0].balance));
        await redis.set(`gateway:user:balance:${userId}`, newBalance);
      }

      await redis.del(lockKey);

      console.info(`[USER][签到] userId: ${userId}, date: ${checkDate}, reward: ${rewardBeans} 豆`);
      return reply.send({
        message: `签到成功! 领到 ${rewardBeans} 颗咖啡豆喵~`,
        reward: rewardBeans,
        balance: newBalance / 100000,
        checked_in: true,
      });
    } catch (error) {
      console.error('[USER][签到] 发生错误:', error);
      await redis.del(lockKey);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // GET /checkin/status - 今天签到了吗 + 当前奖励豆数 + 总闸状态(给前端按钮用)
  fastify.get('/checkin/status', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    const checkDate = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);

    try {
      const [rows]: any = await pool.query(
        'SELECT id FROM CheckIns WHERE user_id = ? AND check_date = ? LIMIT 1',
        [userId, checkDate]
      );
      return reply.send({
        checked_in: rows.length > 0,
        enabled: isCheckinEnabled(),
        reward: getCheckinRewardAmount(),
        date: checkDate,
      });
    } catch (error) {
      console.error('[USER][签到状态] 错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // GET /announcements - 公告栏(F7):只返回上架(ENABLE)的最新 3 条
  fastify.get('/announcements', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    try {
      const [rows]: any = await pool.query(
        `SELECT id, title, content, created_at, updated_at
         FROM Announcements
         WHERE status = 'ENABLE'
         ORDER BY created_at DESC
         LIMIT 3`
      );
      return reply.send({ items: rows });
    } catch (error) {
      console.error('[USER][公告] 错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // GET /announcements/history - 公告历史(G-4):分页返回全部上架公告
  // 复用 T-1 的 parsePagination(默认 10 条/页, 硬上限 50), 附带 total 供前端算总页数
  fastify.get('/announcements/history', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    try {
      const { page, limit, offset } = parsePagination(req.query, 50, 10);

      const [countRows]: any = await pool.query(
        `SELECT COUNT(*) AS total FROM Announcements WHERE status = 'ENABLE'`
      );
      const total = Number(countRows?.[0]?.total || 0);

      const [rows]: any = await pool.query(
        `SELECT id, title, content, created_at, updated_at
         FROM Announcements
         WHERE status = 'ENABLE'
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [limit, offset]
      );

      console.info(`[USER][公告历史] userId: ${userId}, page: ${page}, 共 ${total} 条`);
      return reply.send({ items: rows, page, limit, total });
    } catch (error) {
      console.error('[USER][公告历史] 错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // ============ Tokens CRUD (女仆召唤铃管理) ============

  // GET /tokens - 列出"我的"Token (返回掩码)
  fastify.get('/tokens', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    try {
      const [rows]: any = await pool.query(
        'SELECT id, name, token, quota, used_quota, status, ip_whitelist, created_at FROM Tokens WHERE user_id = ? ORDER BY id DESC LIMIT 200',
        [userId]
      );

      console.info(`[USER][Token列表] userId: ${userId}, 共 ${rows.length} 个`);
      return reply.send({
        items: rows.map((t: any) => ({
          id: t.id,
          name: t.name,
          token_mask: maskToken(t.token),
          quota: Number(t.quota) / 100000,
          used_quota: Number(t.used_quota) / 100000,
          status: t.status,
          ip_whitelist: t.ip_whitelist,
          created_at: t.created_at,
        }))
      });
    } catch (error) {
      console.error('[USER][Token列表] 错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // POST /tokens - 创建新Token (⭐唯一返回明文的时机)
  fastify.post('/tokens', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    const { name, quota, ip_whitelist } = req.body as { name?: string; quota?: number; ip_whitelist?: string[] };
    
    if (!name || !name.trim()) {
      return reply.status(400).send({ message: '请填写Token名称' });
    }

    // 生成Token + 内部金额放大
    const token = generateToken();
    const quotaInt = quota === -1 || quota === undefined ? -1 : Math.round(Number(quota) * 100000);
    const whitelistJson = Array.isArray(ip_whitelist) && ip_whitelist.length > 0 
      ? JSON.stringify(ip_whitelist) 
      : '[]';

    try {
      const [result]: any = await pool.query(
        'INSERT INTO Tokens (user_id, name, token, quota, used_quota, status, ip_whitelist) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [userId, name.trim(), token, quotaInt, 0, 'ENABLE', whitelistJson]
      );

      // ⭐ 关键: 同步写入Redis鉴权缓存
      await syncTokenToRedis(token, {
        token_id: result.insertId,  // M3
        user_id: userId,
        status: 'ACTIVE',  // 注意Redis里用ACTIVE,见 middleware/auth.ts
        quota: quotaInt,
        ip_whitelist: whitelistJson,
      });

      console.info(`[USER][Token创建] userId: ${userId}, name: ${name}, id: ${result.insertId}`);
      return reply.send({
        id: result.insertId,
        token,  // ⭐ 只在创建时返回明文一次
        name: name.trim(),
        quota: quotaInt === -1 ? -1 : quotaInt / 100000,
        message: '召唤铃打造成功喵~ 请妥善保存,只显示这一次!',
      });
    } catch (error) {
      console.error('[USER][Token创建] 错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // PUT /tokens/:id - 修改Token (改名/IP白名单/状态/额度)
  fastify.put('/tokens/:id', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    const { id } = req.params as { id: string };
    const { name, quota, ip_whitelist, status } = req.body as { 
      name?: string; quota?: number; ip_whitelist?: string[]; status?: string 
    };

    try {
      // 1. 校验Token归属
      const [rows]: any = await pool.query(
        'SELECT id, token FROM Tokens WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      if (rows.length === 0) {
        return reply.status(404).send({ message: 'Token不存在或非你所有' });
      }
      const tokenString = rows[0].token;

      // 2. 拼装SQL
      const updates: string[] = [];
      const params: any[] = [];

      if (name !== undefined) {
        updates.push('name = ?');
        params.push(name.trim());
      }
      if (quota !== undefined) {
        updates.push('quota = ?');
        params.push(quota === -1 ? -1 : Math.round(Number(quota) * 100000));
      }
      if (ip_whitelist !== undefined) {
        const whitelistJson = Array.isArray(ip_whitelist) && ip_whitelist.length > 0 
          ? JSON.stringify(ip_whitelist) : '[]';
        updates.push('ip_whitelist = ?');
        params.push(whitelistJson);
      }
      if (status !== undefined) {
        // #小3 技术债销账: 非法枚举值显式 400
        // (以前是静默忽略: 单发非法值会误报"没有要更新的字段", 混发时被悄悄丢弃)
        if (!['ENABLE', 'DISABLE'].includes(status)) {
          return reply.status(400).send({ message: 'status 只能是 ENABLE 或 DISABLE' });
        }
        updates.push('status = ?');
        params.push(status);
      }

      if (updates.length === 0) {
        return reply.status(400).send({ message: '没有要更新的字段' });
      }

      params.push(id);
      await pool.query(`UPDATE Tokens SET ${updates.join(', ')} WHERE id = ?`, params);

      // 3. ⭐ 同步更新Redis缓存
      const [newRows]: any = await pool.query(
        'SELECT quota, status, ip_whitelist FROM Tokens WHERE id = ?', [id]
      );
      const fresh = newRows[0];
      await syncTokenToRedis(tokenString, {
        token_id: id,  // M3
        user_id: userId,
        status: fresh.status === 'ENABLE' ? 'ACTIVE' : 'DISABLED',
        quota: fresh.quota,
        ip_whitelist: fresh.ip_whitelist || '[]',
      });

      console.info(`[USER][Token修改] userId: ${userId}, tokenId: ${id}`);
      return reply.send({ message: '修改成功喵~' });
    } catch (error) {
      console.error('[USER][Token修改] 错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // DELETE /tokens/:id - 删除Token (同步清Redis)
  fastify.delete('/tokens/:id', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    const { id } = req.params as { id: string };

    try {
      const [rows]: any = await pool.query(
        'SELECT token FROM Tokens WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      if (rows.length === 0) {
        return reply.status(404).send({ message: 'Token不存在或非你所有' });
      }
      const tokenString = rows[0].token;

      await pool.query('DELETE FROM Tokens WHERE id = ?', [id]);

      // ⭐ 清除Redis缓存
      await redis.del(`gateway:token:info:${tokenString}`);

      console.info(`[USER][Token删除] userId: ${userId}, tokenId: ${id}`);
      return reply.send({ message: '召唤铃已销毁喵~' });
    } catch (error) {
      console.error('[USER][Token删除] 错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // ============ F.1.6 模型广场 (我能看到/调用的菜单 + 价格) ============
  // 思想: 与 proxy.ts 的 GET /v1/models 判定保持一致, 确保
  //   "用户端模型广场看到什么 ↔ SillyTavern (sk-meow) 实际能调用什么" 语义闭环。
  // 注: 此处只看 ModelGroupChannels.status='ENABLE',不验 Channels.status='ENABLE'。
  //   这是有意对齐 proxy.ts loadModelGroups 的判定 (单层 ENABLE)。
  //   假如未来想要更严格的"看见=能调通",应统一修改 proxy.ts 的 loadModelGroups,
  //   而非在此处单独加双层判定 (避免漂移)。已登记到交接书技术债清单备查。

  // GET /models - 当前 user 可见的菜单列表 (含价, 豆/百万 tokens)
  fastify.get('/models', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    try {
      const [rows]: any = await pool.query(`
        SELECT 
          g.id, g.name, g.description, 
          g.prompt_price, g.completion_price,
          g.access_mode, g.created_at
        FROM ModelGroups g
        WHERE g.status = 'ENABLE'
          AND EXISTS (
            SELECT 1 FROM ModelGroupChannels mgc
            WHERE mgc.group_id = g.id 
              AND mgc.status = 'ENABLE'
          )
          AND (
            g.access_mode = 'PUBLIC'
            OR EXISTS (
              SELECT 1 FROM ModelGroupGrants mg 
              WHERE mg.group_id = g.id AND mg.user_id = ?
            )
          )
        ORDER BY g.id DESC
        LIMIT 500
      `, [userId]);

      const items = rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        description: r.description,                            // 可能为 null, 前端做空判
        access_mode: r.access_mode,                            // 'PUBLIC' | 'WHITELIST'
        prompt_price: Number(r.prompt_price) / 100000,         // 豆/百万, 已还原
        completion_price: Number(r.completion_price) / 100000, // 豆/百万, 已还原
        created_at: r.created_at,
      }));

      console.info(`[USER][模型广场] userId: ${userId}, 可见菜单 ${items.length} 个: ${items.map((i: any) => i.name).join(', ') || '(空)'}`);
      return reply.send({ items });
    } catch (error) {
      console.error('[USER][模型广场] 发生错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // ============ F.1.7 自助注销账号 (销账留账本) ============
  // 路线 A: 删 Users 行 + 名下 Tokens + 名下分组授权 + Redis 缓存; Bills/Logs 留底。
  // 二次确认: 必须在 body 里带原密码, bcrypt.compare 通过才执行,
  //   防误操作 + 防 JWT 被盗后一键销户喵。
  // 销账动作本身在 services/userPurge.ts, 本接口只管 "验密码 + 调 helper + 回执"。

  // DELETE /account - 用户自助注销
  fastify.delete('/account', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    const { password } = req.body as { password?: string };
    if (!password) {
      return reply.status(400).send({ message: '请输入密码确认注销喵' });
    }

    try {
      // 1. 校验密码 (顺手验证用户还在, 虽然 JWT 已暗示)
      const [rows]: any = await pool.query(
        'SELECT password_hash FROM Users WHERE id = ?',
        [userId]
      );
      if (rows.length === 0) {
        return reply.status(404).send({ message: '账号不存在喵' });
      }
      const isMatch = await bcrypt.compare(password, rows[0].password_hash);
      if (!isMatch) {
        console.warn(`[USER][注销] 密码错误: userId ${userId}`);
        return reply.status(403).send({ message: '密码错误喵' });
      }

      // 2. 销账 (事务 + Redis 清理一条龙, 详见 services/userPurge.ts)
      const result = await purgeUser(userId);
      console.info(`[USER][注销] 自助注销成功: userId ${userId}, 顺手销毁 ${result.deletedTokens} 把召唤铃 + ${result.deletedGrants} 条授权`);

      return reply.send({ success: true });
    } catch (error: any) {
      // purgeUser 抛 USER_NOT_FOUND:xxx 的极端情况 (并发删了两次)
      if (error?.message?.startsWith('USER_NOT_FOUND:')) {
        return reply.status(404).send({ message: '账号不存在喵' });
      }
      console.error('[USER][注销] 发生错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // POST /change-password - 改秘密咒语(H-1)
  // 宽松流程:旧密码对了 + 新密码 ≥4 位即可(不强制复杂度, 与找回密码同源)
  // 密码错返 403 不返 401(避免 axios 拦截器把人踢出登录, 与 /account 同款规避)
  fastify.post('/change-password', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    const { old_password, new_password } = req.body as { old_password?: string; new_password?: string };
    if (!old_password || !new_password) {
      return reply.status(400).send({ message: '请填写原密码和新密码喵' });
    }
    if (String(new_password).length < 4) {
      return reply.status(400).send({ message: '新密码至少 4 位喵' });
    }

    try {
      const [rows]: any = await pool.query(
        'SELECT password_hash FROM Users WHERE id = ?',
        [userId]
      );
      if (rows.length === 0) {
        return reply.status(404).send({ message: '账号不存在喵' });
      }

      const isMatch = await bcrypt.compare(String(old_password), rows[0].password_hash);
      if (!isMatch) {
        console.warn(`[USER][改密] 原密码错误: userId ${userId}`);
        return reply.status(403).send({ message: '原密码错误喵' });
      }

      // bcrypt salt rounds = 10, 与注册/通道A/找回密码同源
      const passwordHash = await bcrypt.hash(String(new_password), 10);
      await pool.query('UPDATE Users SET password_hash = ? WHERE id = ?', [passwordHash, userId]);

      console.info(`[USER][改密] 成功: userId ${userId}`);
      return reply.send({ success: true, message: '密码已更新喵~ 下次记得用新的进店~' });
    } catch (error) {
      console.error('[USER][改密] 发生错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // ============ F.5 诊断模式 + 货架(中转站短期保管响应原文) ============
  // 三角责任(详见交接书): user 决定开关 + 缓存时长, admin 决定总闸 + 每用户上限, 系统按 FIFO 自动淘汰
  // 决策 C 不对称: admin 总闸 OFF 时, user 仍能 "查 / 关停 / 读历史货架", 但不能 "开启" (返 403)

  // GET /debug-mode/status - 查诊断模式当前状态 + 货架占用 + admin 总闸状态
  fastify.get('/debug-mode/status', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    try {
      const [rows]: any = await pool.query(
        'SELECT debug_mode_enabled, debug_mode_ttl_minutes, debug_mode_expires_at FROM Users WHERE id = ?',
        [userId]
      );
      if (rows.length === 0) {
        return reply.status(404).send({ message: '用户不存在' });
      }
      const u = rows[0];

      // 货架占用(走 debugCache 抽样估算, 极快)
      const usage = await getShelfUsage(Number(userId));

      return reply.send({
        enabled: !!u.debug_mode_enabled,
        ttl_minutes: u.debug_mode_ttl_minutes,
        expires_at: u.debug_mode_expires_at,
        admin_enabled: isDebugCacheEnabled(),  // 给前端用来 disable "开启" 按钮 + 显示提示
        shelf_usage: usage,
      });
    } catch (error) {
      console.error('[USER][诊断模式状态] 错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // PATCH /debug-mode - 开启/关闭诊断模式 + 设 TTL
  //   入参: { enabled: boolean, ttl_minutes?: number } (ttl_minutes 仅 enabled=true 时生效, 范围 10-120)
  fastify.patch('/debug-mode', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    const { enabled, ttl_minutes } = req.body as { enabled?: boolean; ttl_minutes?: number };
    if (typeof enabled !== 'boolean') {
      return reply.status(400).send({ message: 'enabled 必须是 true 或 false 喵' });
    }

    try {
      if (enabled) {
        // 决策 C: admin 总闸 OFF 时不许开启(关闭/查询不受此限)
        if (!isDebugCacheEnabled()) {
          return reply.status(403).send({ message: '管理员已关闭诊断功能, 暂时无法开启喵' });
        }

        // 校验 TTL 范围
        const ttl = Number(ttl_minutes);
        if (!Number.isFinite(ttl) || ttl < 10 || ttl > 120) {
          return reply.status(400).send({ message: 'ttl_minutes 必须是 10-120 之间的整数喵' });
        }

        // 算 expires_at = 当下 + ttl 分钟(整窗口期内的所有 entry 共享这个到期时刻)
        const expiresAt = new Date(Date.now() + ttl * 60 * 1000);

        await pool.query(
          'UPDATE Users SET debug_mode_enabled = 1, debug_mode_ttl_minutes = ?, debug_mode_expires_at = ? WHERE id = ?',
          [ttl, expiresAt, userId]
        );

        console.info(`[USER][诊断模式] userId: ${userId} 开启 ${ttl} 分钟, 到期: ${expiresAt.toISOString()}`);
        return reply.send({
          message: `诊断模式已开启 ${ttl} 分钟喵~`,
          enabled: true,
          ttl_minutes: ttl,
          expires_at: expiresAt,
        });
      } else {
        // 关闭 - 任何时候都可以(决策 C)
        await pool.query(
          'UPDATE Users SET debug_mode_enabled = 0, debug_mode_expires_at = NULL WHERE id = ?',
          [userId]
        );
        console.info(`[USER][诊断模式] userId: ${userId} 关闭`);
        return reply.send({ message: '诊断模式已关闭喵~', enabled: false });
      }
    } catch (error) {
      console.error('[USER][诊断模式] 错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // ==================== G-7 消费分析统计(Dashboard 三图) ====================
  // GET /bills/daily-stats - 近30日按日聚合: 消费金额(按模型)+调用次数 + tokens
  //   数据源自给自足: Bills(消费金额/笔数) + Logs(输入/输出 tokens),
  //   与 admin 端授权状态零牵扯; GROUP BY 天然只返回"实际消费过"的模型,
  //   没消费的模型不会出现在结果里(小昙的产品判断 = SQL 聚合语义)。
  //   时区: MySQL 容器为 +08:00, created_at 即东八区壁钟时间,
  //   DATE_FORMAT 直接就是东八区切日 —— 切勿 CONVERT_TZ, 会双重偏移!
  //   起点计算用 F6 签到同款 UTC+8 JS 算法, 不依赖 Node 进程时区。
  //   缓存命中: Logs 表没有该字段(上游渠道普遍不回传), 图表只做输入/输出双段, 绝不造数。
  fastify.get('/bills/daily-stats', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    // G-7.1 按月查看(DeepSeek 同款): ?month=YYYY-MM, 缺省/非法/未来月份一律
    // 回落到东八区"本月"(fail-soft, 与 /bills 日期筛选同哲学)。
    // 起点算法仍是 F6 签到同款 UTC+8 JS 计算, 不依赖 Node 进程时区。
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const shifted = new Date(Date.now() + 8 * 3600 * 1000);
    let year = shifted.getUTCFullYear();
    let month = shifted.getUTCMonth() + 1;
    const mMatch = /^(\d{4})-(\d{2})$/.exec(String((req.query as any)?.month ?? ''));
    if (mMatch) {
      const y = parseInt(mMatch[1], 10);
      const m = parseInt(mMatch[2], 10);
      const notFuture = y < year || (y === year && m <= month);
      if (m >= 1 && m <= 12 && y >= 2020 && notFuture) {
        year = y;
        month = m;
      }
    }
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();  // 该月天数
    const startDate = `${year}-${pad2(month)}-01`;
    const endDate = `${year}-${pad2(month)}-${pad2(lastDay)}`;

    try {
      console.info(`[USER][消费统计] userId: ${userId}, 区间: ${startDate} ~ ${endDate}`);

      // 图①消费金额(按模型堆叠) + 图②调用次数: 一条 SQL 双图共用
      const [spendRows]: any = await pool.query(
        `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS date,
                COALESCE(NULLIF(model, ''), 'system') AS model,
                SUM(ABS(amount)) AS raw_amount,
                COUNT(*) AS calls
         FROM Bills
         WHERE user_id = ? AND type = 'CONSUME' AND created_at >= ? AND created_at <= ?
         GROUP BY date, model
         ORDER BY date ASC`,
        [userId, `${startDate} 00:00:00`, `${endDate} 23:59:59`]
      );

      // 图③ tokens(输入/输出双段)
      const [tokenRows]: any = await pool.query(
        `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS date,
                SUM(prompt_tokens) AS prompt_tokens,
                SUM(COALESCE(cached_tokens, 0)) AS cached_tokens,
                SUM(completion_tokens) AS completion_tokens,
                COUNT(*) AS calls,
                SUM(CASE WHEN cached_tokens IS NULL THEN 1 ELSE 0 END) AS unreported_calls
         FROM Logs
         WHERE user_id = ? AND created_at >= ? AND created_at <= ?
         GROUP BY date
         ORDER BY date ASC`,
        [userId, `${startDate} 00:00:00`, `${endDate} 23:59:59`]
      );

      return reply.send({
        start_date: startDate,
        end_date: endDate,
        spend: spendRows.map((r: any) => ({
          date: r.date,
          model: r.model,
          amount: Number(r.raw_amount) / 100000,   // ×10万整数存储 → 咖啡豆(与 GET /bills 对齐)
          calls: Number(r.calls),
        })),
        tokens: tokenRows.map((r: any) => ({
          date: r.date,
          prompt_tokens: Number(r.prompt_tokens) || 0,
          cached_tokens: Number(r.cached_tokens) || 0,          // F5.3: 已知命中之和(下界)
          completion_tokens: Number(r.completion_tokens) || 0,
          calls: Number(r.calls) || 0,
          unreported_calls: Number(r.unreported_calls) || 0,    // F5.3: 该日未回传缓存数据的笔数
        })),
      });
    } catch (error) {
      console.error('[USER][消费统计] 查询失败:', error);
      return reply.status(500).send({ message: '统计数据获取失败喵' });
    }
  });

  // GET /bills/:id/details - 一笔消费账单的完整诊断详情(F.5 + B0 扩展)
  //   决策 A:  :id 是 Bills 主键; 后端先查 Bills 拿 trace_id + 校验归属, 再调 readShelfItem
  //   决策 B': "完整详情" 接口 —— 返回段 ②③④⑤ 数据:
  //     - 段 ② balance_after            : Bills 表(本笔之后的余额快照)
  //     - 段 ③ status_code / tokens     : Logs 表 LEFT JOIN
  //     - 段 ④ latency_upstream/proxy   : Logs 表 LEFT JOIN
  //     - 段 ⑤ response_body / cached_* : Redis 货架(readShelfItem)
  //     段 ① 基本信息 + amount 仍走 GET /bills 列表已有字段, 前端拼装
  //   设计要点: cached:true / false 都返回段 ②③④ meta —— Logs 持久化, 即使货架空仍可看诊断
  fastify.get('/bills/:id/details', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    const { id } = req.params as { id: string };

    try {
      // 1. 查 Bills + LEFT JOIN Logs 拿 trace_id + 校验归属 + 元数据/性能指标
      //    LEFT JOIN 兜底: 万一 worker 还在异步处理或 Logs 写入失败, Bills 这边仍能返回(meta 字段为 null)
      const [billRows]: any = await pool.query(
        `SELECT
           b.reference_id, b.type, b.balance_after,
           l.status_code, l.prompt_tokens, l.cached_tokens, l.completion_tokens,
           l.latency_upstream_ms, l.latency_proxy_ms,
           l.is_stream
         FROM Bills b
         LEFT JOIN Logs l ON l.trace_id = b.reference_id
         WHERE b.id = ? AND b.user_id = ?`,
        [id, userId]
      );
      if (billRows.length === 0) {
        return reply.status(404).send({ message: '账单不存在或非你所有' });
      }
      const bill = billRows[0];
      // CONSUME 账单的 reference_id 才是 trace_id; TOPUP/其他类型的 reference_id 是 CDK 码, 不查货架
      if (bill.type !== 'CONSUME' || !bill.reference_id) {
        return reply.status(404).send({ message: '这笔账单没有诊断详情(非消费单)' });
      }
      const traceId = bill.reference_id;

      // meta payload: 不管货架命中与否, 段 ②③④ 字段都要返回
      //   balance_after: DB 存的是 ×100000 整数(decimal(20,5)), 项目惯例后端 / 100000 后给前端
      //     与 GET /bills 的 amount 处理对齐, 前端拿到就是豆数, 直接显示 .toFixed(4)
      //   mysql2 对 DECIMAL 默认返回 string, 故 Number() 一次再除; null-safe 兜底 LEFT JOIN 失配
      const meta = {
        balance_after: bill.balance_after !== null && bill.balance_after !== undefined
          ? Number(bill.balance_after) / 100000
          : null,
        status_code: bill.status_code,
        prompt_tokens: bill.prompt_tokens,
        cached_tokens: bill.cached_tokens,  // F5.3: NULL=上游未回传, 前端显示"未回传"
        completion_tokens: bill.completion_tokens,
        latency_upstream_ms: bill.latency_upstream_ms,
        latency_proxy_ms: bill.latency_proxy_ms,
        // F5.2: mysql2 对 BOOLEAN(TINYINT(1)) 默认返回 0 / 1; LEFT JOIN 失配时为 null. 透传给前端.
        is_stream: bill.is_stream,
      };

      // 2. 读货架
      const item = await readShelfItem(Number(userId), traceId);
      if (!item) {
        return reply.send({
          cached: false,
          trace_id: traceId,
          message: '此次请求的响应原文未保留(诊断模式未开启或已过期)',
          ...meta,
        });
      }

      console.info(`[USER][货架读取] userId: ${userId}, bill: ${id}, trace: ${traceId}, 字节: ${Buffer.byteLength(item.responseBody, 'utf8')}`);
      return reply.send({
        cached: true,
        trace_id: traceId,
        response_body: item.responseBody,
        cached_at: new Date(item.cachedAt).toISOString(),
        expires_at: new Date(item.expiresAt).toISOString(),
        ...meta,
      });
    } catch (error) {
      console.error('[USER][货架读取] 错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // DELETE /bills/:id/cache - 立即从货架移除一条 entry(F.5)
  //   用户在前端点 🗑️ "立即移除" 时调用; 比等 purgeExpired 自动清理更及时
  fastify.delete('/bills/:id/cache', async (req, reply) => {
    const userId = req.jwtUser?.userId;
    if (!userId) return reply.status(401).send({ message: '未授权' });

    const { id } = req.params as { id: string };

    try {
      // 同样先查 Bills 校验归属 + 拿 trace_id
      const [billRows]: any = await pool.query(
        'SELECT reference_id, type FROM Bills WHERE id = ? AND user_id = ?',
        [id, userId]
      );
      if (billRows.length === 0) {
        return reply.status(404).send({ message: '账单不存在或非你所有' });
      }
      const bill = billRows[0];
      if (bill.type !== 'CONSUME' || !bill.reference_id) {
        return reply.status(404).send({ message: '这笔账单没有诊断详情' });
      }
      const traceId = bill.reference_id;

      const removed = await removeShelfItem(Number(userId), traceId);
      if (!removed) {
        return reply.send({ message: '货架上没有这条记录(可能已过期或未入架)', removed: false });
      }

      console.info(`[USER][货架移除] userId: ${userId}, bill: ${id}, trace: ${traceId}`);
      return reply.send({ message: '已从货架移除喵~', removed: true });
    } catch (error) {
      console.error('[USER][货架移除] 错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });
}