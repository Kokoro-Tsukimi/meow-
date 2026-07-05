import { FastifyInstance } from 'fastify';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from '../db';
import { redis } from '../redis';
import { adminJwtAuth } from '../middleware/adminJwtAuth';
import { purgeUser } from '../services/userPurge';
import { listSettings, updateSetting } from '../services/systemSettings';
import { sendTestMail, invalidateMailTransporter } from '../mailer';
import {
  checkLoginAttempt,
  recordLoginFailure,
  resetLoginAttempts,
  getClientIp,
} from '../middleware/rateLimit';

// ============ E.1 规则缓存小工具 ============
// proxy.ts 的"安检"会从这个 key 读规则(TTL 60秒,套路同渠道缓存)。
// 只要规则有增删改,就把缓存删掉,让 proxy 下次请求时回源 MySQL 重新加载喵~
const RULES_CACHE_KEY = 'gateway:cache:rules:all';
// F.1.5 顺手补漏:渠道增删改后也要清缓存,不然要干等60秒TTL才生效喵
const CHANNELS_CACHE_KEY = 'gateway:cache:channels:all';
async function bustChannelsCache() {
  try {
    await redis.del(CHANNELS_CACHE_KEY);
    console.info('[ADMIN][渠道缓存] 已清空,网关下次请求会重新加载喵~');
  } catch (err: any) {
    console.error('[ADMIN][渠道缓存] 清空失败:', err.message);
  }
}
async function bustRulesCache() {
  try {
    await redis.del(RULES_CACHE_KEY);
    console.info('[ADMIN][规则缓存] 已清空,网关下次请求会重新加载喵~');
  } catch (err: any) {
    console.error('[ADMIN][规则缓存] 清空失败:', err.message);
  }
}

// F.1.6 分组缓存:proxy.ts 解析 model 字段时会读这里(详见 Phase 3)
// 分组本体/组内渠道挂载/user 授权 任一变动都要清缓存
const MODEL_GROUPS_CACHE_KEY = 'gateway:cache:model_groups:all';
async function bustModelGroupsCache() {
  try {
    await redis.del(MODEL_GROUPS_CACHE_KEY);
    console.info('[ADMIN][分组缓存] 已清空,网关下次请求会重新加载喵~');
  } catch (err: any) {
    console.error('[ADMIN][分组缓存] 清空失败:', err.message);
  }
}

// ============ T-1 分页参数清洗(防注入 + 上限治理) ============
// 用于所有接收 ?page&limit 的 list 接口,防 limit=99999 拖垮 MySQL
// 默认 20 条/页, 硬上限 100 条/页, page 上限 10000(防 Infinity / 负数)
// 返回值已是 Number, 可直接放进 SQL 占位符
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

