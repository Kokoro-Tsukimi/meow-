import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { apiClient } from '../api/client';
import ThemeToggle from '../components/ThemeToggle';

// 弹幕文案（与登录/注册页同款）
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
const DANMU_TRACKS = DANMU_TEXTS.map((text, i) => {
  const top = 6 + ((i * 9.3) % 84);
  const fontSize = 1.1 + ((i * 37) % 26) / 10;
  const duration = 16 + ((i * 13) % 16);
  const delay = -((i * 3.1) % 30);
  const opacity = 0.10 + ((i * 7) % 10) / 100;
  return { text, top, fontSize, duration, delay, opacity };
});

// F.1.8 找回密码:与 Register.tsx 同款单页式表单,主要差异:
//   - 不需要邀请码字段(找回密码必走邮箱验证码)
//   - 邮箱"不存在"会被后端 404 拒绝(与注册"已存在"方向相反)
//   - 提交后跳回登录页,不直接帮用户登录(避免持有未确认改密成功的会话)
//
// #30 修法:用 localStorage 持久化"冷却结束时刻",刷新/重开都能恢复倒计时。
// 与 Register 共用同一 key 前缀,因为后端 cooldown 本来就是共用的同一 Redis key。
const COOLDOWN_KEY_PREFIX = 'meow:verify:cooldown:';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [sendCooldown, setSendCooldown] = useState(0);
  const [sendingCode, setSendingCode] = useState(false);
  const [codeSentMsg, setCodeSentMsg] = useState('');
  const cooldownTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const [error, setError] = useState('');
  const [successMsg, setSuccessMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const navigate = useNavigate();

  // 组件卸载时清掉倒计时,不留幽灵计时器喵
  useEffect(() => {
    return () => {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    };
  }, []);

  // #30 修法核心:从 localStorage 恢复冷却倒计时(挂载时 + email 变化时都检查)
  useEffect(() => {
    const trimmed = email.trim();
    if (!trimmed) {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current);
      setSendCooldown(0);
      return;
    }
    const key = COOLDOWN_KEY_PREFIX + trimmed;
    const targetMsStr = localStorage.getItem(key);
    if (!targetMsStr) {
      if (cooldownTimer.current) clearInterval(cooldownTimer.current);
      setSendCooldown(0);
      return;
    }
    const targetMs = parseInt(targetMsStr, 10);
    const remaining = Math.ceil((targetMs - Date.now()) / 1000);
    if (remaining > 0) {
      startCooldown(remaining);
    } else {
      localStorage.removeItem(key);
      setSendCooldown(0);
    }
  }, [email]);

  const startCooldown = (seconds: number) => {
    setSendCooldown(seconds);
    if (cooldownTimer.current) clearInterval(cooldownTimer.current);
    cooldownTimer.current = setInterval(() => {
      setSendCooldown((prev) => {
        if (prev <= 1) {
          if (cooldownTimer.current) clearInterval(cooldownTimer.current);
          const trimmed = email.trim();
          if (trimmed) localStorage.removeItem(COOLDOWN_KEY_PREFIX + trimmed);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleSendCode = async () => {
    setError('');
    setCodeSentMsg('');
    const emailTrimmed = email.trim();
    if (!/^\S+@\S+\.\S+$/.test(emailTrimmed)) {
      setError('先把邮箱填好,信使猫才知道往哪寄喵~');
      return;
    }
    setSendingCode(true);
    try {
      const res = await apiClient.post('/api/v1/auth/forgot-password/send-code', { email: emailTrimmed });
      setCodeSentMsg(res.data.message || '验证码已寄出,请查收喵~');
      const targetMs = Date.now() + 60 * 1000;
      localStorage.setItem(COOLDOWN_KEY_PREFIX + emailTrimmed, String(targetMs));
      startCooldown(60);
    } catch (err: any) {
      setError(err.response?.data?.message || '验证码发送失败,请稍后再试喵');
    } finally {
      setSendingCode(false);
    }
  };

  const handleReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!verifyCode.trim()) {
      setError('请填写邮箱验证码喵');
      return;
    }
    if (newPassword.length < 4) {
      setError('新密码至少4位喵');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('两次输入的密码不一样喵,再检查一下~');
      return;
    }

    setSubmitting(true);
    console.info(`[USER-PORTAL][ForgotPassword][Submit] email: ${email}`);

    try {
      const res = await apiClient.post('/api/v1/auth/forgot-password/reset', {
        email: email.trim(),
        verify_code: verifyCode.trim(),
        new_password: newPassword,
      });
      setSuccessMsg(res.data.message || '改密成功喵,请用新密码登录~');

      setTimeout(() => {
        navigate('/login');
      }, 2500);
    } catch (err: any) {
      setError(err.response?.data?.message || '改密失败,请稍后再试喵');
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center theme-layout-bg p-4 font-harmony relative overflow-hidden transition-colors duration-700">

      {/* ===== 主题切换按钮（左上角固定，公共组件） ===== */}
      <ThemeToggle />

      {/* ===== 流体 blob 背景层 ===== */}
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

      {/* 交互面板 */}
      <div className="theme-panel-wrapper w-full max-w-md relative z-10 hover:-translate-y-2 transition-transform duration-500 ease-spring group">
        <div className="theme-panel p-6 sm:p-10 relative flex flex-col h-full w-full">
          <div className="text-center mb-8 relative z-10">
            <h1 className="text-3xl font-black tracking-widest theme-text-title mb-2">找回借阅证密码</h1>
            <p className="text-sm theme-text-sub opacity-80 font-medium">忘了进店暗号也没关系喵~</p>
          </div>

          {successMsg ? (
            <div className="text-center space-y-4 relative z-10">
              <div className="text-5xl">🎉</div>
              <p className="theme-text-title font-bold">{successMsg}</p>
              <p className="text-sm theme-text-sub opacity-70">正在带你去登录门口喵...</p>
            </div>
          ) : (
            <form onSubmit={handleReset} className="space-y-5 relative z-10">
              <div>
                <input
                  type="email"
                  placeholder="账号邮箱"
                  className="w-full px-5 py-4 theme-input transition-all duration-300 outline-none"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    placeholder="邮箱验证码"
                    className="flex-1 min-w-0 px-5 py-4 theme-input transition-all duration-300 outline-none"
                    value={verifyCode}
                    onChange={(e) => setVerifyCode(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={handleSendCode}
                    disabled={sendingCode || sendCooldown > 0}
                    className="px-3 sm:px-4 shrink-0 theme-button text-sm font-medium transition-all duration-300 active:scale-95 ease-spring disabled:opacity-50 whitespace-nowrap"
                  >
                    {sendingCode ? '寄信中...' : sendCooldown > 0 ? `${sendCooldown}s后可重发` : '获取验证码'}
                  </button>
                </div>
                {codeSentMsg && (
                  <p className="text-xs theme-text-sub opacity-70 mt-2 px-1">📮 {codeSentMsg}</p>
                )}
              </div>

              <div>
                <input
                  type="password"
                  placeholder="新密码（至少4位）"
                  className="w-full px-5 py-4 theme-input transition-all duration-300 outline-none"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                />
              </div>
              <div>
                <input
                  type="password"
                  placeholder="再输一次新密码"
                  className="w-full px-5 py-4 theme-input transition-all duration-300 outline-none"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
              </div>

              {error && (
                <div className="border-l-[3px] theme-border-error pl-3 py-2 bg-red-500/10 rounded-r-md">
                  <p className="theme-text-error text-sm font-medium">{error}</p>
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="w-full theme-button font-bold py-4 transition-all duration-300 active:scale-95 ease-spring shadow-md hover:shadow-lg disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {submitting ? '换暗号中...' : '重置密码 🐾'}
              </button>

              <p className="text-center text-sm theme-text-sub opacity-80">
                想起来了？
                <Link to="/login" className="theme-link font-bold hover:underline underline-offset-4 ml-1 transition-colors">
                  直接进店喵 →
                </Link>
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
