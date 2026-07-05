import { FastifyInstance } from 'fastify';
import jwt from 'jsonwebtoken';

// ============ E.3.4 店长专线(WebSocket 实时推送) ============
// 职责:维护"当前在线的店长们",并提供广播函数给其他模块(proxy 的挂起术)调用。
// 设计书要求多管理员按 admin_id 定向推送;我们单店长,先做"推给所有在线店长",
// 用 Set 留好扩展空间,以后真有多店长再按归属分组喵。

// 已连接的店长socket集合
const adminSockets = new Set<any>();

/**
 * 向所有在线店长推送一个事件(店里广播喇叭喵)
 * @param event 事件名,如 DRY_RUN_PENDING
 * @param payload 事件数据
 * @returns 实际送达的店长数
 */
export function broadcastToAdmins(event: string, payload: any): number {
  const message = JSON.stringify({ event, payload });
  let sent = 0;
  for (const socket of adminSockets) {
    try {
      socket.send(message);
      sent++;
    } catch {
      // 这条线已经断了,从名单里划掉
      adminSockets.delete(socket);
    }
  }
  if (sent > 0) {
    console.info(`[GATEWAY][店长专线] 事件 ${event} 已推送给 ${sent} 位在线店长`);
  }
  return sent;
}

export default async function realtimeRoutes(fastify: FastifyInstance) {
  // GET /ws/admin/events - 店长专线接入点
  // 浏览器的 WebSocket 不能自定义 Header,所以工牌(JWT)走 query 参数: ?token=xxx
  fastify.get('/admin/events', { websocket: true }, (connection: any, req: any) => {
    // 兼容 @fastify/websocket 不同版本:老版给 {socket},新版直接给 socket 本体
    const socket = connection.socket ?? connection;

    const token = (req.query as any)?.token;
    const secret = process.env.ADMIN_JWT_SECRET;

    // 和 adminJwtAuth 同一条铁律:密钥没配 → 拒绝服务,不留后门喵
    if (!secret) {
      socket.close(1011, 'ADMIN_JWT_SECRET 未配置');
      return;
    }
    if (!token) {
      socket.close(1008, '缺少工牌');
      return;
    }

    try {
      const decoded = jwt.verify(token, secret) as { email: string; role: string };
      if (decoded.role !== 'ADMIN') {
        socket.close(1008, '需要店长权限');
        return;
      }

      // 工牌有效 → 接入专线
      adminSockets.add(socket);
      console.info(`[GATEWAY][店长专线] 店长 ${decoded.email} 上线,当前在线 ${adminSockets.size} 位`);
      socket.send(JSON.stringify({ event: 'CONNECTED', payload: { message: '店长专线已接通喵~' } }));

      socket.on('close', () => {
        adminSockets.delete(socket);
        console.info(`[GATEWAY][店长专线] 店长 ${decoded.email} 下线,当前在线 ${adminSockets.size} 位`);
      });
      socket.on('error', () => {
        adminSockets.delete(socket);
      });
    } catch {
      // 工牌过期或伪造
      socket.close(1008, '工牌无效或已过期');
    }
  });
}