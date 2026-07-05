import React, { useCallback, useRef, useState } from 'react';

/**
 * 轻量 toast 提示条 (C窗, 2026-06-30)
 * ------------------------------------------------------------
 * 取代 admin 端散落各页的 window.alert(),外观走机甲风原创
 * (曜石黑底 + 左侧色条,呼应 mecha-modal 的设计语言;
 *  不套用 user 端的 meow-toast —— 那套是松石蓝×玫红皮肤,
 *  两端主题完全不同,原创一套反而更干净)。
 *
 * 用法(与原 alert 用法几乎一比一对应,替换成本低):
 *
 *   const { toast, ToastContainer } = useToast();
 *
 *   toast.success('操作成功喵');
 *   toast.error(`删除失败：${msg}`);
 *
 *   return <div>...{ToastContainer}</div>;
 *
 * 固定挂在右下角,多条自动堆叠,3.2s 后自动消失,也可点 × 手动关。
 */

type ToastType = 'success' | 'error' | 'info';

interface ToastItem {
  id: number;
  type: ToastType;
  message: string;
  leaving?: boolean;
}

const ICONS: Record<ToastType, string> = {
  success: '✅',
  error: '❌',
  info: 'ℹ️',
};

const AUTO_DISMISS_MS = 3200;
const LEAVE_ANIM_MS = 180;

export function useToast() {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => {
    // 先标记退场动画,播完再真正从列表摘除
    setItems((prev) => prev.map((t) => (t.id === id ? { ...t, leaving: true } : t)));
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, LEAVE_ANIM_MS);
  }, []);

  const push = useCallback((type: ToastType, message: string) => {
    const id = ++idRef.current;
    setItems((prev) => [...prev, { id, type, message }]);
    setTimeout(() => remove(id), AUTO_DISMISS_MS);
  }, [remove]);

  const toast = {
    success: (message: string) => push('success', message),
    error: (message: string) => push('error', message),
    info: (message: string) => push('info', message),
  };

  const ToastContainer = items.length > 0 ? (
    <div className="mecha-toast-container">
      {items.map((t) => (
        <div
          key={t.id}
          className={`mecha-toast ${t.type}${t.leaving ? ' leaving' : ''}`}
        >
          <span className="mecha-toast-icon">{ICONS[t.type]}</span>
          <span className="mecha-toast-msg">{t.message}</span>
          <button className="mecha-toast-close" onClick={() => remove(t.id)}>×</button>
        </div>
      ))}
    </div>
  ) : null;

  return { toast, ToastContainer };
}
