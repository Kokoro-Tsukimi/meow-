import React, { useEffect, useState } from 'react';
import client from '../api/client';
import { useToast } from '../components/Toast';

interface CodeItem {
  id: number;
  code: string;
  amount: number;
  status: 'UNUSED' | 'USED';
  used_by: number | null;
  used_at: string | null;
  created_at: string;
}

export default function RedeemCodes() {
  const { toast, ToastContainer } = useToast();
  // 生成表单
  const [amount, setAmount] = useState('10');
  const [count, setCount] = useState('10');
  const [prefix, setPrefix] = useState('MEOW');
  const [baking, setBaking] = useState(false);

  // 刚生成的结果
  const [freshCodes, setFreshCodes] = useState<string[]>([]);
  const [copied, setCopied] = useState(false);

  // 历史列表
  const [history, setHistory] = useState<CodeItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [statusFilter, setStatusFilter] = useState('');
  const pageSize = 20;

  const fetchHistory = async () => {
    setLoading(true);
    try {
      console.info(`[ADMIN-PORTAL][CDK页][请求] page=${page}, status=${statusFilter}`);
      const res = await client.get('/api/v1/admin/redeem-codes', {
        params: { page, limit: pageSize, status: statusFilter },
      });
      setHistory(res.data.items || []);
      setTotal(res.data.total || 0);
    } catch (err: any) {
      console.error('[ADMIN-PORTAL][CDK页][失败]', err.response?.data?.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, statusFilter]);

  const handleBake = async (e: React.FormEvent) => {
    e.preventDefault();
    const amountNum = parseFloat(amount);
    const countNum = parseInt(count);

    if (isNaN(amountNum) || amountNum <= 0) {
      toast.error('面额必须大于0喵');
      return;
    }
    if (isNaN(countNum) || countNum < 1 || countNum > 1000) {
      toast.error('生成数量需在 1~1000 之间喵');
      return;
    }

    setBaking(true);
    setFreshCodes([]);
    try {
      console.info(`[ADMIN-PORTAL][CDK页][烘焙] 面额=${amountNum}, 数量=${countNum}`);
      const res = await client.post('/api/v1/admin/redeem-codes', {
        amount: amountNum,
        count: countNum,
        prefix: prefix.trim() || 'MEOW',
      });
      setFreshCodes(res.data.codes || []);
      await fetchHistory();
    } catch (err: any) {
      toast.error(`烘焙失败：${err.response?.data?.message || '未知错误'}`);
    } finally {
      setBaking(false);
    }
  };

  const handleCopyAll = async () => {
    if (freshCodes.length === 0) return;
    const text = freshCodes.join('\n');
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('复制失败，请手动选中复制喵');
    }
  };

  const handleExportTxt = () => {
    if (freshCodes.length === 0) return;
    const text = freshCodes.join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cdk_${prefix}_${amount}豆_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="mecha-content">
      <div style={{ marginBottom: '20px' }}>
        <h1 className="mecha-page-title">后厨烘焙坊</h1>
        <p className="mecha-page-sub">批量制作咖啡豆礼品卡（CDK），可导出去发卡网售卖喵🐾</p>
      </div>

      {/* 烘焙配方 */}
      <div className="mecha-card" style={{ marginBottom: '20px' }}>
        <h2 className="mecha-page-title" style={{ fontSize: '15px', marginBottom: '14px' }}>烘焙配方</h2>
        <form onSubmit={handleBake}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginBottom: '16px' }}>
            <div>
              <label className="mecha-label">单张面额（咖啡豆）</label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                className="mecha-input"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div>
              <label className="mecha-label">生成数量（1~1000）</label>
              <input
                type="number"
                min="1"
                max="1000"
                className="mecha-input"
                value={count}
                onChange={(e) => setCount(e.target.value)}
              />
            </div>
            <div>
              <label className="mecha-label">卡号前缀</label>
              <input
                type="text"
                maxLength={8}
                placeholder="MEOW"
                className="mecha-input"
                value={prefix}
                onChange={(e) => setPrefix(e.target.value)}
              />
            </div>
          </div>
          <button
            type="submit"
            disabled={baking}
            className="mecha-btn"
            style={{ width: 'auto', padding: '0 24px', height: '42px', letterSpacing: 'normal' }}
          >
            {baking ? '烘焙中...🔥' : '🎂 开始烘焙'}
          </button>
        </form>
      </div>

      {/* 出炉清单 */}
      {freshCodes.length > 0 && (
        <div className="mecha-card accent-top" style={{ marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
            <h2 className="mecha-page-title" style={{ fontSize: '15px', margin: 0 }}>
              新鲜出炉（{freshCodes.length} 张）
            </h2>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={handleCopyAll}
                className="mecha-btn"
                style={{ width: 'auto', padding: '0 16px', height: '34px', fontSize: '13px', letterSpacing: 'normal' }}
              >
                {copied ? '✅ 已复制!' : '📋 复制全部'}
              </button>
              <button
                onClick={handleExportTxt}
                className="mecha-row-btn"
                style={{ borderColor: 'var(--m-accent)', color: 'var(--m-accent)', padding: '0 16px', fontSize: '13px' }}
              >
                💾 导出TXT
              </button>
            </div>
          </div>
          <div
            className="mecha-code-block"
            style={{ maxHeight: '240px', overflowY: 'auto' }}
          >
            {freshCodes.map((code) => (
              <div key={code} style={{ padding: '1px 0' }} className="select-all">{code}</div>
            ))}
          </div>
        </div>
      )}

      {/* 历史记录 */}
      <div className="mecha-card">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' }}>
          <h2 className="mecha-page-title" style={{ fontSize: '15px', margin: 0 }}>历史卡密</h2>
          <select
            className="mecha-input"
            style={{ width: 'auto', height: '32px', fontSize: '13px', padding: '0 10px' }}
            value={statusFilter}
            onChange={(e) => {
              setPage(1);
              setStatusFilter(e.target.value);
            }}
          >
            <option value="">全部</option>
            <option value="UNUSED">未使用</option>
            <option value="USED">已使用</option>
          </select>
        </div>

        {loading && <p style={{ color: 'var(--m-text-sub)' }}>加载中...</p>}

        {!loading && history.length === 0 && (
          <p style={{ color: 'var(--m-text-faint)' }}>还没有生成过任何卡密喵~</p>
        )}

        {!loading && history.length > 0 && (
          <>
            <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--m-text-mute)', borderBottom: '1px solid var(--m-border)' }}>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>卡号</th>
                  <th style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 500 }}>面额</th>
                  <th style={{ padding: '8px 12px', textAlign: 'center', fontWeight: 500 }}>状态</th>
                  <th style={{ padding: '8px 12px', textAlign: 'left', fontWeight: 500 }}>生成时间</th>
                </tr>
              </thead>
              <tbody>
                {history.map((c) => (
                  <tr key={c.id} style={{ color: 'var(--m-text-sub)', borderTop: '1px solid var(--m-border-soft)' }}>
                    <td style={{ padding: '8px 12px', fontFamily: 'monospace' }}>{c.code}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'right' }}>{c.amount.toFixed(2)}</td>
                    <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                      <span
                        style={{
                          padding: '2px 8px',
                          fontSize: '11px',
                          borderRadius: '2px',
                          fontWeight: 500,
                          background: c.status === 'UNUSED' ? 'rgba(45,212,167,0.12)' : 'rgba(122,134,148,0.12)',
                          color: c.status === 'UNUSED' ? 'var(--m-ok)' : 'var(--m-text-mute)',
                          border: `1px solid ${c.status === 'UNUSED' ? 'var(--m-ok)' : 'var(--m-text-mute)'}`,
                        }}
                      >
                        {c.status === 'UNUSED' ? '未使用' : '已使用'}
                      </span>
                    </td>
                    <td style={{ padding: '8px 12px', fontSize: '11px', color: 'var(--m-text-faint)' }}>
                      {new Date(c.created_at).toLocaleString('zh-CN')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '16px' }}>
              <p style={{ fontSize: '13px', color: 'var(--m-text-mute)' }}>
                共 {total} 张，第 {page} / {totalPages} 页
              </p>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={() => setPage(Math.max(1, page - 1))}
                  disabled={page <= 1}
                  className="mecha-row-btn"
                  style={{ borderColor: 'var(--m-accent)', color: 'var(--m-accent)', padding: '6px 14px', fontSize: '13px', opacity: page <= 1 ? 0.3 : 1 }}
                >
                  上一页
                </button>
                <button
                  onClick={() => setPage(Math.min(totalPages, page + 1))}
                  disabled={page >= totalPages}
                  className="mecha-row-btn"
                  style={{ borderColor: 'var(--m-accent)', color: 'var(--m-accent)', padding: '6px 14px', fontSize: '13px', opacity: page >= totalPages ? 0.3 : 1 }}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      {ToastContainer}
    </div>
  );
}