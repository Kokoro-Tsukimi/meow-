import fastify from 'fastify';
import formbody from '@fastify/formbody';
import dotenv from 'dotenv';
import { redis } from './redis';
import { pool } from './db';
import { initSystemSettings } from './services/systemSettings';
import { authMiddleware } from './middleware/auth';
import { rateLimitMiddleware } from './middleware/rateLimit';
import { jwtAuth } from './middleware/jwtAuth';
import proxyPlugin from './plugins/proxy';
import websocket from '@fastify/websocket';
import realtimeRoutes from './realtime';
import authRoutes from './routes/auth';
import userRoutes from './routes/user';
import adminRoutes from './routes/admin';

// 加载环境变量
dotenv.config();

const server = fastify({
  logger: false, // 我们将使用自定义的 console 日志来满足特定的日志格式要求
  // S1.前哨:登录限流 IP 维度需要真实客户端 IP。开 trustProxy 让 Fastify 从
  // X-Forwarded-For / X-Real-IP 自动解析 req.ip。Cloudflare Tunnel 转发时
  // 会带 X-Forwarded-For 头。配合 getClientIp() 兜底 cf-connecting-ip,双保险。
  trustProxy: true,
  // 【体检修复·多模态】Fastify 默认 bodyLimit 仅 1MB, base64 图片(体积膨胀约1/3)
  // 一撞就 413(实测确诊: FST_ERR_CTP_BODY_TOO_LARGE)。放宽到 20MB:
  // 手机原图/截图通吃(≈15MB 原图); 不设无限是防超大包灌爆内存, RPM 限流再兜一层。
  bodyLimit: 20 * 1024 * 1024
});

import cors from '@fastify/cors';
server.register(formbody);
// P-端口可配置化: CORS 白名单端口跟随项目根 .env(与前端 vite.config 同源),
// 未配置回落 5173/5174; 同时放行 127.0.0.1 写法(有的部署者习惯用 IP 访问)。
// 注意 dotenv.config() 在上方已执行, 此处 process.env 已就绪。
const USER_PORT = Number(process.env.USER_PORT) || 5173;
const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 5174;
server.register(cors, {
  origin: [
    `http://localhost:${USER_PORT}`,
    `http://localhost:${ADMIN_PORT}`,
    `http://127.0.0.1:${USER_PORT}`,
    `http://127.0.0.1:${ADMIN_PORT}`,
    'https://app.nyabookstore.com'
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true
});

// E.3.4: WebSocket 能力 + 店长专线(/ws/* 实时通道,设计书的第三类路由喵)
server.register(websocket);
server.register(async (instance) => {
  instance.register(realtimeRoutes, { prefix: '/ws' });
});

// 下游代理路由，使用现有的 Token 鉴权
server.register(async (instance) => {
  instance.addHook('preHandler', authMiddleware);
  instance.addHook('preHandler', rateLimitMiddleware); // D.3: 限流在鉴权之后(要用user.id)
  instance.register(proxyPlugin);
});

// 控制面 API - 无需鉴权
server.register(async (instance) => {
  instance.register(authRoutes, { prefix: '/api/v1/auth' });
});

// 控制面 API - 需要 JWT 鉴权
server.register(async (instance) => {
  instance.addHook('preHandler', jwtAuth);
  instance.register(userRoutes, { prefix: '/api/v1/user' });
});

// 控制面 API - 超管路由（内部自带鉴权钩子）
server.register(async (instance) => {
  instance.register(adminRoutes, { prefix: '/api/v1/admin' });
});

const start = async () => {
  try {
    const port = Number(process.env.GATEWAY_PORT) || 3000;
    
    // 确保数据库连接池可用
    await pool.query('SELECT 1');
    
    // 加载 SystemSettings 进进程内缓存(F.5: 诊断模式总闸 / 货架 MB 上限)
    await initSystemSettings();
    
    await server.listen({ port, host: '0.0.0.0' });
    console.info(`[GATEWAY][启动] 网关已启动，端口: ${port}`);
  } catch (err: any) {
      console.error(`[GATEWAY][启动错误]`, err.stack || err.message);
      if (err.errors && Array.isArray(err.errors)) {
        console.error('[GATEWAY][聚合错误明细]');
        err.errors.forEach((e: any, i: number) => {
          console.error(`  错误${i + 1}:`, e.code, '-', e.message);
          console.error(`    地址: ${e.address}:${e.port}, syscall: ${e.syscall}`);
        });
      }
      process.exit(1);
  }
};

start();
