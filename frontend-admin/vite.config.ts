import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// P-端口可配置化 + 端口钉死:
// 旧版没写 port, admin 会先抢 5173、失败才退 5174(架构现状 §2 的"端口未钉死"老技术债)。
// 现在用 ADMIN_PORT 钉死默认 5174 + strictPort, 被占用就大声报错而不是漂移。
export default defineConfig(({ mode }) => {
  const rootEnv = loadEnv(mode, path.resolve(process.cwd(), '..'), '')
  const ADMIN_PORT = Number(rootEnv.ADMIN_PORT) || 5174
  const GATEWAY_PORT = Number(rootEnv.GATEWAY_PORT) || 3000

  return {
    plugins: [react()],
    server: {
      port: ADMIN_PORT,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://localhost:${GATEWAY_PORT}`,
          changeOrigin: true
        }
      }
    }
  }
})
