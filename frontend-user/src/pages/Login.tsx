import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { apiClient } from '../api/client';
import ThemeToggle from '../components/ThemeToggle';

// ============================================================
// 弹幕文案（可自由增删；开源版可在此替换为通用词）
// ============================================================
const DANMU_TEXTS = [
  '欢迎回来喵~',
  '咖啡豆没有了喵！！？',
  '店长的账单还没有打印出来喵~',
  '睡过头了喵！',
  '有没有好好吃饭喵~',
  '魔法失灵了喵...',
  '快去干活喵！',
  '晕乎乎的了喵...',
  '早上好中午好下午好晚上好喵~',
  '有猫猫偷懒喵！',
];

// 为每条弹幕生成错落的轨道参数（高度/字号/速度/延迟/透明度）
const DANMU_TRACKS = DANMU_TEXTS.map((text, i) => {
  const top = 6 + ((i * 9.3) % 84);
  const fontSize = 1.1 + ((i * 37) % 26) / 10;
  const duration = 16 + ((i * 13) % 16);
  const delay = -((i * 3.1) % 30);
  const opacity = 0.10 + ((i * 7) % 10) / 100;
  return { text, top, fontSize, duration, delay, opacity };
});

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);
    console.info(`[USER-PORTAL][Login][Submit] email: ${email}`);

    try {
      // ===== 核心逻辑：原样保留，未改动 =====
      const response = await apiClient.post('/api/v1/auth/login', { email, password });
      const { token } = response.data;
      if (token) {
        localStorage.setItem('token', token);
        // ===== 核心逻辑结束 =====

        // 接力转场旗标：通知 Layout 用同款色块接力揭开（无缝转场）
        sessionStorage.setItem('meow:justLoggedIn', '1');
        setIsSuccess(true);
        setTimeout(() => {
          navigate('/dashboard');
        }, 900);
      } else {
        setIsLoading(false);
      }
    } catch (err: any) {
      setIsLoading(false);
      setError(err.response?.data?.message || '登录失败，请检查账号密码');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center theme-layout-bg p-4 font-harmony relative overflow-hidden transition-colors duration-700">

      {/* ===== 主题切换按钮（左上角固定，公共组件） ===== */}
      <ThemeToggle />

      {/* ===== 流体 blob 背景层（亮:撞色晕染 / 暗:深褐+淡荧光） ===== */}
      <div className="meow-blob-field" aria-hidden="true">
        <span className="meow-blob meow-blob-1"></span>
        <span className="meow-blob meow-blob-2"></span>
        <span className="meow-blob meow-blob-3"></span>
      </div>

      {/* ===== 旋转呼吸魔法阵（仅亮色显示） ===== */}
      <div className="meow-rune" aria-hidden="true">
        <svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">
          <circle cx="100" cy="100" r="96" />
          <circle cx="100" cy="100" r="78" />
          <circle cx="100" cy="100" r="52" />
          <polygon points="100,20 123,80 187,80 135,118 154,180 100,142 46,180 65,118 13,80 77,80" />
          <g className="meow-rune-ticks">
            <line x1="100" y1="4" x2="100" y2="16" />
            <line x1="100" y1="184" x2="100" y2="196" />
            <line x1="4" y1="100" x2="16" y2="100" />
            <line x1="184" y1="100" x2="196" y2="100" />
          </g>
        </svg>
      </div>

      {/* ===== 星尘光点（仅亮色显示） ===== */}
      <div className="meow-stardust" aria-hidden="true">
        {Array.from({ length: 14 }).map((_, i) => (
          <span key={i} className={`meow-star meow-star-${i % 7}`}></span>
        ))}
      </div>

      {/* ===== 飘动喵语弹幕（仅亮色显示） ===== */}
      <div className="meow-danmu-field" aria-hidden="true">
        {DANMU_TRACKS.map((d, i) => (
          <span
            key={i}
            className="meow-danmu"
            style={{
              top: `${d.top}%`,
              fontSize: `${d.fontSize}rem`,
              animationDuration: `${d.duration}s`,
              animationDelay: `${d.delay}s`,
              opacity: d.opacity,
            }}
          >
            {d.text}
          </span>
        ))}
      </div>

      {/* 交互面板外层：处理暗色的悬浮发光 */}
      <div className="theme-panel-wrapper w-full max-w-md relative z-10 hover:-translate-y-2 transition-transform duration-500 ease-spring group">

        <div className="theme-panel p-10 relative flex flex-col h-full w-full">
          <div className="text-center mb-8 relative z-10">
            <h1 className="text-3xl font-black tracking-widest theme-text-title mb-2">喵咖魔法书店</h1>
            <p className="text-sm theme-text-sub opacity-80 font-medium">欢迎回来，主人~</p>
          </div>

          <form onSubmit={handleLogin} className="space-y-6 relative z-10">
            <div className="relative">
              <input
                type="email"
                placeholder="邮箱"
                className="w-full px-5 py-4 theme-input transition-all duration-300 outline-none"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isLoading || isSuccess}
              />
            </div>

            <div className="relative">
              <input
                type="password"
                placeholder="密码"
                className="w-full px-5 py-4 theme-input transition-all duration-300 outline-none"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={isLoading || isSuccess}
              />
            </div>

            {error && (
              <div className="border-l-[3px] theme-border-error pl-3 py-2 bg-red-500/10 rounded-r-md">
                <p className="theme-text-error text-sm font-medium">{error}</p>
              </div>
            )}

            <div className="relative pt-2">
              <button
                type="submit"
                disabled={isLoading || isSuccess}
                className="w-full theme-button font-bold py-4 transition-all duration-300 active:scale-95 ease-spring relative z-10 shadow-md hover:shadow-lg disabled:opacity-80 disabled:cursor-not-allowed"
              >
                {isLoading ? (
                  <span className="inline-flex items-center justify-center gap-2">
                    <span className="meow-spinner" aria-hidden="true"></span>
                    登录中...
                  </span>
                ) : (
                  '登录'
                )}
              </button>
            </div>

            <div className="mt-4 space-y-3 pt-2">
              <p className="text-center text-sm theme-text-sub opacity-80">
                忘了进店暗号？
                <Link to="/forgot-password" className="theme-link font-bold hover:underline underline-offset-4 ml-1 transition-colors">
                  去找回喵 →
                </Link>
              </p>
              <p className="text-center text-sm theme-text-sub opacity-80">
                还没有借阅证？
                <Link to="/register" className="theme-link font-bold hover:underline underline-offset-4 ml-1 transition-colors">
                  去办一张喵 →
                </Link>
              </p>
            </div>
          </form>
        </div>
      </div>

      {/* ===== 成功斜切幕（猫爪已移除，仅留文字） ===== */}
      {isSuccess && (
        <div className="meow-wipe" aria-hidden="true">
          <div className="meow-wipe-content">
            <span className="meow-wipe-text">欢迎回来喵 ✨</span>
          </div>
        </div>
      )}
    </div>
  );
}
