import React from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import ThemeToggle from './ThemeToggle';

// 导航入口（路由 + 可爱命名，与原版逐字一致；emoji 换为线条图标）
const NAV_ITEMS = [
  { to: '/dashboard',    label: '营业总览',     icon: 'dashboard' },
  { to: '/channels',     label: '进货书架',     icon: 'shelf' },
  { to: '/model-groups', label: '魔法菜单册',   icon: 'menu' },
  { to: '/users',        label: '常客名册',     icon: 'users' },
  { to: '/redeem-codes', label: '后厨烘焙坊',   icon: 'gift' },
  { to: '/dry-run',      label: '吧台安检区',   icon: 'shield' },
  { to: '/rules',        label: '安检规则手册', icon: 'rules' },
  { to: '/mail-channels',label: '送信小猫的窝', icon: 'mail' },
  { to: '/settings',     label: '店规',         icon: 'settings' },
];

function Icon({ name }: { name: string }) {
  const c = {
    width: 16,
    height: 16,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };
  switch (name) {
    case 'dashboard': return <svg {...c}><rect x="3" y="3" width="7" height="9" /><rect x="14" y="3" width="7" height="5" /><rect x="14" y="12" width="7" height="9" /><rect x="3" y="16" width="7" height="5" /></svg>;
    case 'shelf':     return <svg {...c}><path d="M3 7l9-4 9 4v10l-9 4-9-4z" /><path d="M3 7l9 4 9-4M12 11v10" /></svg>;
    case 'menu':      return <svg {...c}><path d="M4 4h16v16H4z" /><path d="M8 8h8M8 12h8M8 16h5" /></svg>;
    case 'users':     return <svg {...c}><circle cx="9" cy="8" r="3" /><path d="M3 20c0-3 3-5 6-5s6 2 6 5" /><circle cx="17" cy="9" r="2" /><path d="M16 14c2 0 4 1.5 4 4" /></svg>;
    case 'gift':      return <svg {...c}><rect x="3" y="8" width="18" height="4" /><path d="M5 12v9h14v-9M12 8v13" /><path d="M12 8C12 5 9 4 8 6s2 2 4 2zM12 8c0-3 3-4 4-2s-2 2-4 2z" /></svg>;
    case 'shield':    return <svg {...c}><path d="M12 2l8 3v6c0 5-3.5 8-8 11-4.5-3-8-6-8-11V5z" /><path d="M9 12l2 2 4-4" /></svg>;
    case 'rules':     return <svg {...c}><path d="M6 2h9l3 3v15l-2-1.5L14 21l-2-1.5L10 21l-2-1.5L6 21z" /><path d="M9 8h6M9 12h6M9 16h4" /></svg>;
    case 'mail':      return <svg {...c}><rect x="3" y="5" width="18" height="14" rx="1" /><path d="M3 7l9 6 9-6" /></svg>;
    case 'settings':  return <svg {...c}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" /></svg>;
    default:          return null;
  }
}

const Sidebar: React.FC = () => {
  const navigate = useNavigate();

  const handleLogout = () => {
    localStorage.removeItem('admin_token');
    navigate('/login');
  };

  return (
    <div className="mecha-sidebar">
      <div className="mecha-brand">喵咖魔法书店</div>
      <div className="mecha-brand-sub">CONTROL PANEL</div>

      <nav className="mecha-nav">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `mecha-nav-item${isActive ? ' active' : ''}`}
          >
            <Icon name={item.icon} />
            {item.label}
          </NavLink>
        ))}
      </nav>

      <div className="mecha-side-bottom">
        <ThemeToggle inline />
        <button onClick={handleLogout} className="mecha-logout">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
            <path d="M16 17l5-5-5-5M21 12H9" />
          </svg>
          打烊离店
        </button>
      </div>
    </div>
  );
};

export default Sidebar;
