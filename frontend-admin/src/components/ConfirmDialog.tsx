import React, { useCallback, useRef, useState } from 'react';

/**
 * 通用确认弹窗 (C窗, 2026-06-30)
 * ------------------------------------------------------------
 * 取代 admin 端散落各页的 window.confirm(),外观走机甲风
 * (复用 index.css 里已有的 mecha-modal / mecha-btn / mecha-btn-ghost)。
 *
 * 用法(与原 window.confirm 用法几乎一比一对应,替换成本低):
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
 * 支持连续多道确认(如删会员先普通确认、余额>0 再追加一道警告):
 * 连续 await confirm() 两次即可,每次都会弹出新的一轮对话框。
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
  /** 危险操作(删除/封号/拉黑等):确认按钮变红 + 左侧描边变红 */
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
      <div className="mecha-modal-mask" onClick={handleCancel} />
      <div
        className="mecha-modal"
        style={state.danger ? { borderLeftColor: 'var(--m-danger)' } : undefined}
      >
        <div className="mecha-modal-head">
          <h2 className="mecha-modal-title">
            {state.title || (state.danger ? '⚠️ 危险操作确认' : '请确认')}
          </h2>
          <button onClick={handleCancel} className="mecha-modal-close">×</button>
        </div>

        <p className="mecha-confirm-msg">{state.message}</p>

        <div style={{ display: 'flex', gap: '12px' }}>
          <button
            onClick={handleCancel}
            className="mecha-btn-ghost"
            style={{ flex: 1, height: '40px' }}
          >
            {state.cancelText || '取消'}
          </button>
          <button
            onClick={handleConfirm}
            className={state.danger ? 'mecha-btn-danger' : 'mecha-btn'}
            style={{ flex: 1, letterSpacing: state.danger ? 'normal' : undefined }}
          >
            {state.confirmText || '确定'}
          </button>
        </div>
      </div>
    </>
  ) : null;

  return { confirm, ConfirmDialog };
}
