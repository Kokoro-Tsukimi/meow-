import { useCallback, useRef, useState } from 'react';

/**
 * 浮层提示条 · 用户端版 (债务清理窗, 2026-07-05)
 * ------------------------------------------------------------
 * 取代散落各页的原生 alert():顶部居中浮出,3.2 秒后自动消失,
 * 可同时叠多条。复用 index.css 里沉睡已久的 meow-toast 系列样式,
 * error 档 CSS 里没有,用 --danger-strong 变量内联补上(零新增 CSS)。
 *
 * 用法:
 *
 *   const { showToast, ToastHost } = useToast();
 *
 *   showToast('操作失败喵', 'error');
 *   showToast('已保存~', 'success');
 *   showToast('提示一下');                // 默认 info
 *
 *   return <div>...{ToastHost}</div>;
 */

type ToastType = 'info' | 'success' | 'error';

interface ToastItem {
  id: number;
  message: string;
  type: ToastType;
}

const TOAST_DURATION_MS = 3200;

export function useToast() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const showToast = useCallback((message: string, type: ToastType = 'info') => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, TOAST_DURATION_MS);
  }, []);

  const ToastHost = toasts.length > 0 ? (
    <div
      style={{
        position: 'fixed',
        top: '20px',
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: 60, // 压在 meow-modal(50) 之上,弹窗里报错也看得见
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '8px',
        pointerEvents: 'none',
        maxWidth: '90vw',
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={
            t.type === 'error'
              ? 'meow-toast'
              : `meow-toast meow-toast-${t.type}`
          }
          style={{
            padding: '10px 18px',
            fontSize: '14px',
            maxWidth: '100%',
            wordBreak: 'break-word',
            ...(t.type === 'error'
              ? { background: 'var(--danger-strong)', color: '#fff' }
              : {}),
          }}
        >
          {t.message}
        </div>
      ))}
    </div>
  ) : null;

  return { showToast, ToastHost };
}
