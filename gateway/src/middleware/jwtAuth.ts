import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { pool } from '../db';

declare module 'fastify' {
  interface FastifyRequest {
    jwtUser?: { userId: number; role: string; email: string };
  }
}

export const jwtAuth = async (req: FastifyRequest, reply: FastifyReply) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({ message: '未授权，请提供正确的 Bearer Token' });
    return;
  }

  const token = authHeader.split(' ')[1];
  const secret = process.env.JWT_SECRET || 'meow_secret_key';

  let decoded: { userId: number; role: string; email: string };
  try {
    decoded = jwt.verify(token, secret) as { userId: number; role: string; email: string };
  } catch (error) {
    reply.status(401).send({ message: 'Token 已失效或不正确' });
    return;
  }

  // S1+(2026-06-24): 控制面用户级状态校验 —— 封号实时登出 user 端
  //   JWT 验签只证明"这串 token 签发过且没过期",不证明"账号此刻还有效"。
  //   封号后 JWT 仍在有效期内 → 不查库就放行 → user 端不被踢(与数据面同构 bug)。
  //   查一次 Users.status:BANNED 或账号已删 → 401(前端拦截器自动登出);其余放行。
  //   语义与登录端/数据面统一为 BANNED-only:ARREARS / BLACKLIST 仍可正常登录看自己状态。
  //   fail-open:DB 异常时放行(自愈优于误伤,与数据面 RPM 限流同款容错;
  //             封号低频且数据面已独立拦截,控制面短暂放行无安全风险)。
  try {
    const [rows]: any = await pool.query(
      'SELECT status FROM Users WHERE id = ? LIMIT 1',
      [decoded.userId]
    );
    if (rows.length === 0 || rows[0].status === 'BANNED') {
      console.warn(`[GATEWAY][JWT-AUTH][账号已封禁/不存在] UserID: ${decoded.userId}`);
      reply.status(401).send({ message: '账号已被禁用喵' });
      return;
    }
  } catch (err) {
    console.error('[GATEWAY][JWT-AUTH][状态校验异常,放行]', err);
    // fail-open:不因 DB 抖动误踢正常用户
  }

  req.jwtUser = decoded;
};
