import { useCallback, useRef, useState } from 'react';

/**
 * 通用确认弹窗 · 用户端版 (债务清理窗, 2026-07-05)
 * ------------------------------------------------------------
 * 从 admin 端 C 窗的 ConfirmDialog 移植而来:Hook 逻辑一比一保留,
 * 外观从机甲风换装为用户端马卡龙撞色风
 * (复用 index.css 已有的 meow-modal / meow-btn-* 系列,零新增 CSS)。
 *
 * 用法(与原 window.confirm 几乎一比一对应,替换成本低):
 *
 *   const { confirm, ConfirmDialog } = useConfirm();
 *
 *   const handleDelete = async () => {
 *     if (!(await confirm({ message: '确定删除吗喵？', danger: true }))) return;
 *     ...
 *   };
 *
 *   return <div>...{ConfirmDialog}</div>;
 *
 * 支持连续多道确认:连续 await confirm() 两次即可,每次都会弹新一轮。
 */

interface ConfirmOptions {
  /** 弹窗标题,不传时按 danger 给默认值 */
  title?: string;
  /** 正文,支持 \n 换行(渲染时按 pre-line 处理) */
  message: string;
  /** 确认按钮文案,默认"确定" */
  confirmText?: string;
  /** 取消按钮文案,默认"取消" */
  cancelText?: string;
  /** 危险操作(销毁/删除等):确认按钮变实心红 + 左侧描边变红 */
  danger?: boolean;
}

interface ConfirmState extends ConfirmOptions {
  isOpen: boolean;
}

const CLOSED_STATE: ConfirmState = {
  isOpen: false,
  message: '',
};

export function useConfirm() {
  const [state, setState] = useState<ConfirmState>(CLOSED_STATE);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    setState({ ...options, isOpen: true });
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const settle = useCallback((result: boolean) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setState(CLOSED_STATE);
  }, []);

  const handleConfirm = useCallback(() => settle(true), [settle]);
  const handleCancel = useCallback(() => settle(false), [settle]);

  const ConfirmDialog = state.isOpen ? (
    <>
      <div className="meow-modal-mask" onClick={handleCancel} />
      <div
        className="meow-modal"
        style={{
          maxWidth: '420px',
          ...(state.danger ? { borderLeft: '4px solid var(--danger-strong)' } : {}),
        }}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold meow-h">
            {state.title || (state.danger ? '⚠️ 危险操作确认' : '请确认喵')}
          </h2>
          <button
            onClick={handleCancel}
            className="meow-text-sub hover:opacity-100 text-2xl"
          >
            ×
          </button>
        </div>

        <p className="meow-text mb-6" style={{ whiteSpace: 'pre-line', lineHeight: 1.6 }}>
          {state.message}
        </p>

        <div className="flex gap-3">
          <button
            onClick={handleCancel}
            className="flex-1 meow-btn-ghost px-4 py-3"
          >
            {state.cancelText || '取消'}
          </button>
          <button
            onClick={handleConfirm}
            className={`flex-1 px-4 py-3 ${state.danger ? 'meow-btn-danger-solid' : 'meow-btn-primary'}`}
          >
            {state.confirmText || '确定'}
          </button>
        </div>
      </div>
    </>
  ) : null;

  return { confirm, ConfirmDialog };
}
