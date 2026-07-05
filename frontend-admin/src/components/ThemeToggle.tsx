import React, { useState, useEffect } from 'react';

/**
 * Admin 主题切换组件 —— 青 / 金 双色机甲
 * - 点击在 cyan / gold 之间切换
 * - 改 <html data-theme> 立即变色 + 存 localStorage('meow-admin-theme')
 * - 与 index.html 的防闪烁脚本配合：刷新后由那段脚本读 localStorage 恢复
 * - 图标：菱形闪光星 ✦（呼应配色卡），颜色跟随当前主题色
 * - 自带行内样式，不依赖 index.css 额外 class
 * - 默认 inline（供侧栏底部内嵌）；传 inline=false 则固定左上角
 */
export default function ThemeToggle({ inline = true }: { inline?: boolean }) {
  // 读当前 <html> 上已有的 data-theme（防闪烁脚本已经设好了）
  const [theme, setTheme] = useState<'cyan' | 'gold'>('cyan');

  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'gold' ? 'gold' : 'cyan');
  }, []);

  const toggle = () => {
    const next = theme === 'gold' ? 'cyan' : 'gold';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('meow-admin-theme', next);
    setTheme(next);
  };

  const fixedStyle: React.CSSProperties = {
    position: 'fixed',
    top: 16,
    left: 16,
    zIndex: 50,
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'gold' ? '切换到电光蓝主题' : '切换到荣耀金主题'}
      title={theme === 'gold' ? '切换到电光蓝主题' : '切换到荣耀金主题'}
      className="mecha-theme-toggle"
      style={inline ? undefined : fixedStyle}
    >
      {/* 菱形闪光星，颜色取当前主题强调色 */}
      <svg
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="currentColor"
        style={{ color: 'var(--m-accent)', transition: 'color 0.2s ease' }}
        aria-hidden="true"
      >
        <path d="M12 1.5c.4 4.6 2.4 6.6 7 7 -4.6 .4 -6.6 2.4 -7 7 -.4 -4.6 -2.4 -6.6 -7 -7 4.6 -.4 6.6 -2.4 7 -7z" />
      </svg>
    </button>
  );
}
