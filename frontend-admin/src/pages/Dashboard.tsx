import React, { useEffect, useState } from 'react';
import client from '../api/client';
import { useConfirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

interface DashboardMetrics {
  totalCallsToday: number;
  totalCostToday: number;
  totalUsers: number;
  activeTokens: number;
  recentLogs: Array<{
    id: number;
    user_id: number;
    amount: number;
    model: string | null;
    created_at: string;
  }>;
}

export default function Dashboard() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [metrics, setMetrics] = useState<DashboardMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');

  // F7 公告管理 state
  const [anns, setAnns] = useState<Array<{ id: number; title: string; content: string; status: string; created_at: string; updated_at: string }>>([]);
  const [annTitle, setAnnTitle] = useState('');
  const [annContent, setAnnContent] = useState('');
  const [annEditingId, setAnnEditingId] = useState<number | null>(null);
  const [annSaving, setAnnSaving] = useState(false);

  useEffect(() => {
    const fetchMetrics = async () => {
      try {
        console.info('[ADMIN-PORTAL][仪表盘][请求] 获取大盘数据');
        const res = await client.get('/api/v1/admin/dashboard/metrics');
        setMetrics(res.data);
        console.info('[ADMIN-PORTAL][仪表盘][成功] 数据已加载');
      } catch (err: any) {
        const msg = err.response?.data?.message || '加载失败';
        console.error('[ADMIN-PORTAL][仪表盘][失败]', msg);
        setErrorMsg(msg);
      } finally {
        setLoading(false);
      }
    };
    fetchMetrics();
  }, []);

  // F7 公告管理
  const fetchAnnouncements = async () => {
    try {
      const res = await client.get('/api/v1/admin/announcements');
      setAnns(res.data.items || []);
    } catch (err) {
      console.error('[ADMIN-PORTAL][公告][失败]', err);
    }
  };

  useEffect(() => {
    fetchAnnouncements();
  }, []);

  const resetAnnForm = () => {
    setAnnEditingId(null);
    setAnnTitle('');
    setAnnContent('');
  };

  const handleAnnSubmit = async () => {
    if (!annTitle.trim() || !annContent.trim()) {
      toast.error('标题和正文都要填喵');
      return;
    }
    setAnnSaving(true);
    try {
      if (annEditingId === null) {
        await client.post('/api/v1/admin/announcements', { title: annTitle, content: annContent });
      } else {
        await client.patch(`/api/v1/admin/announcements/${annEditingId}`, { title: annTitle, content: annContent });
      }
      resetAnnForm();
      await fetchAnnouncements();
    } catch (err: any) {
      toast.error(err.response?.data?.message || '保存失败喵');
    } finally {
      setAnnSaving(false);
    }
  };

  const handleAnnEdit = (a: { id: number; title: string; content: string }) => {
    setAnnEditingId(a.id);
    setAnnTitle(a.title);
    setAnnContent(a.content);
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
  };

  const handleAnnToggle = async (a: { id: number; status: string }) => {
    const next = a.status === 'ENABLE' ? 'DISABLE' : 'ENABLE';
    try {
      await client.patch(`/api/v1/admin/announcements/${a.id}`, { status: next });
      await fetchAnnouncements();
    } catch (err: any) {
      toast.error(err.response?.data?.message || '操作失败喵');
    }
  };

  const handleAnnDelete = async (id: number) => {
    if (!(await confirm({ message: '确定删除这条公告吗? 删了就找不回来了喵', danger: true }))) return;
    try {
      await client.delete(`/api/v1/admin/announcements/${id}`);
      if (annEditingId === id) resetAnnForm();
      await fetchAnnouncements();
    } catch (err: any) {
      toast.error(err.response?.data?.message || '删除失败喵');
    }
  };

  if (loading) {
    return (
      <div className="mecha-content">
        <h1 className="mecha-page-title">营业总览</h1>
        <p className="mecha-page-sub">正在加载店务数据喵...🐾</p>
      </div>
    );
  }

  if (errorMsg) {
    return (
      <div className="mecha-content">
        <h1 className="mecha-page-title">营业总览</h1>
        <div className="mecha-error" style={{ marginTop: '16px' }}>加载失败：{errorMsg}</div>
      </div>
    );
  }

  // 四张统计卡片：顶部硬边走主题强调色，数值也用强调色
  const cards = [
    { label: '今日总调用次数', value: metrics?.totalCallsToday ?? 0, unit: '次' },
    { label: '今日总消耗（咖啡豆）', value: (metrics?.totalCostToday ?? 0).toFixed(4), unit: '豆' },
    { label: '全站用户数', value: metrics?.totalUsers ?? 0, unit: '位主人' },
    { label: '活跃 Token 数', value: metrics?.activeTokens ?? 0, unit: '枚' },
  ];

  return (
    <div className="mecha-content">
      <h1 className="mecha-page-title">营业总览</h1>
      <p className="mecha-page-sub">店长好~ 这是您今日的店务概况喵🐾</p>

      {/* 四张统计卡片 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '24px' }}>
        {cards.map((card) => (
          <div key={card.label} className="mecha-card accent-top">
            <div className="mecha-stat-label">{card.label}</div>
            <div className="mecha-stat-value accent" style={{ marginTop: '4px' }}>
              {card.value}
              <span style={{ fontSize: '13px', fontWeight: 400, marginLeft: '4px', color: 'var(--m-text-mute)' }}>
                {card.unit}
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* 最近调用记录 */}
      <div className="mecha-card" style={{ marginBottom: '24px' }}>
        <h2 className="mecha-page-title" style={{ fontSize: '15px', marginBottom: '14px' }}>最近10条消费记录</h2>
        {metrics?.recentLogs && metrics.recentLogs.length > 0 ? (
          <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ color: 'var(--m-text-mute)', textAlign: 'left', borderBottom: '1px solid var(--m-border)' }}>
                <th style={{ padding: '8px 0', fontWeight: 500 }}>ID</th>
                <th style={{ padding: '8px 0', fontWeight: 500 }}>用户ID</th>
                <th style={{ padding: '8px 0', fontWeight: 500 }}>模型</th>
                <th style={{ padding: '8px 0', fontWeight: 500 }}>消耗</th>
                <th style={{ padding: '8px 0', fontWeight: 500 }}>时间</th>
              </tr>
            </thead>
            <tbody>
              {metrics.recentLogs.map((log) => (
                <tr key={log.id} style={{ color: 'var(--m-text-sub)', borderBottom: '1px solid var(--m-border-soft)' }}>
                  <td style={{ padding: '8px 0' }}>{log.id}</td>
                  <td style={{ padding: '8px 0' }}>{log.user_id}</td>
                  <td style={{ padding: '8px 0' }}>{log.model || '-'}</td>
                  {/* 消耗为扣费，用 danger 语义色（与 user 端同规矩） */}
                  <td style={{ padding: '8px 0', color: 'var(--m-danger)' }}>{Number(log.amount).toFixed(4)}</td>
                  <td style={{ padding: '8px 0', color: 'var(--m-text-faint)' }}>{new Date(log.created_at).toLocaleString('zh-CN')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={{ color: 'var(--m-text-faint)' }}>还没有任何消费记录喵~ 等小客人来光顾呢🍵</p>
        )}
      </div>

      {/* F7 公告管理 */}
      <div className="mecha-card">
        <h2 className="mecha-page-title" style={{ fontSize: '15px', marginBottom: '14px' }}>公告管理</h2>

        {/* 新建 / 编辑表单 */}
        <div style={{ marginBottom: '24px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <input
            type="text"
            value={annTitle}
            onChange={(e) => setAnnTitle(e.target.value)}
            placeholder="公告标题"
            className="mecha-input"
          />
          <textarea
            value={annContent}
            onChange={(e) => setAnnContent(e.target.value)}
            placeholder="公告正文(纯文本, 支持换行; 网址会自动变可点链接喵)"
            rows={4}
            className="mecha-input"
            style={{ height: 'auto', padding: '10px 12px', resize: 'vertical', lineHeight: 1.6 }}
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <button
              onClick={handleAnnSubmit}
              disabled={annSaving}
              className="mecha-btn"
              style={{ width: 'auto', padding: '0 18px', height: '36px', letterSpacing: 'normal' }}
            >
              {annSaving ? '保存中...' : annEditingId === null ? '发布公告' : '保存修改'}
            </button>
            {annEditingId !== null && (
              <button
                onClick={resetAnnForm}
                style={{ background: 'transparent', border: 'none', color: 'var(--m-text-mute)', fontSize: '13px', cursor: 'pointer' }}
              >
                取消编辑
              </button>
            )}
          </div>
        </div>

        {/* 公告列表(含下架, 下架的半透明显示)*/}
        {anns.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {anns.map((a) => (
              <div
                key={a.id}
                style={{
                  border: '1px solid var(--m-border)',
                  borderRadius: '3px',
                  padding: '14px',
                  opacity: a.status === 'ENABLE' ? 1 : 0.5,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <h3 style={{ fontWeight: 500, color: 'var(--m-text)', margin: 0 }}>{a.title}</h3>
                      <span
                        style={{
                          padding: '2px 8px',
                          fontSize: '11px',
                          borderRadius: '2px',
                          fontWeight: 500,
                          background: a.status === 'ENABLE' ? 'rgba(45,212,167,0.12)' : 'rgba(216,112,74,0.12)',
                          color: a.status === 'ENABLE' ? 'var(--m-ok)' : 'var(--m-danger)',
                          border: `1px solid ${a.status === 'ENABLE' ? 'var(--m-ok)' : 'var(--m-danger)'}`,
                        }}
                      >
                        {a.status === 'ENABLE' ? '上架中' : '已下架'}
                      </span>
                    </div>
                    <p style={{ fontSize: '13px', marginTop: '4px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', color: 'var(--m-text-sub)' }}>
                      {a.content}
                    </p>
                    <p style={{ fontSize: '11px', marginTop: '8px', color: 'var(--m-text-faint)' }}>
                      {new Date(a.created_at).toLocaleString('zh-CN')}
                    </p>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', flexShrink: 0 }}>
                    <button onClick={() => handleAnnEdit(a)} className="mecha-row-btn" style={{ borderColor: 'var(--m-accent)', color: 'var(--m-accent)' }}>编辑</button>
                    <button onClick={() => handleAnnToggle(a)} className="mecha-row-btn" style={{ borderColor: 'var(--m-warn)', color: 'var(--m-warn)' }}>{a.status === 'ENABLE' ? '下架' : '上架'}</button>
                    <button onClick={() => handleAnnDelete(a.id)} className="mecha-row-btn" style={{ borderColor: 'var(--m-danger)', color: 'var(--m-danger)' }}>删除</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: 'var(--m-text-faint)' }}>还没有公告喵~ 发一条让客人看看吧📢</p>
        )}
      </div>

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
