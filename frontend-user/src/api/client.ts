import axios from 'axios';

// Create event target for global events
export const globalEvents = new EventTarget();

// S1.前哨 · baseURL 智能检测：
//   1. .env 显式覆写优先（留给调试逃生用）
//   2. 公网域名 → 公网 API
//   3. 本地兜底
// 这样 .env.development 可以保持空，本地↔公网无缝共存喵～
// P-端口可配置化: 网关端口由 vite.config.ts 从项目根 .env 读取后编译期注入,
// 未配置时为 '3000'。declare 告诉 TS 这是 define 注入的编译期常量。
declare const __MEOW_GATEWAY_PORT__: string;

const detectBaseURL = (): string => {
  if (import.meta.env.VITE_API_BASE_URL) {
    return import.meta.env.VITE_API_BASE_URL;
  }
  if (window.location.hostname === 'app.nyabookstore.com') {
    return 'https://api.nyabookstore.com';
  }
  return `http://localhost:${__MEOW_GATEWAY_PORT__}`;
};

export const apiClient = axios.create({
  baseURL: detectBaseURL(),
  timeout: 10000,
});

apiClient.interceptors.request.use(
  (config) => {
    const token = localStorage.getItem('token');
    if (token) {
      config.headers['Authorization'] = `Bearer ${token}`;
    }
    console.info(`[USER-PORTAL][API][Request] ${config.method?.toUpperCase()} ${config.url}`);
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

apiClient.interceptors.response.use(
  (response) => {
    console.info(`[USER-PORTAL][API][Response] ${response.config.method?.toUpperCase()} ${response.config.url} - ${response.status}`);
    return response;
  },
  (error) => {
    if (error.response) {
      const status = error.response.status;
      console.info(`[USER-PORTAL][API][ResponseError] ${error.config?.method?.toUpperCase()} ${error.config?.url} - ${status}`);
      
      if (status === 402) {
        globalEvents.dispatchEvent(new Event('balance:empty'));
      } else if (status === 401) {
        localStorage.removeItem('token');
        window.location.href = '/login';
      } else {
        console.error('API Error:', error.response.data || error.message);
      }
    } else {
      console.error('API Error:', error.message);
    }
    return Promise.reject(error);
  }
);
