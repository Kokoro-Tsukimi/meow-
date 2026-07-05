import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';

declare module 'fastify' {
  interface FastifyRequest {
    adminUser?: { email: string; role: string };
  }
}

export const adminJwtAuth = async (req: FastifyRequest, reply: FastifyReply) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.status(401).send({ message: '未授权，请提供正确的 Bearer Token' });
    return;
  }

  const token = authHeader.split(' ')[1];

  // C+.6 (H3): 不再提供默认密钥兜底,与 routes/admin.ts 签发端保持配套。
  // 密钥没配 → 直接拒绝,宁可用不了,也不留"人人皆知的默认密钥"后门喵。
  const secret = process.env.ADMIN_JWT_SECRET;
  if (!secret) {
    reply.status(503).send({ message: '超管密钥未配置,请在 .env 中设置 ADMIN_JWT_SECRET' });
    return;
  }

  try {
    const decoded = jwt.verify(token, secret) as { email: string; role: string };

    if (decoded.role !== 'ADMIN') {
      reply.status(403).send({ message: '需要超管权限' });
      return;
    }

    req.adminUser = decoded;
  } catch (error) {
    reply.status(401).send({ message: 'Token 已失效或不正确' });
    return;
  }
};