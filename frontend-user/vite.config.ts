import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// P-端口可配置化: 三个端口统一收拢到项目根 .env(与 gateway 共用一份),
// 端口被占用的部署者只改 .env 一处即可, 未配置时回落原默认值。
//   USER_PORT    → 本前端 dev server 端口 (默认 5173)
//   GATEWAY_PORT → /api 代理转发的网关端口 (默认 3000)
export default defineConfig(({ mode }) => {
  // loadEnv 第二参 = 项目根目录(npm run dev 的 cwd 是 frontend-user, 上一级即项目根);
  // 第三参 '' = 不限 VITE_ 前缀, 才能读到 USER_PORT / GATEWAY_PORT 这类裸变量
  const rootEnv = loadEnv(mode, path.resolve(process.cwd(), '..'), '')
  const USER_PORT = Number(rootEnv.USER_PORT) || 5173
  const GATEWAY_PORT = Number(rootEnv.GATEWAY_PORT) || 3000

  return {
    plugins: [react()],
    // 把网关端口注入给运行时代码(client.ts detectBaseURL 的本地兜底用)
    define: {
      __MEOW_GATEWAY_PORT__: JSON.stringify(String(GATEWAY_PORT)),
    },
    server: {
      port: USER_PORT,
      strictPort: true, // 端口被占直接报错, 不悄悄漂移(漂移会让 CORS 白名单失配)
      allowedHosts: ['app.nyabookstore.com', 'localhost'],
      proxy: {
        '/api': {
          target: `http://localhost:${GATEWAY_PORT}`,
          changeOrigin: true
        }
      }
    }
  }
})
