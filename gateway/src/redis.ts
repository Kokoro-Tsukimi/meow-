import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config({ path: '../.env' }); // To allow finding the .env in dev, might just be standard usage. 
// Assuming index.ts will load dotenv but good to be safe if running isolated.

const host = process.env.REDIS_HOST || 'localhost';
const port = Number(process.env.REDIS_PORT) || 6379;

export const redis = new Redis({
  host,
  port,
  lazyConnect: true // Let the app start and connect explicitly or handle errors better
});

redis.on('error', (err) => {
  console.error(`[REDIS][错误] Redis连接异常:`, err.stack || err.message);
});

redis.on('connect', () => {
  console.info(`[REDIS][连接] 成功连接到 Redis 服务 (${host}:${port})`);
});
