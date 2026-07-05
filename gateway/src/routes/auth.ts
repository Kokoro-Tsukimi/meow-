import { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db';
import { redis } from '../redis';
import { sendVerifyCode, sendPasswordResetCode } from '../mailer';
import {
  checkLoginAttempt,
  recordLoginFailure,
  resetLoginAttempts,
  getClientIp,
} from '../middleware/rateLimit';

// F.1b: 邮箱验证码的 Redis key 规约
const VERIFY_CODE_PREFIX = 'gateway:verify:email:';     // 验证码本体,TTL 10分钟
const VERIFY_COOLDOWN_PREFIX = 'gateway:verify:cooldown:'; // 发送冷却,60秒内不许重发(防轰炸喵)

export default async function authRoutes(fastify: FastifyInstance) {

  // POST /send-verify-code - 发送注册验证码 (F.1b)
  fastify.post('/send-verify-code', async (req, reply) => {
    const { email } = req.body as any;

    if (!email || !/^\S+@\S+\.\S+$/.test(String(email).trim())) {
      return reply.status(400).send({ message: '请填写正确的邮箱喵' });
    }
    const emailTrimmed = String(email).trim();

    try {
      // 已注册的邮箱没必要发码,早点告诉客人喵
      const [rows]: any = await pool.query('SELECT id FROM Users WHERE email = ?', [emailTrimmed]);
      if (rows.length > 0) {
        return reply.status(400).send({ message: '该邮箱已被注册' });
      }

      // 60秒发送冷却:NX 抢不到说明刚发过
      const cooldownKey = VERIFY_COOLDOWN_PREFIX + emailTrimmed;
      const cooldownLock = await redis.set(cooldownKey, '1', 'EX', 60, 'NX');
      if (!cooldownLock) {
        return reply.status(429).send({ message: '验证码刚寄出去不久,请稍等一分钟再试喵' });
      }

      // 6位数字验证码,存10分钟(后发的覆盖先发的,只认最新一张喵)
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await redis.set(VERIFY_CODE_PREFIX + emailTrimmed, code, 'EX', 600);

      try {
        await sendVerifyCode(emailTrimmed, code);
      } catch (mailErr: any) {
        // 信没寄出去:撤掉冷却让客人能立刻重试,验证码留着也无害(10分钟自动过期)
        await redis.del(cooldownKey);
        console.error(`[AUTH][发码] 寄信失败: ${emailTrimmed}`, mailErr.message || mailErr);
        return reply.status(500).send({ message: '信使猫迷路了,验证码没寄出去,请稍后再试喵' });
      }

      console.info(`[AUTH][发码] 验证码已发往 ${emailTrimmed}`);
      return reply.send({ message: '验证码已寄出,请查收邮箱喵~(也看看垃圾箱,信使猫有时会被当可疑分子)' });
    } catch (error) {
      console.error('[AUTH][发码] 发生错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });
  fastify.post('/register', async (req, reply) => {
    const { email, password, invite_code } = req.body as any;

    if (!email || !password) {
      return reply.status(400).send({ message: '邮箱和密码不能为空' });
    }
    const emailTrimmed = String(email).trim();
    if (!/^\S+@\S+\.\S+$/.test(emailTrimmed)) {
      return reply.status(400).send({ message: '邮箱格式看起来不太对喵' });
    }
    if (String(password).length < 4) {
      return reply.status(400).send({ message: '密码至少4位喵' });
    }

    // ============ 通道A: 带邀请码注册 (F.1a) ============
    // 建号 + 核销CDK + 入账 + 记流水,全程一个事务;
    // 锁和核销套路与 routes/user.ts 的 /topup/redeem 完全同款(防并发刷码)喵
    if (invite_code && String(invite_code).trim()) {
      const code = String(invite_code).trim();
      const lockKey = `gateway:lock:cdk:${code}`;

      try {
        // 先做不需要锁的快速检查:邮箱占用
        const [dupRows]: any = await pool.query('SELECT id FROM Users WHERE email = ?', [emailTrimmed]);
        if (dupRows.length > 0) {
          return reply.status(400).send({ message: '该邮箱已被注册' });
        }

        const lock = await redis.set(lockKey, '1', 'EX', 10, 'NX');
        if (!lock) {
          return reply.status(400).send({ message: '邀请码正在处理中，请稍后再试' });
        }

        const [codeRows]: any = await pool.query(
          'SELECT id, amount FROM RedeemCodes WHERE code = ? AND status = "UNUSED"', [code]
        );
        if (codeRows.length === 0) {
          await redis.del(lockKey);
          return reply.status(404).send({ message: '邀请码无效或已被使用喵' });
        }
        const { amount } = codeRows[0];
        const amountInt = Math.round(Number(amount));

        const passwordHash = await bcrypt.hash(password, 10);
        const connection = await pool.getConnection();
        let newUserId: number;

        try {
          await connection.beginTransaction();

          // ① 建号(放进事务:核销失败时连人一起回滚,不留半成品账号喵)
          const [insertRes]: any = await connection.query(
            'INSERT INTO Users (email, password_hash, balance, status, group_id) VALUES (?, ?, ?, ?, ?)',
            [emailTrimmed, passwordHash, amountInt, 'ACTIVE', 1]
          );
          newUserId = insertRes.insertId;

          // ② 乐观锁核销CDK(affectedRows=0 说明被并发抢走,整体回滚)
          const [updateCodeRes]: any = await connection.query(
            'UPDATE RedeemCodes SET status = "USED", used_by = ?, used_at = NOW() WHERE code = ? AND status = "UNUSED"',
            [newUserId, code]
          );
          if (updateCodeRes.affectedRows === 0) {
            await connection.rollback();
            await redis.del(lockKey);
            return reply.status(400).send({ message: '邀请码已被使用喵' });
          }

          // ③ 记开户流水(reference_id=码本身,Bills唯一索引天然防重)
          await connection.query(
            'INSERT INTO Bills (user_id, type, amount, reference_id, model) VALUES (?, ?, ?, ?, ?)',
            [newUserId, 'TOPUP', amountInt, code, 'invite_register']
          );

          await connection.commit();
        } catch (txError) {
          await connection.rollback();
          throw txError;
        } finally {
          connection.release();
        }

        // ④ 初始化 Redis 余额 = CDK面额(事务成功后才写缓存)
        await redis.set(`gateway:user:balance:${newUserId}`, amountInt);
        await redis.del(lockKey);

        console.info(`[AUTH][邀请注册] 新用户: ${emailTrimmed}, code: ${code}, 开户豆: ${amountInt / 100000}`);
        return reply.send({
          message: `凭邀请函入册成功！开户咖啡豆 ${amountInt / 100000} 颗已到账，欢迎来到喵咖书店~`,
          welcome_beans: amountInt / 100000,
        });
      } catch (error) {
        console.error('[AUTH][邀请注册] 发生错误:', error);
        await redis.del(lockKey).catch(() => {});
        return reply.status(500).send({ message: '内部服务器错误' });
      }
    }

    // ============ 通道B: 邮箱验证码注册 (F.1b 起,无邀请码必须验邮箱喵) ============
    try {
      const { verify_code } = req.body as any;
      if (!verify_code || !String(verify_code).trim()) {
        return reply.status(400).send({ message: '请填写邮箱验证码(或改用邀请函CDK注册)喵' });
      }

      const storedCode = await redis.get(VERIFY_CODE_PREFIX + emailTrimmed);
      if (!storedCode || storedCode !== String(verify_code).trim()) {
        return reply.status(400).send({ message: '验证码错误或已过期喵' });
      }
      // 验证通过即焚,一码只能用一次
      await redis.del(VERIFY_CODE_PREFIX + emailTrimmed);

      const [rows]: any = await pool.query('SELECT id FROM Users WHERE email = ?', [emailTrimmed]);
      if (rows.length > 0) {
        return reply.status(400).send({ message: '该邮箱已被注册' });
      }

      const passwordHash = await bcrypt.hash(password, 10);
      
      const [result]: any = await pool.query(
        'INSERT INTO Users (email, password_hash, balance, status, group_id) VALUES (?, ?, ?, ?, ?)',
        [emailTrimmed, passwordHash, 0, 'ACTIVE', 1]
      );

      const newUserId = result.insertId;

      // 初始化 Redis 余额
      await redis.set(`gateway:user:balance:${newUserId}`, 0);

      console.info(`[AUTH][注册] 新用户: ${emailTrimmed}`);
      return reply.send({ message: '注册成功，欢迎来到喵咖书店~' });
    } catch (error) {
      console.error('[AUTH][注册] 发生错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  fastify.post('/login', async (req, reply) => {
    const { email, password } = req.body as any;

    if (!email || !password) {
      return reply.status(400).send({ message: '邮箱和密码不能为空' });
    }

    // S1.前哨:登录限流 check(email + IP 双维度,任一锁定即拦截)
    const emailTrimmed = String(email).trim();
    const clientIp = getClientIp(req);
    const lockCheck = await checkLoginAttempt('user_login', emailTrimmed, clientIp);
    if (lockCheck.locked) {
      const mins = Math.ceil(lockCheck.info / 60);
      const dimMsg = lockCheck.lockedDimension === 'ip'
        ? '此网络登录尝试过多'
        : '该账号登录失败次数过多';
      console.warn(`[AUTH][登录限流] 拒绝 email=${emailTrimmed} ip=${clientIp} 维度=${lockCheck.lockedDimension} 剩余=${lockCheck.info}秒`);
      return reply.status(429).send({
        message: `${dimMsg},请 ${mins} 分钟后再试喵~(找回密码可立即解锁)`,
      });
    }

    try {
      const [rows]: any = await pool.query(
        'SELECT id, email, password_hash, balance, status FROM Users WHERE email = ?',
        [emailTrimmed]
      );

      if (rows.length === 0) {
        // 用户不存在也计入失败:防字典枚举喵
        await recordLoginFailure('user_login', emailTrimmed, clientIp);
        return reply.status(401).send({ message: '账号或密码错误' });
      }

      const user = rows[0];

      // S1+(2026-06-23): BANNED-only 拒登录, ARREARS/BLACKLIST 允许登录
      //   - BANNED:     违规账号拒之门外
      //   - ARREARS:    欠费允许登录(用户进店看见自己欠费, 然后充值; 数据面靠余额=0 拦)
      //   - BLACKLIST:  拉黑允许登录(用 API 但 RPM 降级; 拒福利)
      //   不算密码错误, 不计入失败次数
      if (user.status === 'BANNED') {
        return reply.status(403).send({ message: '账号已被禁用' });
      }

      const isMatch = await bcrypt.compare(password, user.password_hash);
      if (!isMatch) {
        const failRes = await recordLoginFailure('user_login', emailTrimmed, clientIp);
        if (failRes.locked) {
          const mins = Math.ceil(failRes.info / 60);
          return reply.status(429).send({
            message: `登录失败次数过多,请 ${mins} 分钟后再试喵~(找回密码可立即解锁)`,
          });
        }
        return reply.status(401).send({ message: '账号或密码错误' });
      }

      // 登录成功:清 email 维度的失败计数和锁(IP 维度不清,防攻击者解套)
      await resetLoginAttempts('user_login', emailTrimmed);

      const secret = process.env.JWT_SECRET || 'meow_secret_key';
      const token = jwt.sign(
        { userId: user.id, email: user.email, role: 'USER' },
        secret,
        { expiresIn: '7d' }
      );

      console.info(`[AUTH][登录] 用户: ${emailTrimmed}`);
      return reply.send({
        token,
        user: {
          id: user.id,
          email: user.email,
          balance: user.balance
        }
      });
    } catch (error) {
      console.error('[AUTH][登录] 发生错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // ============ F.1.8 找回密码:发码 ============
  // 与注册场景 /send-verify-code 的关键区别:这里"邮箱不存在 = 早告诉"(404),
  // 注册是"邮箱已存在 = 早告诉"(400),方向相反。
  // cooldown key 和 verify code key 都复用 F.1b 的同一前缀——
  // 是有意为之:同一邮箱的注册流程与找回密码流程共享 60s 冷却,防止用两个流程绕轰炸保护喵。
  fastify.post('/forgot-password/send-code', async (req, reply) => {
    const { email } = req.body as any;

    if (!email || !/^\S+@\S+\.\S+$/.test(String(email).trim())) {
      return reply.status(400).send({ message: '请填写正确的邮箱喵' });
    }
    const emailTrimmed = String(email).trim();

    try {
      // 找回密码必须是已注册用户,不存在直接拒绝喵
      const [rows]: any = await pool.query('SELECT id FROM Users WHERE email = ?', [emailTrimmed]);
      if (rows.length === 0) {
        return reply.status(404).send({ message: '这个邮箱没在借阅证名册里喵' });
      }

      // 60秒发送冷却:NX 抢不到说明刚发过(与注册流程共用同一 key,见上方注释)
      const cooldownKey = VERIFY_COOLDOWN_PREFIX + emailTrimmed;
      const cooldownLock = await redis.set(cooldownKey, '1', 'EX', 60, 'NX');
      if (!cooldownLock) {
        return reply.status(429).send({ message: '验证码刚寄出去不久,请稍等一分钟再试喵' });
      }

      // 6位数字验证码,存10分钟(后发的覆盖先发的,与注册流程共用同一 key)
      const code = String(Math.floor(100000 + Math.random() * 900000));
      await redis.set(VERIFY_CODE_PREFIX + emailTrimmed, code, 'EX', 600);

      try {
        await sendPasswordResetCode(emailTrimmed, code);
      } catch (mailErr: any) {
        // 信没寄出去:撤掉冷却让客人能立刻重试,验证码留着也无害(10分钟自动过期)
        await redis.del(cooldownKey);
        console.error(`[AUTH][找回发码] 寄信失败: ${emailTrimmed}`, mailErr.message || mailErr);
        return reply.status(500).send({ message: '信使猫迷路了,验证码没寄出去,请稍后再试喵' });
      }

      console.info(`[AUTH][找回发码] 验证码已发往 ${emailTrimmed}`);
      return reply.send({ message: '找回密码验证码已寄出,请查收邮箱喵~(也看看垃圾箱,信使猫有时会被当可疑分子)' });
    } catch (error) {
      console.error('[AUTH][找回发码] 发生错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });

  // ============ F.1.8 找回密码:校验验证码并改密 ============
  // 决策 3A:不动 Tokens 表(已知风险:被盗号场景下旧 sk-meow 仍有效——小昙知情决策)。
  // 不动 Redis 余额/used 缓存(密码改了不影响余额)。
  // bcrypt salt rounds = 10,与注册/通道A同源。
  fastify.post('/forgot-password/reset', async (req, reply) => {
    const { email, verify_code, new_password } = req.body as any;

    if (!email || !new_password) {
      return reply.status(400).send({ message: '邮箱和新密码不能为空喵' });
    }
    if (!verify_code || !String(verify_code).trim()) {
      return reply.status(400).send({ message: '请填写邮箱验证码喵' });
    }
    const emailTrimmed = String(email).trim();
    if (!/^\S+@\S+\.\S+$/.test(emailTrimmed)) {
      return reply.status(400).send({ message: '邮箱格式看起来不太对喵' });
    }
    if (String(new_password).length < 4) {
      return reply.status(400).send({ message: '密码至少4位喵' });
    }

    // S1.前哨:找回密码限流 check(防 verify_code 暴力试码)
    const clientIp = getClientIp(req);
    const lockCheck = await checkLoginAttempt('forgot_reset', emailTrimmed, clientIp);
    if (lockCheck.locked) {
      const mins = Math.ceil(lockCheck.info / 60);
      console.warn(`[AUTH][找回限流] 拒绝 email=${emailTrimmed} ip=${clientIp} 维度=${lockCheck.lockedDimension} 剩余=${lockCheck.info}秒`);
      return reply.status(429).send({
        message: `找回密码尝试过多,请 ${mins} 分钟后再试喵~`,
      });
    }

    try {
      const storedCode = await redis.get(VERIFY_CODE_PREFIX + emailTrimmed);
      if (!storedCode || storedCode !== String(verify_code).trim()) {
        const failRes = await recordLoginFailure('forgot_reset', emailTrimmed, clientIp);
        if (failRes.locked) {
          const mins = Math.ceil(failRes.info / 60);
          return reply.status(429).send({
            message: `找回密码尝试过多,请 ${mins} 分钟后再试喵~`,
          });
        }
        return reply.status(400).send({ message: '验证码错误或已过期喵' });
      }
      // 一码一用即焚(成功失败都不能再用同一码)
      await redis.del(VERIFY_CODE_PREFIX + emailTrimmed);

      const passwordHash = await bcrypt.hash(String(new_password), 10);
      const [result]: any = await pool.query(
        'UPDATE Users SET password_hash = ? WHERE email = ?',
        [passwordHash, emailTrimmed]
      );

      if (result.affectedRows === 0) {
        // 理论不会发生(发码时校验过存在),但保险起见兜底
        return reply.status(404).send({ message: '账号不存在喵' });
      }

      // 改密成功:同时清两个 scope 的 email 锁
      //   - forgot_reset 锁:本流程的 verify_code 试错锁
      //   - user_login 锁:用户找回密码后应能立即用新密码登录,自动给登录解锁
      // IP 维度均不清(防攻击者解套,见 rateLimit.ts 注释)
      await resetLoginAttempts('forgot_reset', emailTrimmed);
      await resetLoginAttempts('user_login', emailTrimmed);

      console.info(`[AUTH][找回密码] 改密成功: ${emailTrimmed}(已自动解登录锁)`);
      return reply.send({ message: '改密成功喵,请用新密码登录~' });
    } catch (error) {
      console.error('[AUTH][找回密码] 发生错误:', error);
      return reply.status(500).send({ message: '内部服务器错误' });
    }
  });
}
