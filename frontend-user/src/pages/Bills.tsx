import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client';
import { useConfirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

interface Bill {
  id: string;
  type: string;          // CONSUME(消费) / TOPUP(充值) / REFUND(退款)
  amount: number;        // 正数=进账, 负数=扣费
  model: string;
  reference_id: string;
  created_at: string;
}

// F.5 GET /api/v1/user/bills/:id/details 返回结构(B0 后端扩展后)
//   cached:true / false 两种情况都带 meta 字段(段 ②③④);只有 cached:true 才有 response_body
interface BillDetails {
  cached: boolean;
  trace_id: string;
  message?: string;
  response_body?: string;
  cached_at?: string;
  expires_at?: string;
  // 段 ②③④ 元数据(LEFT JOIN Logs, 货架空也能拿到)
  balance_after: number | null;
  status_code: number | null;
  prompt_tokens: number | null;
  cached_tokens: number | null;      // F5.3: NULL=上游未回传(与 0=零命中分家)
  completion_tokens: number | null;
  latency_upstream_ms: number | null;
  latency_proxy_ms: number | null;
  is_stream: number | null;  // F5.2: 0/1, LEFT JOIN 失配时 null
  is_estimated: number | null;  // F5.4: 1=估算账单(断连白嫖漏洞防御), 0=正常, LEFT JOIN 失配时 null
}

// 把账单类型翻译成主人看得懂的文字喵
function billLabel(bill: Bill): string {
  if (bill.type === 'TOPUP') return '☕ 咖啡豆充值';
  if (bill.type === 'REFUND') return '↩️ 退款';
  // 消费类:显示模型名;万一model是脏数据(system等)就兜底
  if (!bill.model || bill.model === 'system') return 'API 调用';
  return bill.model;
}

// 账单类型中文:用在详情段 ①
function billTypeLabel(type: string): string {
  if (type === 'CONSUME') return '消费';
  if (type === 'TOPUP') return '充值';
  if (type === 'REFUND') return '退款';
  return type;
}

// ms 智能格式化:>=1000 ms 用 s, 否则 ms
function formatLatency(ms: number | null): string {
  if (ms === null || ms === undefined) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms} ms`;
}

// HTTP 状态码徽章配色:2xx 绿、3xx 蓝、4xx 黄、5xx 红、其他灰（语义色，亮暗通用）
function statusCodeStyle(code: number | null): { bg: string; fg: string; label: string } {
  if (code === null || code === undefined) return { bg: '#F3F4F6', fg: '#6B7280', label: '—' };
  const label = String(code);
  if (code >= 200 && code < 300) return { bg: '#D1FAE5', fg: '#065F46', label };
  if (code >= 300 && code < 400) return { bg: '#DBEAFE', fg: '#1E40AF', label };
  if (code >= 400 && code < 500) return { bg: '#FEF3C7', fg: '#92400E', label };
  if (code >= 500) return { bg: '#FEE2E2', fg: '#991B1B', label };
  return { bg: '#F3F4F6', fg: '#6B7280', label };
}

export default function Bills() {
  const [bills, setBills] = useState<Bill[]>([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [page, setPage] = useState(1);          // G-7.1 当前页码
  const [total, setTotal] = useState(0);        // G-7.1 账单总条数(后端一直有返, 前端今日才接)
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  const { confirm, ConfirmDialog } = useConfirm();
  const { showToast, ToastHost } = useToast();

  // F.5 详情抽屉状态
  const [detailBill, setDetailBill] = useState<Bill | null>(null);  // 当前打开的列表项;非 null 即 modal 开
  const [detailData, setDetailData] = useState<BillDetails | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string>('');
  const [removing, setRemoving] = useState(false);
  const [copyHint, setCopyHint] = useState<string>('');             // 复制成功的临时提示文案

  const fetchBills = async () => {
    setLoading(true);
    try {
      console.info('[USER-PORTAL][Bills][Fetch] Fetching bills');
      // G-7.1 真·翻页: 后端 /bills 一直支持 page+total, 前端今日补上 UI
      let url = `/api/v1/user/bills?page=${page}&limit=20`;
      if (startDate) url += `&startDate=${startDate}`;
      if (endDate) url += `&endDate=${endDate}`;

      const response = await apiClient.get(url);
      setBills(response.data.items || []);
      setTotal(response.data.total || 0);
    } catch (error) {
      console.error('Error fetching bills:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchBills();
  }, [startDate, endDate, page]);

  // G-7.1 改日期筛选时回到第 1 页(避免停在超出新结果范围的页码)
  useEffect(() => {
    setPage(1);
  }, [startDate, endDate]);

  // F.5 打开详情抽屉:只 CONSUME 有详情,其他类型静默忽略点击
  const openDetail = async (bill: Bill) => {
    if (bill.type !== 'CONSUME') return;
    setDetailBill(bill);
    setDetailData(null);
    setDetailError('');
    setCopyHint('');
    setDetailLoading(true);
    try {
      console.info(`[USER-PORTAL][Bills][详情] 拉取 bill ${bill.id}`);
      const res = await apiClient.get(`/api/v1/user/bills/${bill.id}/details`);
      setDetailData(res.data);
    } catch (err: any) {
      const msg = err.response?.data?.message || '加载详情失败';
      setDetailError(msg);
    } finally {
      setDetailLoading(false);
    }
  };

  const closeDetail = () => {
    setDetailBill(null);
    setDetailData(null);
    setDetailError('');
    setCopyHint('');
    setRemoving(false);
  };

  // 通用复制 + 1.5 秒提示
  const handleCopy = async (text: string, hint: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyHint(hint);
      setTimeout(() => setCopyHint((cur) => (cur === hint ? '' : cur)), 1500);
    } catch {
      showToast('复制失败,请手动选中复制喵', 'error');
    }
  };

  // 立即从货架移除响应原文(F.5 DELETE /bills/:id/cache)
  const handleRemoveCache = async () => {
    if (!detailBill) return;
    const ok = await confirm({
      title: '📦 货架移除确认',
      message: '确定从货架立即移除这条响应原文吗?\n移除后无法恢复喵~',
      confirmText: '移除',
      cancelText: '再想想',
      danger: true,
    });
    if (!ok) return;
    setRemoving(true);
    try {
      await apiClient.delete(`/api/v1/user/bills/${detailBill.id}/cache`);
      // 重新拉详情(此时应 cached:false)
      const res = await apiClient.get(`/api/v1/user/bills/${detailBill.id}/details`);
      setDetailData(res.data);
      showToast('响应原文已从货架移除喵~', 'success');
    } catch (err: any) {
      showToast(err.response?.data?.message || '移除失败', 'error');
    } finally {
      setRemoving(false);
    }
  };

  // ESC 键关闭抽屉
  useEffect(() => {
    if (!detailBill) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDetail();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [detailBill]);

  const formatDate = (isoString: string) => {
    const d = new Date(isoString);
    if (isNaN(d.getTime())) return isoString;
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  };

  return (
    <div className="min-h-screen p-4 md:p-8 font-harmony">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-8 flex-wrap gap-4">
          <h1 className="text-3xl font-black meow-h flex items-center gap-3">
            消费小票夹 🧾
          </h1>

          <div className="meow-filter-box flex w-full sm:w-auto gap-2 sm:gap-4 items-center px-4 py-2 rounded-2xl">
            <input
              type="date"
              className="flex-1 min-w-0 sm:flex-none bg-transparent meow-text outline-none meow-date-input"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
            />
            <span className="meow-text-sub">至</span>
            <input
              type="date"
              className="flex-1 min-w-0 sm:flex-none bg-transparent meow-text outline-none meow-date-input"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
            />
          </div>
        </div>

        <div className="meow-card p-5 md:p-8 min-h-[500px]">
          {loading ? (
            <div className="h-full flex items-center justify-center meow-text-sub">加载中喵...</div>
          ) : bills.length > 0 ? (
            <div className="space-y-4">
              {bills.map(bill => (
                <div
                  key={bill.id}
                  onClick={() => openDetail(bill)}
                  className={`meow-bill-row flex items-center justify-between p-5 rounded-2xl border-l-4 border-transparent transition-all group ${bill.type === 'CONSUME' ? 'cursor-pointer' : 'cursor-default'}`}
                  title={bill.type === 'CONSUME' ? '点击查看详情' : '此类账单无详情可查'}
                >
                  <div className="flex flex-col overflow-hidden mr-4">
                    <span className="meow-h font-bold text-lg truncate" title={billLabel(bill)}>
                      {billLabel(bill)}
                    </span>
                    <span className="meow-text-sub text-sm">
                      {formatDate(bill.created_at || new Date().toISOString())}
                    </span>
                  </div>
                  <div className={`font-bold whitespace-nowrap ${bill.amount >= 0 ? 'meow-amount-plus' : 'meow-amount-minus'}`}>
                    {bill.amount >= 0 ? '+' : ''}{bill.amount} 豆
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="h-[400px] flex flex-col items-center justify-center meow-text-sub">
              <div className="text-4xl mb-4 animate-float">☕</div>
              <p>还没有消费记录喵~ 🐾</p>
            </div>
          )}
        </div>

        {/* G-7.1 翻页脚(复用 G-4 公告历史的描边按钮风) */}
        {!loading && total > 20 && (
          <div className="flex items-center justify-center gap-4 mt-6">
            <button
              className="meow-page-btn"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              ← 上一页
            </button>
            <span className="meow-text-sub text-sm whitespace-nowrap">
              第 {page} / {Math.max(1, Math.ceil(total / 20))} 页
            </span>
            <button
              className="meow-page-btn"
              disabled={page >= Math.ceil(total / 20)}
              onClick={() => setPage((p) => p + 1)}
            >
              下一页 →
            </button>
          </div>
        )}
      </div>

      {/* F.5 详情抽屉(5 段 Modal) */}
      {detailBill && (
        <>
          <div className="meow-modal-mask" onClick={closeDetail} />
          <div
            className="meow-modal meow-bill-modal"
            style={{ maxWidth: '720px', maxHeight: '90vh', overflowY: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 头部 */}
            <div className="flex items-center justify-between mb-6 sticky top-0 meow-modal-head pb-2 z-10">
              <h2 className="text-2xl font-bold meow-h flex items-center gap-2">
                🧾 账单详情
              </h2>
              <div className="flex items-center gap-3">
                {copyHint && (
                  <span className="text-sm meow-amount-plus font-medium">✅ {copyHint}</span>
                )}
                <button
                  onClick={closeDetail}
                  className="meow-text-sub hover:opacity-100 text-2xl leading-none px-2"
                  title="关闭(Esc)"
                >×</button>
              </div>
            </div>

            {detailLoading && (
              <p className="meow-text-sub text-center py-12">正在拉取详情喵...</p>
            )}

            {detailError && !detailLoading && (
              <div className="meow-price-box rounded-2xl p-4 meow-text border-l-4 border-amber-400">
                ⚠️ {detailError}
              </div>
            )}

            {detailData && !detailLoading && !detailError && (
              <div className="space-y-5">
                {/* F5.4: 估算账单警告条(断连白嫖漏洞防御). 琥珀色 inline style, 不依赖主题 CSS 变量, 深浅两套皮肤通用喵 */}
                {detailData.is_estimated === 1 && (
                  <div
                    style={{
                      padding: '12px 14px',
                      borderRadius: '10px',
                      background: 'rgba(251, 191, 36, 0.12)',
                      border: '1px solid rgba(251, 191, 36, 0.4)',
                      color: '#d97706',
                      fontSize: '13px',
                      lineHeight: '1.6',
                    }}
                  >
                    ⚠️ <strong>估算账单</strong>：此次请求在上游回传完整用量前被断开了喵。
                    账单按已发出的字符数估算 tokens，原则为“宁少勿多”，实际用量可能略高于此数。
                  </div>
                )}
                {/* ===== 段 ① 基本信息 ===== */}
                <section>
                  <h3 className="text-sm font-bold meow-accent mb-2 pb-1 meow-section-line">
                    📋 基本信息
                  </h3>
                  <div className="grid grid-cols-[110px_1fr] gap-y-2 text-sm">
                    <span className="meow-text-sub">时间</span>
                    <span className="meow-text">{formatDate(detailBill.created_at)}</span>
                    <span className="meow-text-sub">类型</span>
                    <span className="meow-text">{billTypeLabel(detailBill.type)}</span>
                    <span className="meow-text-sub">模型</span>
                    <span className="meow-text">{billLabel(detailBill)}</span>
                    <span className="meow-text-sub">Trace ID</span>
                    <span className="meow-text flex items-center gap-2 min-w-0">
                      <span className="font-mono text-xs truncate" title={detailData.trace_id}>
                        {detailData.trace_id}
                      </span>
                      <button
                        onClick={() => handleCopy(detailData.trace_id, 'Trace ID 已复制')}
                        className="text-xs meow-accent hover:opacity-80 whitespace-nowrap"
                        title="复制 Trace ID"
                      >📋</button>
                    </span>
                  </div>
                </section>

                {/* ===== 段 ② 计费明细 ===== */}
                <section>
                  <h3 className="text-sm font-bold meow-accent mb-2 pb-1 meow-section-line">
                    💰 计费明细
                  </h3>
                  <div className="grid grid-cols-[110px_1fr] gap-y-2 text-sm">
                    <span className="meow-text-sub">本笔金额</span>
                    <span className={`font-bold ${detailBill.amount >= 0 ? 'meow-amount-plus' : 'meow-amount-minus'}`}>
                      {detailBill.amount >= 0 ? '+' : ''}{detailBill.amount.toFixed(4)} 豆
                    </span>
                    {detailData.balance_after !== null && (
                      <>
                        <span className="meow-text-sub">之后余额</span>
                        <span className="meow-text">{detailData.balance_after.toFixed(4)} 豆</span>
                      </>
                    )}
                  </div>
                </section>

                {/* ===== 段 ③ 上游元数据 ===== */}
                <section>
                  <h3 className="text-sm font-bold meow-accent mb-2 pb-1 meow-section-line">
                    📡 上游元数据
                  </h3>
                  <div className="grid grid-cols-[110px_1fr] gap-y-2 text-sm">
                    <span className="meow-text-sub">状态码</span>
                    <span>
                      {(() => {
                        const s = statusCodeStyle(detailData.status_code);
                        return (
                          <span
                            className="px-2 py-0.5 rounded-full text-xs font-medium"
                            style={{ backgroundColor: s.bg, color: s.fg }}
                          >
                            {s.label}
                          </span>
                        );
                      })()}
                    </span>
                    {/* F5.2: 流式响应标志(从响应 Content-Type 推断) */}
                    <span className="meow-text-sub">响应模式</span>
                    <span className="meow-text">
                      {detailData.is_stream === 1 ? '🌊 流式 (SSE)' : detailData.is_stream === 0 ? '📦 一次性' : '—'}
                    </span>
                    <span className="meow-text-sub">输入 tokens</span>
                    <span className="meow-text">{detailData.prompt_tokens ?? '—'}</span>
                    <span className="meow-text-sub">缓存命中</span>
                    <span className={detailData.cached_tokens !== null && detailData.cached_tokens !== undefined ? 'meow-text' : 'meow-text-sub'}>
                      {detailData.cached_tokens !== null && detailData.cached_tokens !== undefined
                        ? `${detailData.cached_tokens} tokens`
                        : '未回传'}
                    </span>
                    <span className="meow-text-sub">输出 tokens</span>
                    <span className="meow-text">{detailData.completion_tokens ?? '—'}</span>
                    {detailData.prompt_tokens !== null && detailData.completion_tokens !== null && (
                      <>
                        <span className="meow-text-sub">总 tokens</span>
                        <span className="meow-text font-medium">
                          {detailData.prompt_tokens + detailData.completion_tokens}
                        </span>
                      </>
                    )}
                  </div>
                </section>

                {/* ===== 段 ④ 性能指标 ===== */}
                <section>
                  <h3 className="text-sm font-bold meow-accent mb-2 pb-1 meow-section-line">
                    ⚡ 性能指标
                  </h3>
                  <div className="grid grid-cols-[110px_1fr] gap-y-2 text-sm">
                    <span className="meow-text-sub">上游耗时</span>
                    <span className="meow-text">{formatLatency(detailData.latency_upstream_ms)}</span>
                    <span className="meow-text-sub">网关耗时</span>
                    <span className="meow-text">{formatLatency(detailData.latency_proxy_ms)}</span>
                    {detailData.latency_upstream_ms !== null && detailData.latency_proxy_ms !== null && (
                      <>
                        <span className="meow-text-sub">总耗时</span>
                        <span className="meow-text font-medium">
                          {formatLatency(detailData.latency_upstream_ms + detailData.latency_proxy_ms)}
                        </span>
                      </>
                    )}
                  </div>
                </section>

                {/* ===== 段 ⑤ 响应原文 ===== */}
                <section>
                  <h3 className="text-sm font-bold meow-accent mb-2 pb-1 meow-section-line flex items-center justify-between">
                    <span>📜 响应原文</span>
                    {detailData.cached && detailData.response_body && (
                      <span className="flex items-center gap-2 text-xs font-normal">
                        <button
                          onClick={() => handleCopy(detailData.response_body || '', '响应原文已复制')}
                          className="px-2 py-1 meow-btn-ghost rounded-lg"
                          style={{ borderWidth: '1px' }}
                        >📋 复制</button>
                        <button
                          onClick={handleRemoveCache}
                          disabled={removing}
                          className="px-2 py-1 meow-btn-danger rounded-lg"
                          style={{ borderWidth: '1px' }}
                        >{removing ? '移除中...' : '🗑️ 立即移除'}</button>
                      </span>
                    )}
                  </h3>

                  {detailData.cached && detailData.response_body ? (
                    <div>
                      <pre className="meow-code-block rounded-2xl p-4 text-xs font-mono overflow-auto max-h-96 whitespace-pre-wrap break-words">
                        {detailData.response_body}
                      </pre>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs meow-text-sub mt-2">
                        {detailData.cached_at && (
                          <span>保留于:{formatDate(detailData.cached_at)}</span>
                        )}
                        {detailData.expires_at && (
                          <span>到期:{formatDate(detailData.expires_at)}</span>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="meow-price-box rounded-2xl p-4 text-sm meow-text border-l-4 border-amber-300">
                      {detailData.message || '此次请求的响应原文未保留(诊断模式未开启或已过期)'}
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>
        </>
      )}
      {ConfirmDialog}
      {ToastHost}
    </div>
  );
}