export default async function adminRoutes(fastify: FastifyInstance) {
  // ============ 公开接口(无需鉴权) ============

  fastify.post('/auth/login', async (req, reply) => {
    const { email, password } = req.body as any;

    if (!email || !password) {
      return reply.status(400).send({ message: '邮箱和密码不能为空' });
    }

    // S1.前哨:超管登录限流 check(更严:email 3次/10min 锁10min,IP 10次/5min 锁30min)
    const emailInput = String(email).trim();
    const clientIp = getClientIp(req);
    const lockCheck = await checkLoginAttempt('admin_login', emailInput, clientIp);
    if (lockCheck.locked) {
      const mins = Math.ceil(lockCheck.info / 60);
      console.warn(`[ADMIN][登录限流] 拒绝 email=${emailInput} ip=${clientIp} 维度=${lockCheck.lockedDimension} 剩余=${lockCheck.info}秒`);
      return reply.status(429).send({
        message: `登录失败次数过多,请 ${mins} 分钟后再试(超管端无找回密码,如需手动解锁请联系部署者清 Redis)`,
      });
    }

    // C+.6 (H3): 不再提供 admin123 / 默认JWT密钥兜底。
    // 环境变量没配齐就直接拒绝登录——宁可登不进,也不留后门喵。
    const adminEmail = process.env.ADMIN_EMAIL;
    const adminPassword = process.env.ADMIN_PASSWORD;
    const secret = process.env.ADMIN_JWT_SECRET;

    if (!adminEmail || !adminPassword || !secret) {
      console.error('[ADMIN][登录] 拒绝登录: 请在 .env 中配置 ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_JWT_SECRET');
      return reply.status(503).send({ message: '超管账号未配置,请联系部署者在 .env 中设置' });
    }

    if (email !== adminEmail || password !== adminPassword) {
      const failRes = await recordLoginFailure('admin_login', emailInput, clientIp);
      if (failRes.locked) {
        const mins = Math.ceil(failRes.info / 60);
        console.warn(`[ADMIN][登录] 失败尝试触发锁定: ${email}, 锁 ${mins} 分钟`);
        return reply.status(429).send({
          message: `登录失败次数过多,请 ${mins} 分钟后再试(超管端无找回密码,如需手动解锁请联系部署者清 Redis)`,
        });
      }
      console.warn(`[ADMIN][登录] 失败尝试: ${email}`);
      return reply.status(401).send({ message: '账号或密码错误' });
    }

    // 登录成功:清 email 维度的失败计数和锁(IP 维度不清,防攻击者解套)
    await resetLoginAttempts('admin_login', emailInput);

    const token = jwt.sign(
      { email: adminEmail, role: 'ADMIN' },
      secret,
      { expiresIn: '1d' }
    );

    console.info(`[ADMIN][登录] 超管登录成功: ${email}`);
    return reply.send({ token, email: adminEmail });
  });

  // ============ 受保护接口(需要超管JWT) ============

  fastify.register(async (protectedRoutes) => {
    protectedRoutes.addHook('preHandler', adminJwtAuth);
    // ============ ModelRates 模型费率管理 ============

    // GET /model-rates - 费率列表
    protectedRoutes.get('/model-rates', async (req, reply) => {
      try {
        const [rows]: any = await pool.query(
          'SELECT id, model_name, channel_id, prompt_price, completion_price, created_at FROM ModelRates ORDER BY id DESC'
        );
        // 把放大10万倍的整数换算回人类可读价格(每1k tokens的咖啡豆数)
        const items = rows.map((r: any) => ({
          ...r,
          prompt_price_real: Number(r.prompt_price) / 100000,
          completion_price_real: Number(r.completion_price) / 100000,
        }));
        console.info(`[ADMIN][费率列表] 共 ${rows.length} 条`);
        return reply.send({ items });
      } catch (error) {
        console.error('[ADMIN][费率列表] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // POST /model-rates - 新增/更新费率(同步写入 MySQL + Redis)
    protectedRoutes.post('/model-rates', async (req, reply) => {
      const { model_name, channel_id, prompt_price, completion_price } = req.body as any;
      if (!model_name || prompt_price === undefined || completion_price === undefined) {
        return reply.status(400).send({ message: '模型名、输入价、输出价不能为空' });
      }
      // 接收人类可读价格(每1k tokens多少咖啡豆),放大10万倍存为整数
      const channelId = Number(channel_id) || 0;
      const promptInt = Math.round(Number(prompt_price) * 100000);
      const completionInt = Math.round(Number(completion_price) * 100000);
      if (promptInt < 0 || completionInt < 0) {
        return reply.status(400).send({ message: '价格不能为负数' });
      }
      try {
        // 1. 写入 MySQL(存在则更新,靠 uk_model_channel 唯一键)
        await pool.query(
          `INSERT INTO ModelRates (model_name, channel_id, prompt_price, completion_price)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE prompt_price = VALUES(prompt_price), completion_price = VALUES(completion_price)`,
          [model_name, channelId, promptInt, completionInt]
        );

        // 2. 同步写入 Redis(proxy.ts 扣费时从这里读)
        const rateKey = `gateway:rates:model:${channelId}:${model_name}`;
        await redis.hset(rateKey, {
          prompt_price: promptInt.toString(),
          completion_price: completionInt.toString(),
        });

        console.info(`[ADMIN][费率设置] ${model_name} (channel ${channelId}): in=${promptInt}, out=${completionInt}`);
        return reply.send({ message: '费率设置成功喵~已同步到网关', rate_key: rateKey });
      } catch (error) {
        console.error('[ADMIN][费率设置] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // GET /dashboard/metrics
    protectedRoutes.get('/dashboard/metrics', async (req, reply) => {
      try {
        const [callRows]: any = await pool.query(
          "SELECT COUNT(*) AS count FROM Bills WHERE type = 'CONSUME' AND DATE(created_at) = CURDATE()"
        );
        const totalCallsToday = callRows[0]?.count || 0;

        const [costRows]: any = await pool.query(
          "SELECT COALESCE(SUM(-amount), 0) AS total FROM Bills WHERE type = 'CONSUME' AND DATE(created_at) = CURDATE()"
        );
        // 修复:数据库存的是放大10万倍的整数,显示前要还原成人类豆数喵
        const totalCostToday = (Number(costRows[0]?.total) || 0) / 100000;

        const [userRows]: any = await pool.query('SELECT COUNT(*) AS count FROM Users');
        const totalUsers = userRows[0]?.count || 0;

        const [tokenRows]: any = await pool.query(
          "SELECT COUNT(*) AS count FROM Tokens WHERE status = 'ENABLE'"
        );
        const activeTokens = tokenRows[0]?.count || 0;

        const [recentLogs]: any = await pool.query(
          `SELECT id, user_id, amount, model, created_at FROM Bills WHERE type = 'CONSUME' ORDER BY created_at DESC LIMIT 10`
        );

        console.info('[ADMIN][仪表盘] 数据查询成功');
        // 修复:最近消费记录的金额同样要 ÷100000 还原,跟用户端小票对齐喵
        const recentLogsReal = recentLogs.map((l: any) => ({ ...l, amount: Number(l.amount) / 100000 }));
        return reply.send({ totalCallsToday, totalCostToday, totalUsers, activeTokens, recentLogs: recentLogsReal });
      } catch (error) {
        console.error('[ADMIN][仪表盘] 查询错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // ============ Channels CRUD ============

    protectedRoutes.get('/channels', async (req, reply) => {
      try {
        const [rows]: any = await pool.query(
          'SELECT id, name, base_url, api_key_encrypted, models, weight, priority, status, owner_user_id, created_at FROM Channels ORDER BY priority ASC, id DESC LIMIT 500'
        );
        console.info(`[ADMIN][渠道列表] 共 ${rows.length} 条`);
        return reply.send({ items: rows });
      } catch (error) {
        console.error('[ADMIN][渠道列表] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    protectedRoutes.post('/channels', async (req, reply) => {
      const { name, base_url, api_key, models, weight, priority, owner_user_id } = req.body as any;
      if (!name || !base_url || !api_key) {
        return reply.status(400).send({ message: '名称、Base URL、API Key 不能为空' });
      }
      try {
        // F.1.5: 指定了专属主人就先确认这位主人真的在册,防止手滑填错ID喵
        let ownerId: number | null = null;
        if (owner_user_id !== undefined && owner_user_id !== null && String(owner_user_id).trim() !== '') {
          ownerId = Number(owner_user_id);
          const [ownerRows]: any = await pool.query('SELECT id FROM Users WHERE id = ?', [ownerId]);
          if (ownerRows.length === 0) {
            return reply.status(400).send({ message: `专属主人 ID ${ownerId} 不在常客名册里喵` });
          }
        }
        const modelsJson = Array.isArray(models) ? JSON.stringify(models) : JSON.stringify([]);
        const [result]: any = await pool.query(
          'INSERT INTO Channels (name, base_url, api_key_encrypted, models, weight, priority, status, owner_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [name, base_url, api_key, modelsJson, weight || 1, priority || 1, 'ENABLE', ownerId]
        );
        await bustChannelsCache();
        console.info(`[ADMIN][渠道新增] 名称: ${name}, ID: ${result.insertId}, 专属主人: ${ownerId ?? '公共'}`);
        return reply.send({ id: result.insertId, message: '上架入库成功喵~' });
      } catch (error) {
        console.error('[ADMIN][渠道新增] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    protectedRoutes.put('/channels/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { name, base_url, api_key, models, weight, priority, status, owner_user_id } = req.body as any;
      try {
        // 修复技术债#18:旧版无条件全量 UPDATE,任何漏传字段都会被默认值/null 覆盖
        // (快捷切换冲掉 owner 暗坑就是这个机制)。改为只更新前端真正传来的字段,
        // 没传的保持原样,套路同下面 PUT /rules/:id 喵。
        const updates: string[] = [];
        const params: any[] = [];

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (base_url !== undefined) { updates.push('base_url = ?'); params.push(base_url); }
        if (api_key !== undefined) { updates.push('api_key_encrypted = ?'); params.push(api_key); }
        if (models !== undefined) {
          updates.push('models = ?');
          params.push(Array.isArray(models) ? JSON.stringify(models) : JSON.stringify([]));
        }
        if (weight !== undefined) { updates.push('weight = ?'); params.push(weight); }
        if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
        if (status !== undefined) { updates.push('status = ?'); params.push(status); }

        // owner_user_id 三态:没传=保持原样 / null 或空串=取消专属归公共 / 有值=校验主人在册后设定
        if (owner_user_id !== undefined) {
          if (owner_user_id === null || String(owner_user_id).trim() === '') {
            updates.push('owner_user_id = ?');
            params.push(null);
          } else {
            const ownerId = Number(owner_user_id);
            const [ownerRows]: any = await pool.query('SELECT id FROM Users WHERE id = ?', [ownerId]);
            if (ownerRows.length === 0) {
              return reply.status(400).send({ message: `专属主人 ID ${ownerId} 不在常客名册里喵` });
            }
            updates.push('owner_user_id = ?');
            params.push(ownerId);
          }
        }

        if (updates.length === 0) {
          return reply.status(400).send({ message: '没有要更新的字段喵' });
        }

        params.push(id);
        const [result]: any = await pool.query(
          `UPDATE Channels SET ${updates.join(', ')} WHERE id = ?`, params
        );
        if (result.affectedRows === 0) {
          return reply.status(404).send({ message: '渠道不存在' });
        }
        await bustChannelsCache();
        console.info(`[ADMIN][渠道修改] ID: ${id}, 更新 ${updates.length} 个字段`);
        return reply.send({ message: '修改成功喵~' });
      } catch (error) {
        console.error('[ADMIN][渠道修改] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    protectedRoutes.delete('/channels/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const [result]: any = await pool.query('DELETE FROM Channels WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
          return reply.status(404).send({ message: '渠道不存在' });
        }
        await bustChannelsCache();
        console.info(`[ADMIN][渠道删除] ID: ${id}`);
        return reply.send({ message: '已下架喵~' });
      } catch (error) {
        console.error('[ADMIN][渠道删除] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // ============ F.3.a MailChannels 送信小猫的窝(多SMTP管理) ============
    // pass(授权码)属敏感字段,列表一律遮罩返回,同 api_key 套路不吐明文喵。
    function maskMailPass(p: string): string {
      if (!p) return '';
      if (p.length <= 4) return '****';
      return p.slice(0, 2) + '****' + p.slice(-2);
    }

    // GET /mail-channels - 列表(pass 遮罩)
    protectedRoutes.get('/mail-channels', async (req, reply) => {
      try {
        const [rows]: any = await pool.query(
          'SELECT id, name, host, port, `user`, pass, status, weight, priority, group_name, last_verified_at, created_at FROM MailChannels ORDER BY id DESC LIMIT 100'
        );
        const items = rows.map((r: any) => ({ ...r, pass: maskMailPass(r.pass) }));
        console.info(`[ADMIN][送信渠道列表] 共 ${rows.length} 条`);
        return reply.send({ items });
      } catch (error) {
        console.error('[ADMIN][送信渠道列表] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // POST /mail-channels - 新建(强制落 UNVERIFIED,没巡检过不能直接用)
    protectedRoutes.post('/mail-channels', async (req, reply) => {
      const { name, host, port, user, pass, weight, priority, group_name } = req.body as any;
      if (!name || !host || !user || !pass) {
        return reply.status(400).send({ message: '名称、主机、账号、授权码不能为空喵' });
      }
      try {
        const [result]: any = await pool.query(
          'INSERT INTO MailChannels (name, host, port, `user`, pass, status, weight, priority, group_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [name, host, port || 465, user, pass, 'UNVERIFIED', weight || 1, priority || 1,
            (group_name && String(group_name).trim()) ? group_name : null]
        );
        console.info(`[ADMIN][送信渠道新增] 名称: ${name}, ID: ${result.insertId}, 状态: UNVERIFIED`);
        return reply.send({ id: result.insertId, message: '送信小猫已收编,记得先巡检再激活喵~' });
      } catch (error) {
        console.error('[ADMIN][送信渠道新增] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // PUT /mail-channels/:id - 改(只更新传来字段;遮罩占位的 pass 不当真改;动连接参数则打回 UNVERIFIED;改完清池)
    protectedRoutes.put('/mail-channels/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { name, host, port, user, pass, weight, priority, group_name } = req.body as any;
      try {
        const updates: string[] = [];
        const params: any[] = [];
        let touchedConn = false; // 是否动了连接参数(host/port/user/pass),动了就要重新巡检

        if (name !== undefined) { updates.push('name = ?'); params.push(name); }
        if (host !== undefined) { updates.push('host = ?'); params.push(host); touchedConn = true; }
        if (port !== undefined) { updates.push('port = ?'); params.push(port); touchedConn = true; }
        if (user !== undefined) { updates.push('`user` = ?'); params.push(user); touchedConn = true; }
        // pass 特殊:前端列表里显示的是遮罩串(含 ****),只有传来的不含 **** 才当作真改动,
        // 避免把遮罩占位"ab****yz"误写进库喵。
        if (pass !== undefined && !String(pass).includes('****')) {
          updates.push('pass = ?'); params.push(pass); touchedConn = true;
        }
        if (weight !== undefined) { updates.push('weight = ?'); params.push(weight); }
        if (priority !== undefined) { updates.push('priority = ?'); params.push(priority); }
        if (group_name !== undefined) {
          updates.push('group_name = ?');
          params.push((group_name === null || String(group_name).trim() === '') ? null : group_name);
        }
        // 改了连接参数 → 之前的巡检结果作废,状态打回 UNVERIFIED(需重新巡检才能再激活)
        if (touchedConn) { updates.push('status = ?'); params.push('UNVERIFIED'); }

        if (updates.length === 0) {
          return reply.status(400).send({ message: '没有要更新的字段喵' });
        }
        params.push(id);
        const [result]: any = await pool.query(
          `UPDATE MailChannels SET ${updates.join(', ')} WHERE id = ?`, params
        );
        if (result.affectedRows === 0) {
          return reply.status(404).send({ message: '送信渠道不存在喵' });
        }
        invalidateMailTransporter(Number(id)); // 清掉旧 transporter,下次按新凭证重建
        console.info(`[ADMIN][送信渠道修改] ID: ${id}, 更新 ${updates.length} 个字段${touchedConn ? '(动了连接参数,已打回UNVERIFIED)' : ''}`);
        return reply.send({ message: '修改成功喵~' });
      } catch (error) {
        console.error('[ADMIN][送信渠道修改] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // DELETE /mail-channels/:id - 删(删完清池)
    protectedRoutes.delete('/mail-channels/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const [result]: any = await pool.query('DELETE FROM MailChannels WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
          return reply.status(404).send({ message: '送信渠道不存在喵' });
        }
        invalidateMailTransporter(Number(id));
        console.info(`[ADMIN][送信渠道删除] ID: ${id}`);
        return reply.send({ message: '送信小猫已放归喵~' });
      } catch (error) {
        console.error('[ADMIN][送信渠道删除] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // POST /mail-channels/:id/status - 激活/停用(ACTIVE ⇄ INACTIVE;只有巡检过的才能激活)
    protectedRoutes.post('/mail-channels/:id/status', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { status } = req.body as any;
      if (status !== 'ACTIVE' && status !== 'INACTIVE') {
        return reply.status(400).send({ message: '状态只能切到 ACTIVE 或 INACTIVE 喵' });
      }
      try {
        const [rows]: any = await pool.query('SELECT status FROM MailChannels WHERE id = ?', [id]);
        if (rows.length === 0) {
          return reply.status(404).send({ message: '送信渠道不存在喵' });
        }
        const cur = rows[0].status;
        // 要激活 → 当前必须是 INACTIVE(巡检通过待命)或已经 ACTIVE;UNVERIFIED/ERROR 不许直接激活
        if (status === 'ACTIVE' && cur !== 'INACTIVE' && cur !== 'ACTIVE') {
          return reply.status(400).send({ message: '这只送信小猫还没通过巡检,先验证成功再激活喵~' });
        }
        await pool.query('UPDATE MailChannels SET status = ? WHERE id = ?', [status, id]);
        invalidateMailTransporter(Number(id));
        console.info(`[ADMIN][送信渠道状态] ID: ${id}, ${cur} -> ${status}`);
        return reply.send({ message: status === 'ACTIVE' ? '已激活,开始参与送信喵~' : '已停用,暂不参与送信喵~' });
      } catch (error) {
        console.error('[ADMIN][送信渠道状态] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // POST /mail-channels/:id/verify - 同步巡检(当场发测试信验证连通性)
    // body: { to?: string }  to 为空则发给渠道账号自己。成功→INACTIVE(已是ACTIVE则保持),失败→ERROR
    protectedRoutes.post('/mail-channels/:id/verify', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { to } = req.body as any;
      try {
        const [rows]: any = await pool.query(
          'SELECT id, name, host, port, `user`, pass, status FROM MailChannels WHERE id = ?', [id]
        );
        if (rows.length === 0) {
          return reply.status(404).send({ message: '送信渠道不存在喵' });
        }
        const r = rows[0];
        try {
          await sendTestMail(
            { name: r.name, host: r.host, port: Number(r.port), user: r.user, pass: r.pass },
            to
          );
        } catch (mailErr: any) {
          await pool.query("UPDATE MailChannels SET status = 'ERROR' WHERE id = ?", [id]);
          console.warn(`[ADMIN][送信巡检] 渠道 ${id} 巡检失败: ${mailErr.message}`);
          return reply.status(502).send({ message: `巡检失败喵:${mailErr.message}`, status: 'ERROR' });
        }
        // 成功:已是 ACTIVE 的保持 ACTIVE(只刷新巡检时间),否则落 INACTIVE 待命
        const newStatus = r.status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE';
        await pool.query(
          'UPDATE MailChannels SET status = ?, last_verified_at = NOW() WHERE id = ?', [newStatus, id]
        );
        console.info(`[ADMIN][送信巡检] 渠道 ${id} 巡检通过,状态 -> ${newStatus}`);
        return reply.send({ message: '巡检通过喵~测试信已发出,去激活就能上岗啦', status: newStatus });
      } catch (error) {
        console.error('[ADMIN][送信巡检] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // ============ Users 用户管理 ============

    protectedRoutes.get('/users', async (req, reply) => {
      const { search = '' } = req.query as { search?: string };
      // T-1: 分页参数清洗(limit 硬上限 100)
      const { page, limit, offset } = parsePagination(req.query);
      try {
        let countSql = 'SELECT COUNT(*) AS total FROM Users';
        let listSql = 'SELECT id, email, balance, status, remark, created_at FROM Users';
        const params: any[] = [];
        if (search) {
          // 邮箱和备注一起模糊匹配:搜"高中同学"也能捞出那群人喵
          countSql += ' WHERE (email LIKE ? OR remark LIKE ?)';
          listSql += ' WHERE (email LIKE ? OR remark LIKE ?)';
          params.push(`%${search}%`, `%${search}%`);
        }
        listSql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
        const [countRows]: any = await pool.query(countSql, params);
        const total = countRows[0].total;
        const [items]: any = await pool.query(listSql, [...params, limit, offset]);
        console.info(`[ADMIN][用户列表] 共 ${total} 条, 搜索: ${search || '无'}`);
        return reply.send({
          items: items.map((u: any) => ({ ...u, balance: Number(u.balance) / 100000 })),
          total,
          page
        });
      } catch (error) {
        console.error('[ADMIN][用户列表] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // POST /users - 店长亲手登记新会员(F.1a)
    // 密码哈希方式必须和 routes/auth.ts 注册接口完全一致(bcrypt, salt rounds 10),
    // 不然朋友拿着店长发的密码登不进门喵
    protectedRoutes.post('/users', async (req, reply) => {
      const { email, password, remark } = req.body as { email?: string; password?: string; remark?: string };

      if (!email || !email.trim() || !password) {
        return reply.status(400).send({ message: '邮箱和初始密码不能为空' });
      }
      // 极简邮箱格式检查(有@有.且不带空格,够用了喵)
      const emailTrimmed = email.trim();
      if (!/^\S+@\S+\.\S+$/.test(emailTrimmed)) {
        return reply.status(400).send({ message: '邮箱格式看起来不太对喵' });
      }
      if (password.length < 4) {
        return reply.status(400).send({ message: '初始密码至少4位喵' });
      }

      try {
        const [rows]: any = await pool.query('SELECT id FROM Users WHERE email = ?', [emailTrimmed]);
        if (rows.length > 0) {
          return reply.status(400).send({ message: '该邮箱已被注册' });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const [result]: any = await pool.query(
          'INSERT INTO Users (email, password_hash, balance, status, group_id, remark) VALUES (?, ?, 0, ?, 1, ?)',
          [emailTrimmed, passwordHash, 'ACTIVE', remark?.trim() || null]
        );
        const newUserId = result.insertId;

        // 和注册接口一样,初始化 Redis 余额(0豆,送豆请用现成的手动充值按钮喵)
        await redis.set(`gateway:user:balance:${newUserId}`, 0);

        console.info(`[ADMIN][登记会员] email: ${emailTrimmed}, id: ${newUserId}, remark: ${remark || '无'}`);
        return reply.send({
          id: newUserId,
          message: '新会员登记入册喵~记得用充值按钮投喂开户咖啡豆',
        });
      } catch (error) {
        console.error('[ADMIN][登记会员] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // PUT /users/:id/remark - 店长改小本本备注(F.1a)
    protectedRoutes.put('/users/:id/remark', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { remark } = req.body as { remark?: string };

      try {
        // 传空字符串=擦掉备注;最长255由列宽兜底,这里友好提示
        const remarkValue = remark?.trim() || null;
        if (remarkValue && remarkValue.length > 255) {
          return reply.status(400).send({ message: '备注太长了喵,小本本只有255格' });
        }
        const [result]: any = await pool.query('UPDATE Users SET remark = ? WHERE id = ?', [remarkValue, id]);
        if (result.affectedRows === 0) {
          return reply.status(404).send({ message: '用户不存在' });
        }
        console.info(`[ADMIN][会员备注] ID: ${id}, remark: ${remarkValue || '(已清空)'}`);
        return reply.send({ message: '小本本记好了喵~' });
      } catch (error) {
        console.error('[ADMIN][会员备注] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // S1+(2026-06-23): 加 BLACKLIST 状态 + 改状态时主动清该用户所有 Token 鉴权缓存
    //   - 不清缓存 = 封号后 sk-meow- 仍可用直到 TTL 过期 = 漏洞窗口(原状态校验在 auth.ts 已修)
    //   - 清缓存 = 下次请求时 auth.ts 缓存 miss 走 JOIN Users 回源, 新 status 立即生效
    //   - 缓存清理后无副作用:miss 会自动回源重建, 性能影响极小
    protectedRoutes.put('/users/:id/status', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { status } = req.body as { status: 'ACTIVE' | 'BANNED' | 'ARREARS' | 'BLACKLIST' };
      if (!['ACTIVE', 'BANNED', 'ARREARS', 'BLACKLIST'].includes(status)) {
        return reply.status(400).send({ message: '状态值非法' });
      }
      try {
        const [result]: any = await pool.query('UPDATE Users SET status = ? WHERE id = ?', [status, id]);
        if (result.affectedRows === 0) {
          return reply.status(404).send({ message: '用户不存在' });
        }
        // S1+: 主动失效该用户所有 Token 的鉴权缓存
        //   查名下所有 token 字符串, 逐个 DEL Redis gateway:token:info:<token>
        //   即使该用户没有 token(刚注册的)也安全:循环走 0 次自然跳过
        const [tokenRows]: any = await pool.query('SELECT token FROM Tokens WHERE user_id = ?', [id]);
        let cleared = 0;
        for (const row of tokenRows) {
          await redis.del(`gateway:token:info:${row.token}`);
          cleared++;
        }
        console.info(`[ADMIN][用户状态] ID: ${id}, 新状态: ${status}, 主动清 ${cleared} 把召唤铃的鉴权缓存`);
        return reply.send({ message: '状态已更新喵~' });
      } catch (error) {
        console.error('[ADMIN][用户状态] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    protectedRoutes.post('/users/:id/topup', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { amount, note } = req.body as { amount: number; note?: string };
      const amountNum = Number(amount);
      if (!amountNum || amountNum === 0) {
        return reply.status(400).send({ message: '金额必须是非零数字' });
      }
      const amountInt = Math.round(amountNum * 100000);
      const referenceId = `admin_topup_${Date.now()}_${id}`;
      const billType = amountInt > 0 ? 'TOPUP' : 'REFUND';
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        const [userRows]: any = await connection.query('SELECT id, balance FROM Users WHERE id = ? FOR UPDATE', [id]);
        if (userRows.length === 0) {
          await connection.rollback();
          return reply.status(404).send({ message: '用户不存在' });
        }
        if (amountInt < 0) {
          const currentBalance = Number(userRows[0].balance);
          if (currentBalance + amountInt < 0) {
            await connection.rollback();
            return reply.status(400).send({ message: '余额不足，无法扣除' });
          }
        }
        await connection.query('UPDATE Users SET balance = balance + ? WHERE id = ?', [amountInt, id]);
        await connection.query(
          'INSERT INTO Bills (user_id, type, amount, reference_id, model) VALUES (?, ?, ?, ?, ?)',
          [id, billType, amountInt, referenceId, note || 'admin_manual']
        );
        await connection.commit();
        // C窗后续加固(2026-07-01): Redis 余额缓存的健壮更新
        //   历史遗留脏值: 旧版回源曾把 MySQL 的 DECIMAL(带 .00000 尾巴)原样 SET 进 Redis,
        //   导致 INCRBY 撞上非整数字符串抛 ReplyError → 充值返 500。
        //   现在: 先校验缓存值是否合法整数; 是→直接 incrby(快路径);
        //         否(脏值/不存在)→ DEL 清掉,再从 MySQL 回源出干净整数写回(自愈)。
        //   MySQL 事务已提交(上面 commit),是唯一真相源;Redis 只是缓存,怎么走都不影响账目正确性。
        const balanceKey = `gateway:user:balance:${id}`;
        try {
          const redisBalanceStr = await redis.get(balanceKey);
          // 合法整数缓存 → 快路径 incrby
          if (redisBalanceStr !== null && /^-?\d+$/.test(redisBalanceStr)) {
            await redis.incrby(balanceKey, amountInt);
          } else {
            // 脏值 or 不存在 → 清掉,从 MySQL 回源出干净整数(Math.round 切掉 DECIMAL 尾巴)
            if (redisBalanceStr !== null) {
              console.warn(`[ADMIN][手动充值][脏值自愈] userId: ${id}, 缓存值 "${redisBalanceStr}" 非整数, 已清理并回源`);
            }
            const [freshRows]: any = await pool.query('SELECT balance FROM Users WHERE id = ?', [id]);
            const cleanBalance = freshRows.length > 0 ? Math.round(Number(freshRows[0].balance)) : 0;
            await redis.set(balanceKey, cleanBalance);
          }
        } catch (redisErr) {
          // Redis 更新失败不影响账目(MySQL 已提交),仅告警;下次 auth 回源会自愈
          console.error(`[ADMIN][手动充值][Redis缓存更新失败,不影响账目]`, redisErr);
        }
        console.info(`[ADMIN][手动充值] userId: ${id}, amount: ${amountNum}, ref: ${referenceId}`);
        return reply.send({
          message: amountInt > 0 ? '充值成功喵~' : '扣除成功喵~',
          reference_id: referenceId
        });
      } catch (error) {
        await connection.rollback();
        console.error('[ADMIN][手动充值] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      } finally {
        connection.release();
      }
    });

    // ============ F.1.7 删除会员 (销账留账本) ============
    // 路线 A: 删 Users 行 + 名下 Tokens + 名下分组授权 + Redis 缓存; Bills/Logs 留底。
    // 超管账号不在 Users 表里 (走 .env), 所以无需 "删自己" 保护;
    // 前端两道警告 (普通确认 + 余额>0 多一道) 由 Users.tsx 兜底, 后端只管销账喵。
    // 销账动作本身在 services/userPurge.ts, 本接口只管 "取信息 + 调 helper + 回执"。

    // DELETE /users/:id - 店长删除会员
    protectedRoutes.delete('/users/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const userId = Number(id);
      if (!Number.isFinite(userId) || userId <= 0) {
        return reply.status(400).send({ message: 'user_id 不合法喵' });
      }

      try {
        // 先取被删会员的基本信息, 日志里要记是哪只猫从店里消失了 (Users 行删了之后再查就晚了喵)
        const [rows]: any = await pool.query(
          'SELECT email, balance FROM Users WHERE id = ?',
          [userId]
        );
        if (rows.length === 0) {
          return reply.status(404).send({ message: '该会员不存在喵' });
        }
        const targetEmail = rows[0].email;
        const targetBalance = Number(rows[0].balance) / 100000;

        // 销账 (事务 + Redis 清理一条龙, 详见 services/userPurge.ts)
        const result = await purgeUser(userId);
        console.info(`[ADMIN][删除会员] ${req.adminUser?.email} 删除会员 id=${userId} (${targetEmail}, 余额 ${targetBalance} 豆), 顺手清 ${result.deletedTokens} 把召唤铃 + ${result.deletedGrants} 条授权`);

        return reply.send({ success: true });
      } catch (error: any) {
        // purgeUser 抛 USER_NOT_FOUND:xxx 的极端情况 (并发删了两次)
        if (error?.message?.startsWith('USER_NOT_FOUND:')) {
          return reply.status(404).send({ message: '该会员不存在喵' });
        }
        console.error('[ADMIN][删除会员] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // ============ RedeemCodes 兑换码(后厨烘焙坊) ============

    // POST /redeem-codes - 批量生成CDK
    protectedRoutes.post('/redeem-codes', async (req, reply) => {
      const { amount, count, prefix } = req.body as { amount: number; count: number; prefix?: string };

      const amountNum = Number(amount);
      const countNum = Number(count);

      if (!amountNum || amountNum <= 0) {
        return reply.status(400).send({ message: '面额必须大于0' });
      }
      if (!countNum || countNum < 1 || countNum > 1000) {
        return reply.status(400).send({ message: '生成数量需在 1~1000 之间' });
      }

      const amountInt = Math.round(amountNum * 100000);
      const codePrefix = (prefix || 'MEOW').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8) || 'MEOW';

      // 生成不重复的随机码
      function genCode(): string {
        const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ23456789'; // 去掉易混淆的 O0I1
        let segs: string[] = [];
        for (let s = 0; s < 3; s++) {
          let seg = '';
          for (let i = 0; i < 4; i++) {
            seg += chars[crypto.randomInt(0, chars.length)];
          }
          segs.push(seg);
        }
        return `${codePrefix}-${segs.join('-')}`;
      }

      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();

        const generated: string[] = [];
        for (let i = 0; i < countNum; i++) {
          let code = genCode();
          // 简单重试防撞(最多重试3次)
          let inserted = false;
          for (let retry = 0; retry < 3 && !inserted; retry++) {
            try {
              await connection.query(
                'INSERT INTO RedeemCodes (code, amount, status) VALUES (?, ?, ?)',
                [code, amountInt, 'UNUSED']
              );
              generated.push(code);
              inserted = true;
            } catch (e: any) {
              if (e.code === 'ER_DUP_ENTRY') {
                code = genCode(); // 撞了重新生成
              } else {
                throw e;
              }
            }
          }
        }

        await connection.commit();
        console.info(`[ADMIN][CDK生成] 面额: ${amountNum}, 数量: ${generated.length}`);
        return reply.send({
          message: `成功烘焙 ${generated.length} 张咖啡豆礼品卡喵~`,
          codes: generated,
          amount: amountNum,
        });
      } catch (error) {
        await connection.rollback();
        console.error('[ADMIN][CDK生成] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      } finally {
        connection.release();
      }
    });

    // GET /redeem-codes - 分页查看CDK列表
    protectedRoutes.get('/redeem-codes', async (req, reply) => {
      const { status = '' } = req.query as { status?: string };
      // T-1: 分页参数清洗(limit 硬上限 100)
      const { page, limit, offset } = parsePagination(req.query);
      try {
        let countSql = 'SELECT COUNT(*) AS total FROM RedeemCodes';
        let listSql = 'SELECT id, code, amount, status, used_by, used_at, created_at FROM RedeemCodes';
        const params: any[] = [];
        if (status && ['UNUSED', 'USED'].includes(status)) {
          countSql += ' WHERE status = ?';
          listSql += ' WHERE status = ?';
          params.push(status);
        }
        listSql += ' ORDER BY id DESC LIMIT ? OFFSET ?';
        const [countRows]: any = await pool.query(countSql, params);
        const total = countRows[0].total;
        const [items]: any = await pool.query(listSql, [...params, limit, offset]);
        console.info(`[ADMIN][CDK列表] 共 ${total} 条`);
        return reply.send({
          items: items.map((c: any) => ({ ...c, amount: Number(c.amount) / 100000 })),
          total,
          page
        });
      } catch (error) {
        console.error('[ADMIN][CDK列表] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }      
});

    // ============ Rules 风控规则 CRUD(E.1 安检手册) ============

    // GET /rules - 规则列表
    protectedRoutes.get('/rules', async (req, reply) => {
      try {
        const [rows]: any = await pool.query(
          'SELECT id, name, rule_type, match_conditions, status, created_at FROM Rules ORDER BY id DESC LIMIT 500'
        );
        console.info(`[ADMIN][规则列表] 共 ${rows.length} 条`);
        return reply.send({ items: rows });
      } catch (error) {
        console.error('[ADMIN][规则列表] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // POST /rules - 新增规则(写完 MySQL 顺手清缓存)
    protectedRoutes.post('/rules', async (req, reply) => {
      const { name, rule_type, match_conditions, status } = req.body as any;
      // 规则名、类型必填;类型只能是黑名单或暗中观察这两种喵
      if (!name || !name.trim()) {
        return reply.status(400).send({ message: '请给规则起个名字喵' });
      }
      if (!['BLACKLIST', 'SHADOW', 'DRYRUN'].includes(rule_type)) {
        return reply.status(400).send({ message: '规则类型只能是 BLACKLIST、SHADOW 或 DRYRUN 喵' });
      }
      // match_conditions 是 JSON(比如 {"models":["xxx"],"keywords":["yyy"]}),存进去前转成字符串
      const conditionsJson = match_conditions ? JSON.stringify(match_conditions) : null;
      const finalStatus = status === 'DISABLE' ? 'DISABLE' : 'ENABLE';
      try {
        const [result]: any = await pool.query(
          'INSERT INTO Rules (name, rule_type, match_conditions, status) VALUES (?, ?, ?, ?)',
          [name.trim(), rule_type, conditionsJson, finalStatus]
        );
        await bustRulesCache();
        console.info(`[ADMIN][规则新增] 名称: ${name}, 类型: ${rule_type}, ID: ${result.insertId}`);
        return reply.send({ id: result.insertId, message: '安检规则已登记入册喵~' });
      } catch (error) {
        console.error('[ADMIN][规则新增] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // PUT /rules/:id - 修改规则(改完同样清缓存)
    protectedRoutes.put('/rules/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { name, rule_type, match_conditions, status } = req.body as any;
      if (rule_type !== undefined && !['BLACKLIST', 'SHADOW', 'DRYRUN'].includes(rule_type)) {
        return reply.status(400).send({ message: '规则类型只能是 BLACKLIST、SHADOW 或 DRYRUN 喵' });
      }
      if (status !== undefined && !['ENABLE', 'DISABLE'].includes(status)) {
        return reply.status(400).send({ message: '状态只能是 ENABLE 或 DISABLE 喵' });
      }
      try {
        // 只更新前端真正传来的字段(没传的保持原样),套路同 user.ts 的 Token 修改喵
        const updates: string[] = [];
        const params: any[] = [];
        if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
        if (rule_type !== undefined) { updates.push('rule_type = ?'); params.push(rule_type); }
        if (match_conditions !== undefined) {
          updates.push('match_conditions = ?');
          params.push(match_conditions ? JSON.stringify(match_conditions) : null);
        }
        if (status !== undefined) { updates.push('status = ?'); params.push(status); }
        if (updates.length === 0) {
          return reply.status(400).send({ message: '没有要更新的字段喵' });
        }
        params.push(id);
        const [result]: any = await pool.query(
          `UPDATE Rules SET ${updates.join(', ')} WHERE id = ?`, params
        );
        if (result.affectedRows === 0) {
          return reply.status(404).send({ message: '规则不存在' });
        }
        await bustRulesCache();
        console.info(`[ADMIN][规则修改] ID: ${id}`);
        return reply.send({ message: '规则修改成功喵~' });
      } catch (error) {
        console.error('[ADMIN][规则修改] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // DELETE /rules/:id - 删除规则(删完清缓存)
    protectedRoutes.delete('/rules/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const [result]: any = await pool.query('DELETE FROM Rules WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
          return reply.status(404).send({ message: '规则不存在' });
        }
        await bustRulesCache();
        console.info(`[ADMIN][规则删除] ID: ${id}`);
        return reply.send({ message: '安检规则已撤下喵~' });
      } catch (error) {
        console.error('[ADMIN][规则删除] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
});

    // ============ F.1.6 模型分组 ModelGroups CRUD ============
    // 思想:"我叫什么名字我自己知道,别人知道的是我告诉他的名字喵"
    // 渠道名(店长可见) → 分组菜单名(对外可见,user 在 SillyTavern 填的 model 字段)
    // 价格按"每 1M tokens 多少咖啡豆"接收人类可读值,后端 ×100000 存为整数

    // GET /model-groups - 分组列表(含挂载渠道数、已授权 user 数,admin 一眼看清)
    protectedRoutes.get('/model-groups', async (req, reply) => {
      try {
        const [rows]: any = await pool.query(`
          SELECT 
            g.id, g.name, g.description, g.prompt_price, g.completion_price,
            g.access_mode, g.status, g.created_at,
            (SELECT COUNT(*) FROM ModelGroupChannels WHERE group_id = g.id) AS channel_count,
            (SELECT COUNT(*) FROM ModelGroupGrants WHERE group_id = g.id) AS grant_count
          FROM ModelGroups g
          ORDER BY g.id DESC
          LIMIT 500
        `);
        // 价格还原成人类可读(豆/百万 tokens),前端展示更直观
        const items = rows.map((r: any) => ({
          ...r,
          prompt_price_real: Number(r.prompt_price) / 100000,
          completion_price_real: Number(r.completion_price) / 100000,
          channel_count: Number(r.channel_count),
          grant_count: Number(r.grant_count),
        }));
        console.info(`[ADMIN][分组列表] 共 ${rows.length} 个`);
        return reply.send({ items });
      } catch (error) {
        console.error('[ADMIN][分组列表] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // POST /model-groups - 新建分组
    protectedRoutes.post('/model-groups', async (req, reply) => {
      const { name, description, prompt_price, completion_price, access_mode, status } = req.body as any;
      if (!name || !name.trim()) {
        return reply.status(400).send({ message: '请给分组起个名字喵(就是 user 在 SillyTavern 填的 model 字段)' });
      }
      if (prompt_price === undefined || completion_price === undefined) {
        return reply.status(400).send({ message: '入价和出价必填喵(单位:豆/百万 tokens)' });
      }
      const promptInt = Math.round(Number(prompt_price) * 100000);
      const completionInt = Math.round(Number(completion_price) * 100000);
      if (!Number.isFinite(promptInt) || !Number.isFinite(completionInt) || promptInt < 0 || completionInt < 0) {
        return reply.status(400).send({ message: '价格必须是非负数字喵' });
      }
      const finalAccessMode = access_mode === 'PUBLIC' ? 'PUBLIC' : 'WHITELIST';
      const finalStatus = status === 'DISABLE' ? 'DISABLE' : 'ENABLE';
      try {
        // 重名提前查一下,给个温柔报错(避免依赖 MySQL UNIQUE 抛错喵)
        const [dup]: any = await pool.query('SELECT id FROM ModelGroups WHERE name = ?', [name.trim()]);
        if (dup.length > 0) {
          return reply.status(400).send({ message: `分组名「${name.trim()}」已经存在喵` });
        }
        const [result]: any = await pool.query(
          'INSERT INTO ModelGroups (name, description, prompt_price, completion_price, access_mode, status) VALUES (?, ?, ?, ?, ?, ?)',
          [name.trim(), description?.trim() || null, promptInt, completionInt, finalAccessMode, finalStatus]
        );
        await bustModelGroupsCache();
        console.info(`[ADMIN][分组新增] 名称: ${name}, ID: ${result.insertId}, 模式: ${finalAccessMode}`);
        return reply.send({ id: result.insertId, message: '分组已上架喵~' });
      } catch (error) {
        console.error('[ADMIN][分组新增] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // PUT /model-groups/:id - 修改分组(部分字段更新,套路同 Rules PUT)
    protectedRoutes.put('/model-groups/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { name, description, prompt_price, completion_price, access_mode, status } = req.body as any;
      if (access_mode !== undefined && !['PUBLIC', 'WHITELIST'].includes(access_mode)) {
        return reply.status(400).send({ message: 'access_mode 只能是 PUBLIC 或 WHITELIST 喵' });
      }
      if (status !== undefined && !['ENABLE', 'DISABLE'].includes(status)) {
        return reply.status(400).send({ message: 'status 只能是 ENABLE 或 DISABLE 喵' });
      }
      try {
        const updates: string[] = [];
        const params: any[] = [];
        if (name !== undefined) {
          if (!name.trim()) {
            return reply.status(400).send({ message: '分组名不能改成空喵' });
          }
          // 改名要查重(排除自己)
          const [dup]: any = await pool.query('SELECT id FROM ModelGroups WHERE name = ? AND id <> ?', [name.trim(), id]);
          if (dup.length > 0) {
            return reply.status(400).send({ message: `分组名「${name.trim()}」已经存在喵` });
          }
          updates.push('name = ?');
          params.push(name.trim());
        }
        if (description !== undefined) {
          updates.push('description = ?');
          params.push(description?.trim() || null);
        }
        if (prompt_price !== undefined) {
          const v = Math.round(Number(prompt_price) * 100000);
          if (!Number.isFinite(v) || v < 0) {
            return reply.status(400).send({ message: '入价必须是非负数字喵' });
          }
          updates.push('prompt_price = ?');
          params.push(v);
        }
        if (completion_price !== undefined) {
          const v = Math.round(Number(completion_price) * 100000);
          if (!Number.isFinite(v) || v < 0) {
            return reply.status(400).send({ message: '出价必须是非负数字喵' });
          }
          updates.push('completion_price = ?');
          params.push(v);
        }
        if (access_mode !== undefined) { updates.push('access_mode = ?'); params.push(access_mode); }
        if (status !== undefined) { updates.push('status = ?'); params.push(status); }
        if (updates.length === 0) {
          return reply.status(400).send({ message: '没有要更新的字段喵' });
        }
        params.push(id);
        const [result]: any = await pool.query(
          `UPDATE ModelGroups SET ${updates.join(', ')} WHERE id = ?`, params
        );
        if (result.affectedRows === 0) {
          return reply.status(404).send({ message: '分组不存在喵' });
        }
        await bustModelGroupsCache();
        console.info(`[ADMIN][分组修改] ID: ${id}`);
        return reply.send({ message: '分组修改成功喵~' });
      } catch (error) {
        console.error('[ADMIN][分组修改] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // DELETE /model-groups/:id - 删除分组(级联清理组内挂载和授权,防止留孤儿)
    protectedRoutes.delete('/model-groups/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        // 级联清理:先清子表,再删主表,事务保证同生共死喵
        await connection.query('DELETE FROM ModelGroupChannels WHERE group_id = ?', [id]);
        await connection.query('DELETE FROM ModelGroupGrants WHERE group_id = ?', [id]);
        const [result]: any = await connection.query('DELETE FROM ModelGroups WHERE id = ?', [id]);
        if (result.affectedRows === 0) {
          await connection.rollback();
          return reply.status(404).send({ message: '分组不存在喵' });
        }
        await connection.commit();
        await bustModelGroupsCache();
        console.info(`[ADMIN][分组删除] ID: ${id} (含级联清理组内挂载/授权)`);
        return reply.send({ message: '分组已下架喵~' });
      } catch (error) {
        await connection.rollback();
        console.error('[ADMIN][分组删除] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      } finally {
        connection.release();
      }
    });


    // ============ F.1.6 组内渠道挂载 ModelGroupChannels CRUD ============
    // 一条渠道可以同时进多个分组(允许),每个(分组,渠道,真模型名)组合唯一
    // real_model_name:这条渠道在这个分组下转发给上游时用的真实模型名

    // GET /model-groups/:groupId/channels - 列出某分组挂的所有渠道
    protectedRoutes.get('/model-groups/:groupId/channels', async (req, reply) => {
      const { groupId } = req.params as { groupId: string };
      try {
        const [rows]: any = await pool.query(`
          SELECT 
            mgc.id, mgc.group_id, mgc.channel_id, mgc.real_model_name, mgc.weight, mgc.status, mgc.created_at,
            c.name AS channel_name, c.base_url AS channel_base_url, c.status AS channel_status
          FROM ModelGroupChannels mgc
          LEFT JOIN Channels c ON c.id = mgc.channel_id
          WHERE mgc.group_id = ?
          ORDER BY mgc.id DESC
          LIMIT 500
        `, [groupId]);
        console.info(`[ADMIN][分组渠道] 分组 ${groupId} 挂载渠道 ${rows.length} 条`);
        return reply.send({ items: rows });
      } catch (error) {
        console.error('[ADMIN][分组渠道] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // POST /model-groups/:groupId/channels - 给分组挂一条渠道
    protectedRoutes.post('/model-groups/:groupId/channels', async (req, reply) => {
      const { groupId } = req.params as { groupId: string };
      const { channel_id, real_model_name, weight, status } = req.body as any;
      if (!channel_id || !real_model_name || !String(real_model_name).trim()) {
        return reply.status(400).send({ message: '渠道 ID 和真模型名必填喵' });
      }
      try {
        // 1. 验证分组存在
        const [grp]: any = await pool.query('SELECT id FROM ModelGroups WHERE id = ?', [groupId]);
        if (grp.length === 0) {
          return reply.status(404).send({ message: '分组不存在喵' });
        }
        // 2. 验证渠道存在
        const [ch]: any = await pool.query('SELECT id FROM Channels WHERE id = ?', [channel_id]);
        if (ch.length === 0) {
          return reply.status(400).send({ message: `渠道 ID ${channel_id} 不存在喵` });
        }
        // 3. 提前查重(group_id + channel_id + real_model_name 三元组唯一)
        const realName = String(real_model_name).trim();
        const [dup]: any = await pool.query(
          'SELECT id FROM ModelGroupChannels WHERE group_id = ? AND channel_id = ? AND real_model_name = ?',
          [groupId, channel_id, realName]
        );
        if (dup.length > 0) {
          return reply.status(400).send({ message: '这条渠道+真模型名已经挂在这个分组下了喵' });
        }
        const finalWeight = Math.max(1, Number(weight) || 1);
        const finalStatus = status === 'DISABLE' ? 'DISABLE' : 'ENABLE';
        const [result]: any = await pool.query(
          'INSERT INTO ModelGroupChannels (group_id, channel_id, real_model_name, weight, status) VALUES (?, ?, ?, ?, ?)',
          [groupId, channel_id, realName, finalWeight, finalStatus]
        );
        await bustModelGroupsCache();
        console.info(`[ADMIN][分组挂渠道] 分组 ${groupId} 挂上渠道 ${channel_id} (真模型: ${realName}, w=${finalWeight})`);
        return reply.send({ id: result.insertId, message: '渠道挂上书架喵~' });
      } catch (error) {
        console.error('[ADMIN][分组挂渠道] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // PUT /model-groups/:groupId/channels/:linkId - 修改组内挂载关系(部分字段更新)
    protectedRoutes.put('/model-groups/:groupId/channels/:linkId', async (req, reply) => {
      const { groupId, linkId } = req.params as { groupId: string; linkId: string };
      const { real_model_name, weight, status } = req.body as any;
      if (status !== undefined && !['ENABLE', 'DISABLE'].includes(status)) {
        return reply.status(400).send({ message: 'status 只能是 ENABLE 或 DISABLE 喵' });
      }
      try {
        const updates: string[] = [];
        const params: any[] = [];
        if (real_model_name !== undefined) {
          const realName = String(real_model_name).trim();
          if (!realName) {
            return reply.status(400).send({ message: '真模型名不能改成空喵' });
          }
          // 改真模型名要在本分组内查重(排除自己)
          const [curRow]: any = await pool.query(
            'SELECT channel_id FROM ModelGroupChannels WHERE id = ? AND group_id = ?',
            [linkId, groupId]
          );
          if (curRow.length === 0) {
            return reply.status(404).send({ message: '这条挂载关系不存在喵' });
          }
          const [dup]: any = await pool.query(
            'SELECT id FROM ModelGroupChannels WHERE group_id = ? AND channel_id = ? AND real_model_name = ? AND id <> ?',
            [groupId, curRow[0].channel_id, realName, linkId]
          );
          if (dup.length > 0) {
            return reply.status(400).send({ message: '同一渠道+真模型名在本分组下已经挂过了喵' });
          }
          updates.push('real_model_name = ?');
          params.push(realName);
        }
        if (weight !== undefined) {
          const w = Math.max(1, Number(weight) || 1);
          updates.push('weight = ?');
          params.push(w);
        }
        if (status !== undefined) { updates.push('status = ?'); params.push(status); }
        if (updates.length === 0) {
          return reply.status(400).send({ message: '没有要更新的字段喵' });
        }
        params.push(linkId, groupId);
        const [result]: any = await pool.query(
          `UPDATE ModelGroupChannels SET ${updates.join(', ')} WHERE id = ? AND group_id = ?`, params
        );
        if (result.affectedRows === 0) {
          return reply.status(404).send({ message: '这条挂载关系不存在喵' });
        }
        await bustModelGroupsCache();
        console.info(`[ADMIN][分组渠道改] 分组 ${groupId} 的挂载 ${linkId}`);
        return reply.send({ message: '挂载关系修改成功喵~' });
      } catch (error) {
        console.error('[ADMIN][分组渠道改] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // DELETE /model-groups/:groupId/channels/:linkId - 卸下组内挂载关系
    protectedRoutes.delete('/model-groups/:groupId/channels/:linkId', async (req, reply) => {
      const { groupId, linkId } = req.params as { groupId: string; linkId: string };
      try {
        const [result]: any = await pool.query(
          'DELETE FROM ModelGroupChannels WHERE id = ? AND group_id = ?',
          [linkId, groupId]
        );
        if (result.affectedRows === 0) {
          return reply.status(404).send({ message: '这条挂载关系不存在喵' });
        }
        await bustModelGroupsCache();
        console.info(`[ADMIN][分组卸渠道] 分组 ${groupId} 卸下挂载 ${linkId}`);
        return reply.send({ message: '挂载已卸下喵~' });
      } catch (error) {
        console.error('[ADMIN][分组卸渠道] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });


    // ============ F.1.6 分组授权 ModelGroupGrants CRUD ============
    // 仅 WHITELIST 模式的分组靠这张表决定谁能用;PUBLIC 模式分组不需要登记授权

    // GET /model-groups/:groupId/grants - 列出某分组已授权的所有 user
    protectedRoutes.get('/model-groups/:groupId/grants', async (req, reply) => {
      const { groupId } = req.params as { groupId: string };
      try {
        const [rows]: any = await pool.query(`
          SELECT mg.user_id, mg.granted_at, u.email AS user_email, u.remark AS user_remark
          FROM ModelGroupGrants mg
          LEFT JOIN Users u ON u.id = mg.user_id
          WHERE mg.group_id = ?
          ORDER BY mg.granted_at DESC
          LIMIT 1000
        `, [groupId]);
        console.info(`[ADMIN][分组授权列表] 分组 ${groupId} 已授权 ${rows.length} 人`);
        return reply.send({ items: rows });
      } catch (error) {
        console.error('[ADMIN][分组授权列表] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // POST /model-groups/:groupId/grants - 授权 user(支持单个或批量)
    protectedRoutes.post('/model-groups/:groupId/grants', async (req, reply) => {
      const { groupId } = req.params as { groupId: string };
      const { user_id, user_ids } = req.body as { user_id?: number; user_ids?: number[] };
      // 兼容两种入参:单个 user_id 或批量 user_ids
      const targetIds = Array.isArray(user_ids) && user_ids.length > 0
        ? user_ids.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0)
        : (user_id ? [Number(user_id)] : []);
      if (targetIds.length === 0) {
        return reply.status(400).send({ message: '请指定要授权的 user_id 喵' });
      }
      try {
        // 1. 验证分组存在
        const [grp]: any = await pool.query('SELECT id FROM ModelGroups WHERE id = ?', [groupId]);
        if (grp.length === 0) {
          return reply.status(404).send({ message: '分组不存在喵' });
        }
        // 2. 验证 user 全部在册(一次查询确认)
        const [users]: any = await pool.query(
          `SELECT id FROM Users WHERE id IN (${targetIds.map(() => '?').join(',')})`,
          targetIds
        );
        const validIds = new Set(users.map((u: any) => Number(u.id)));
        const missing = targetIds.filter((id) => !validIds.has(id));
        if (missing.length > 0) {
          return reply.status(400).send({ message: `这些 user_id 不在常客名册:${missing.join(', ')}` });
        }
        // 3. INSERT IGNORE 让重复授权幂等(主键冲突跳过,不报错)
        const values = targetIds.map(() => '(?, ?)').join(',');
        const params: any[] = [];
        targetIds.forEach((uid) => params.push(groupId, uid));
        const [result]: any = await pool.query(
          `INSERT IGNORE INTO ModelGroupGrants (group_id, user_id) VALUES ${values}`,
          params
        );
        await bustModelGroupsCache();
        console.info(`[ADMIN][分组授权] 分组 ${groupId} 授权 user: ${targetIds.join(',')} (实际新增 ${result.affectedRows} 条)`);
        return reply.send({
          message: result.affectedRows === targetIds.length
            ? `授权成功喵~(${result.affectedRows} 人)`
            : `授权完成喵~(新增 ${result.affectedRows} 人,其余已有授权跳过)`,
          inserted: result.affectedRows,
        });
      } catch (error) {
        console.error('[ADMIN][分组授权] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // DELETE /model-groups/:groupId/grants/:userId - 撤销某 user 在某分组的授权
    protectedRoutes.delete('/model-groups/:groupId/grants/:userId', async (req, reply) => {
      const { groupId, userId } = req.params as { groupId: string; userId: string };
      try {
        const [result]: any = await pool.query(
          'DELETE FROM ModelGroupGrants WHERE group_id = ? AND user_id = ?',
          [groupId, userId]
        );
        if (result.affectedRows === 0) {
          return reply.status(404).send({ message: '该用户在此分组没有授权记录喵' });
        }
        await bustModelGroupsCache();
        console.info(`[ADMIN][分组撤权] 撤销 user ${userId} 在分组 ${groupId} 的授权`);
        return reply.send({ message: '已撤销授权喵~' });
      } catch (error) {
        console.error('[ADMIN][分组撤权] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // GET /users/:id/model-groups - 反查某 user 拿到了哪些分组授权(给 Users.tsx 用)
    protectedRoutes.get('/users/:id/model-groups', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const [rows]: any = await pool.query(`
          SELECT g.id AS group_id, g.name AS group_name, g.access_mode, g.status, mg.granted_at
          FROM ModelGroupGrants mg
          JOIN ModelGroups g ON g.id = mg.group_id
          WHERE mg.user_id = ?
          ORDER BY mg.granted_at DESC
          LIMIT 500
        `, [id]);
        console.info(`[ADMIN][用户分组反查] user ${id} 已授权 ${rows.length} 个分组`);
        return reply.send({ items: rows });
      } catch (error) {
        console.error('[ADMIN][用户分组反查] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // ============ E.3.3 吧台安检区:Dry-Run 审批接口 ============

    // GET /dry-run/pending - 店长面前的待裁决订单列表
    protectedRoutes.get('/dry-run/pending', async (req, reply) => {
      try {
        // T-1: KEYS → SCAN 游标(避免 O(N) 阻塞 Redis)
        // 单次 COUNT=200, 累计上限 MAX_ITEMS=500(店长一屏看不过 500 单)
        const MAX_ITEMS = 500;
        const SCAN_COUNT = 200;
        const keys: string[] = [];
        let cursor = '0';
        let scanLoops = 0;
        do {
          // ioredis: scan 返回 [next_cursor, keys[]]
          const [next, batch] = await redis.scan(cursor, 'MATCH', 'gateway:dryrun:trace:*', 'COUNT', SCAN_COUNT);
          keys.push(...batch);
          cursor = next;
          scanLoops++;
          if (keys.length >= MAX_ITEMS) break; // 达到上限提前退出
          if (scanLoops > 100) break;          // 防 SCAN 因极端模式跑无限轮(双保险)
        } while (cursor !== '0');

        // 截断到 MAX_ITEMS,再去 GET 内容(防多读 + 防超时)
        const limitedKeys = keys.slice(0, MAX_ITEMS);
        const items: any[] = [];
        for (const key of limitedKeys) {
          const raw = await redis.get(key);
          if (!raw) continue; // 拿列表的瞬间刚好过期了,跳过
          try { items.push(JSON.parse(raw)); } catch { /* 坏档案跳过 */ }
        }
        // 先到的订单排前面,店长按顺序裁决喵
        items.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
        const truncated = keys.length >= MAX_ITEMS;
        console.info(`[ADMIN][安检区] 当前待裁决订单 ${items.length} 单${truncated ? `(已截至 ${MAX_ITEMS} 单上限)` : ''}, SCAN 轮数 ${scanLoops}`);
        return reply.send({ items, truncated });
      } catch (error) {
        console.error('[ADMIN][安检区] 错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // POST /dry-run/approve - 放行(可附带 override_body"加点糖"改配方)
    protectedRoutes.post('/dry-run/approve', async (req, reply) => {
      const { trace_id, override_body } = req.body as { trace_id?: string; override_body?: any };
      if (!trace_id) return reply.status(400).send({ message: '缺少 trace_id 喵' });

      const lockKey = `gateway:dryrun:lock:${trace_id}`;
      try {
        // 分布式审批锁:谁先抢到谁裁决,防止两位店长同时放行导致一单发两次喵
        const lock = await redis.set(lockKey, req.adminUser?.email || 'admin', 'PX', 3000, 'NX');
        if (!lock) {
          return reply.status(409).send({ message: '另一位店长正在处理这单,稍等喵' });
        }

        // 订单必须还在暂存区(没过期、没被裁决过)才能放行
        const exists = await redis.exists(`gateway:dryrun:trace:${trace_id}`);
        if (!exists) {
          await redis.del(lockKey);
          return reply.status(404).send({ message: '这单已过期或已被裁决,找不到了喵' });
        }

        const verdict: any = { action: 'approve' };
        if (override_body && typeof override_body === 'object') {
          verdict.override_body = override_body;
        }
        // 裁决投进信箱,挂起的请求 1 秒内会来取走;30秒没人取(网关重启了)就自动作废
        await redis.set(`gateway:dryrun:verdict:${trace_id}`, JSON.stringify(verdict), 'EX', 30);
        await redis.del(lockKey);

        console.info(`[ADMIN][安检裁决] ${req.adminUser?.email} 放行订单 ${trace_id}${verdict.override_body ? '(加糖改配方)' : ''}`);
        return reply.send({ message: verdict.override_body ? '加点糖端上桌喵~' : '原样端上桌喵~' });
      } catch (error) {
        console.error('[ADMIN][安检裁决] 放行错误:', error);
        await redis.del(lockKey);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // POST /dry-run/reject - 拒绝(配方危险倒掉喵)
    protectedRoutes.post('/dry-run/reject', async (req, reply) => {
      const { trace_id } = req.body as { trace_id?: string };
      if (!trace_id) return reply.status(400).send({ message: '缺少 trace_id 喵' });

      const lockKey = `gateway:dryrun:lock:${trace_id}`;
      try {
        const lock = await redis.set(lockKey, req.adminUser?.email || 'admin', 'PX', 3000, 'NX');
        if (!lock) {
          return reply.status(409).send({ message: '另一位店长正在处理这单,稍等喵' });
        }
        const exists = await redis.exists(`gateway:dryrun:trace:${trace_id}`);
        if (!exists) {
          await redis.del(lockKey);
          return reply.status(404).send({ message: '这单已过期或已被裁决,找不到了喵' });
        }
        await redis.set(`gateway:dryrun:verdict:${trace_id}`, JSON.stringify({ action: 'reject' }), 'EX', 30);
        await redis.del(lockKey);

        console.info(`[ADMIN][安检裁决] ${req.adminUser?.email} 拒绝订单 ${trace_id}`);
        return reply.send({ message: '配方危险,已倒掉喵' });
      } catch (error) {
        console.error('[ADMIN][安检裁决] 拒绝错误:', error);
        await redis.del(lockKey);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // ============ F.5 SystemSettings(超管端 "送信小猫的窝" 总闸 + 货架配置) ============

    // GET /settings - 列出所有系统配置(给前端 Settings 页用)
    protectedRoutes.get('/settings', async (req, reply) => {
      try {
        const items = listSettings();
        console.info(`[ADMIN][系统配置] 查询, 共 ${items.length} 条`);
        return reply.send({ items });
      } catch (error) {
        console.error('[ADMIN][系统配置] 查询错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // PATCH /settings - 修改某项配置(写 MySQL + 同步刷新进程内 cache)
    //   已识别 key 做范围校验, 未知 key 暂不放行(防误写)
    //     - debug_cache_enabled: 'true' | 'false' (F.5 admin 总闸)
    //     - debug_cache_per_user_max_mb: 1-1024 之间的整数 (每用户货架字节上限, MB)
    //     - global_rpm_limit:    1-1000 之间的整数 (S1+ 全站每用户每分钟 RPM 上限)
    //     - blacklist_rpm_limit: 1-1000 之间的整数 (S1+ 拉黑账号每用户每分钟 RPM 上限)
    //     - checkin_enabled:        'true' | 'false' (F6 签到系统总开关)
    //     - checkin_reward_amount:  0-100000 之间的整数 (F6 每日签到奖励豆数, 人类可读豆数)
    protectedRoutes.patch('/settings', async (req, reply) => {
      const { key, value } = req.body as { key?: string; value?: string };
      if (!key || value === undefined || value === null) {
        return reply.status(400).send({ message: 'key 和 value 都不能为空喵' });
      }
      const valueStr = String(value);

      if (key === 'debug_cache_enabled') {
        if (valueStr !== 'true' && valueStr !== 'false') {
          return reply.status(400).send({ message: 'debug_cache_enabled 只能是 true 或 false 喵' });
        }
      } else if (key === 'debug_cache_per_user_max_mb') {
        const n = parseInt(valueStr, 10);
        if (!Number.isFinite(n) || n < 1 || n > 1024) {
          return reply.status(400).send({ message: 'debug_cache_per_user_max_mb 必须是 1-1024 之间的整数喵' });
        }
      } else if (key === 'global_rpm_limit') {
        // S1+: 全站每用户每分钟请求上限(默认 5, 范围 1-1000)
        const n = parseInt(valueStr, 10);
        if (!Number.isFinite(n) || n < 1 || n > 1000) {
          return reply.status(400).send({ message: 'global_rpm_limit 必须是 1-1000 之间的整数喵' });
        }
      } else if (key === 'blacklist_rpm_limit') {
        // S1+: 拉黑账号每用户每分钟请求上限(默认 2, 范围 1-1000)
        const n = parseInt(valueStr, 10);
        if (!Number.isFinite(n) || n < 1 || n > 1000) {
          return reply.status(400).send({ message: 'blacklist_rpm_limit 必须是 1-1000 之间的整数喵' });
        }
      } else if (key === 'checkin_enabled') {
        // F6: 签到系统总开关
        if (valueStr !== 'true' && valueStr !== 'false') {
          return reply.status(400).send({ message: 'checkin_enabled 只能是 true 或 false 喵' });
        }
      } else if (key === 'checkin_reward_amount') {
        // F6: 每日签到奖励豆数(人类可读豆数, 0-100000 的整数; 入账前 ×100000)
        const n = parseInt(valueStr, 10);
        if (!Number.isFinite(n) || n < 0 || n > 100000) {
          return reply.status(400).send({ message: 'checkin_reward_amount 必须是 0-100000 之间的整数喵' });
        }
      } else {
        return reply.status(400).send({ message: `未知的配置项 key: ${key}` });
      }

      try {
        await updateSetting(key, valueStr);
        console.info(`[ADMIN][系统配置] ${req.adminUser?.email} 修改 ${key} = ${valueStr}`);
        return reply.send({ message: '配置已更新喵~' });
      } catch (error) {
        console.error('[ADMIN][系统配置] 更新错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // ============ F7 公告栏(店长发布、客人只读)============

    // GET /announcements - 列出所有公告(含下架, 给 admin 管理用)
    protectedRoutes.get('/announcements', async (req, reply) => {
      try {
        const [rows]: any = await pool.query(
          'SELECT id, title, content, status, created_at, updated_at FROM Announcements ORDER BY created_at DESC LIMIT 500'
        );
        console.info(`[ADMIN][公告] 列表, 共 ${rows.length} 条`);
        return reply.send({ items: rows });
      } catch (error) {
        console.error('[ADMIN][公告] 列表错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // POST /announcements - 新建公告
    protectedRoutes.post('/announcements', async (req, reply) => {
      const { title, content, status } = req.body as { title?: string; content?: string; status?: string };
      if (!title || !title.trim()) return reply.status(400).send({ message: '标题不能为空喵' });
      if (!content || !content.trim()) return reply.status(400).send({ message: '正文不能为空喵' });
      const st = status === 'DISABLE' ? 'DISABLE' : 'ENABLE';
      try {
        const [res]: any = await pool.query(
          'INSERT INTO Announcements (title, content, status) VALUES (?, ?, ?)',
          [title.trim(), content, st]
        );
        console.info(`[ADMIN][公告] 新建 id=${res.insertId} by ${req.adminUser?.email}`);
        return reply.send({ message: '公告已发布喵~', id: res.insertId });
      } catch (error) {
        console.error('[ADMIN][公告] 新建错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // PATCH /announcements/:id - 改标题/正文/上下架(传什么改什么)
    protectedRoutes.patch('/announcements/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const { title, content, status } = req.body as { title?: string; content?: string; status?: string };
      const sets: string[] = [];
      const params: any[] = [];
      if (typeof title === 'string') {
        if (!title.trim()) return reply.status(400).send({ message: '标题不能为空喵' });
        sets.push('title = ?'); params.push(title.trim());
      }
      if (typeof content === 'string') {
        if (!content.trim()) return reply.status(400).send({ message: '正文不能为空喵' });
        sets.push('content = ?'); params.push(content);
      }
      if (typeof status === 'string') {
        if (status !== 'ENABLE' && status !== 'DISABLE') {
          return reply.status(400).send({ message: 'status 只能是 ENABLE 或 DISABLE 喵' });
        }
        sets.push('status = ?'); params.push(status);
      }
      if (sets.length === 0) {
        return reply.status(400).send({ message: '没有要更新的字段喵' });
      }
      try {
        params.push(id);
        const [res]: any = await pool.query(
          `UPDATE Announcements SET ${sets.join(', ')} WHERE id = ?`,
          params
        );
        if (res.affectedRows === 0) {
          return reply.status(404).send({ message: '公告不存在喵' });
        }
        console.info(`[ADMIN][公告] 更新 id=${id} by ${req.adminUser?.email}`);
        return reply.send({ message: '公告已更新喵~' });
      } catch (error) {
        console.error('[ADMIN][公告] 更新错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });

    // DELETE /announcements/:id - 删除公告(硬删)
    protectedRoutes.delete('/announcements/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const [res]: any = await pool.query('DELETE FROM Announcements WHERE id = ?', [id]);
        if (res.affectedRows === 0) {
          return reply.status(404).send({ message: '公告不存在喵' });
        }
        console.info(`[ADMIN][公告] 删除 id=${id} by ${req.adminUser?.email}`);
        return reply.send({ message: '公告已删除喵~' });
      } catch (error) {
        console.error('[ADMIN][公告] 删除错误:', error);
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    });
  });
}
