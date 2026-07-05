import React, { useState, useEffect } from 'react';

/**
 * 主题切换公共组件
 * - 点击在 light / dark 之间切换
 * - 改 <html data-theme> 立即变色 + 存 localStorage('meow-theme') 记住选择
 * - 与 index.html 的防闪烁脚本配合：刷新后由那段脚本读 localStorage 恢复
 * - 纯图标 + 半透明圆底，浮在任意主题背景上都清晰
 * - 默认固定在左上角；传 inline 则不固定（供导航栏内嵌用）
 */
export default function ThemeToggle({ inline = false }: { inline?: boolean }) {
  // 读当前 <html> 上已有的 data-theme（防闪烁脚本已经设好了）
  const [theme, setTheme] = useState<'light' | 'dark'>('light');

  useEffect(() => {
    const current = document.documentElement.getAttribute('data-theme');
    setTheme(current === 'dark' ? 'dark' : 'light');
  }, []);

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('meow-theme', next);
    setTheme(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
      title={theme === 'dark' ? '切换到亮色主题' : '切换到暗色主题'}
      className={`meow-theme-toggle ${inline ? 'meow-theme-toggle--inline' : 'meow-theme-toggle--fixed'}`}
    >
      {/* 两个图标叠在一起，靠 opacity 淡入淡出切换 */}
      <span className={`meow-toggle-icon ${theme === 'light' ? 'is-active' : ''}`} aria-hidden="true">
        {/* 太阳 */}
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <line x1="12" y1="2" x2="12" y2="4" />
          <line x1="12" y1="20" x2="12" y2="22" />
          <line x1="2" y1="12" x2="4" y2="12" />
          <line x1="20" y1="12" x2="22" y2="12" />
          <line x1="4.9" y1="4.9" x2="6.3" y2="6.3" />
          <line x1="17.7" y1="17.7" x2="19.1" y2="19.1" />
          <line x1="4.9" y1="19.1" x2="6.3" y2="17.7" />
          <line x1="17.7" y1="6.3" x2="19.1" y2="4.9" />
        </svg>
      </span>
      <span className={`meow-toggle-icon ${theme === 'dark' ? 'is-active' : ''}`} aria-hidden="true">
        {/* 月亮 */}
        <svg viewBox="0 0 24 24" fill="currentColor">
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
      </span>
    </button>
  );
}
