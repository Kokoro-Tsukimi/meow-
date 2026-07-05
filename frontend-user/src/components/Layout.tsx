import React, { useState, useEffect } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import ThemeToggle from './ThemeToggle';

// 导航入口（可爱命名 + 图标）
const NAV_ITEMS = [
  { to: '/dashboard', label: '喵屋大厅',   icon: 'home' },
  { to: '/topup',     label: '投喂咖啡豆', icon: 'coffee' },
  { to: '/bills',     label: '消费小票夹', icon: 'receipt' },
  { to: '/tokens',    label: '魔法钥匙串', icon: 'key' },
  { to: '/models',    label: '魔法菜单',   icon: 'menu' },
  { to: '/profile',   label: '客人餐桌',   icon: 'chair' },
];

function Icon({ name }: { name: string }) {
  const common = { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (name) {
    case 'home':    return <svg {...common}><path d="M3 11l9-8 9 8" /><path d="M5 10v10h14V10" /></svg>;
    case 'coffee':  return <svg {...common}><path d="M4 8h13a3 3 0 0 1 0 6h-1" /><path d="M4 8v9a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2v-9" /><path d="M8 2v3M11 2v3" /></svg>;
    case 'receipt': return <svg {...common}><path d="M6 2h9l3 3v15l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21z" /><path d="M9 8h6M9 12h6" /></svg>;
    case 'key':     return <svg {...common}><circle cx="8" cy="8" r="5" /><path d="M11.5 11.5L21 21M17 17l2-2M14 14l2-2" /></svg>;
    case 'menu':    return <svg {...common}><path d="M5 3h14v18l-7-3-7 3z" /><path d="M9 8h6M9 12h4" /></svg>;
    case 'chair':   return <svg {...common}><path d="M6 13V4h12v9" /><path d="M5 13h14" /><path d="M7 13v7M17 13v7" /></svg>;
    default:        return null;
  }
}

export default function Layout() {
  const navigate = useNavigate();

  // 入场转场：接力色块（与登录幕布一模一样）→ 揭开 → 内容磁悬浮弹入
  // 仅当从登录页跳转来时播放（用 sessionStorage 旗标，避免页面内切换也播）
  // 惰性初始化：首次渲染前就读旗标，让接力色块第一帧就在，
  // 避免"先渲染奶白页、useEffect 才盖幕布"的一帧竞态（小概率闪奶白页）。
  const [showCurtain, setShowCurtain] = useState(
    () => sessionStorage.getItem('meow:justLoggedIn') === '1'
  );

  // 【M窗】手机抽屉开关：≤768px 时侧栏收进左滑抽屉，顶栏汉堡按钮控制。
  // 桌面端顶栏/遮罩被 CSS 隐藏，此 state 不产生任何可见影响。
  const [drawerOpen, setDrawerOpen] = useState(false);

  useEffect(() => {
    if (showCurtain) {
      // 旗标已用掉，清除，避免页面内切换/刷新再次触发
      sessionStorage.removeItem('meow:justLoggedIn');
      // 揭开后移除幕布
      const t = setTimeout(() => setShowCurtain(false), 1100);
      return () => clearTimeout(t);
    }
  }, []);

  // 【M窗】抽屉打开时给 body 挂类锁背景滚动
  // （对应 CSS 规则写在小屏媒体查询内，桌面端即使误挂也无副作用；
  //  组件卸载时 effect 清理函数兜底摘类，避免登出后 body 残留锁滚动）
  useEffect(() => {
    document.body.classList.toggle('meow-drawer-lock', drawerOpen);
    return () => document.body.classList.remove('meow-drawer-lock');
  }, [drawerOpen]);

  const closeDrawer = () => setDrawerOpen(false);

  const handleLogout = () => {
    localStorage.removeItem('token');
    navigate('/login');
  };

  return (
    <div className={`meow-layout font-harmony${showCurtain ? ' entering' : ''}`}>
      {/* ===== 【M窗】手机顶栏（桌面端 CSS 隐藏）===== */}
      <header className="meow-topbar">
        <button
          type="button"
          className="meow-burger"
          aria-label="打开导航菜单"
          onClick={() => setDrawerOpen(true)}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="meow-topbar-brand">喵咖魔法书店</span>
      </header>

      {/* ===== 【M窗】抽屉遮罩（桌面端 CSS 隐藏；点击收回抽屉）===== */}
      <div
        className={`meow-drawer-mask${drawerOpen ? ' show' : ''}`}
        onClick={closeDrawer}
        aria-hidden="true"
      ></div>

      {/* ===== 左侧导航栏（【M窗】≤768px 变身左滑抽屉）===== */}
      <aside className={`meow-sidebar${drawerOpen ? ' open' : ''}`}>
        <div className="meow-brand">
          喵咖魔法书店
          <small>MEOW MAGIC BOOKSTORE</small>
        </div>
        <div className="meow-brand-divider"></div>

        <nav className="meow-nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={closeDrawer}
              className={({ isActive }) => `meow-nav-item${isActive ? ' active' : ''}`}
            >
              <Icon name={item.icon} />
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="meow-side-bottom">
          <div className="meow-side-divider"></div>
          <div className="meow-toggle-row">
            <ThemeToggle inline />
          </div>
          <button type="button" onClick={handleLogout} className="meow-nav-item logout">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <path d="M16 17l5-5-5-5M21 12H9" />
            </svg>
            打烊离店
          </button>
        </div>
      </aside>

      {/* ===== 右侧内容区（页面装这里 + 磁悬浮弹入） ===== */}
      <main className={`meow-content${showCurtain ? ' meow-content-enter' : ''}`}>
        <Outlet />
      </main>

      {/* ===== 接力色块转场（与登录幕布像素级一致 → 往左下揭开） ===== */}
      {showCurtain && (
        <div className="meow-wipe meow-wipe-handoff" aria-hidden="true">
          <div className="meow-wipe-content">
            <span className="meow-wipe-text">欢迎回来喵 ✨</span>
          </div>
        </div>
      )}
    </div>
  );
}
