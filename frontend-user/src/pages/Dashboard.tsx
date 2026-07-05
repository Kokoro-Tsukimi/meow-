import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { BarChart, Bar, AreaChart, Area, XAxis, YAxis, CartesianGrid, ResponsiveContainer, Tooltip } from 'recharts';
import { apiClient } from '../api/client';
import MarkdownContent from '../components/MarkdownContent';

interface UserInfo {
  balance: number;
}

// G-7 每日消费统计(后端 /bills/daily-stats 返回体)
interface DailyStats {
  start_date: string;
  end_date: string;
  spend: Array<{ date: string; model: string; amount: number; calls: number }>;
  tokens: Array<{ date: string; prompt_tokens: number; completion_tokens: number; cached_tokens?: number; calls?: number; unreported_calls?: number }>;
}

const COLORS = ['#8B6344', '#FFB7C5', '#E8D5C4', '#5C3D2E', '#D9A05B'];

// G-7 数字与日期小工具: 豆数去尾零(0.00260 → 0.0026), 日期短标签(2026-06-24 → 6/24)
const fmtBean = (n: number) => parseFloat(Number(n).toFixed(5)).toString();
const shortDate = (d: string) => {
  const parts = String(d).split('-');
  return parts.length === 3 ? `${+parts[1]}/${+parts[2]}` : d;
};
// 'system' 是后端对"无模型名的系统性扣费"的兜底标签, 展示时翻译成人话
const modelLabel = (m: string) => (m === 'system' ? 'API 调用' : m);

// G-7 共用悬浮提示框(消费图带合计行, 其余图单行)
const tipBoxStyle: React.CSSProperties = {
  background: 'var(--card-bg)',
  border: '1px solid var(--card-border)',
  borderRadius: 12,
  padding: '8px 12px',
  fontSize: 12,
  color: 'var(--text-body-c)',
  maxWidth: 260,
};
const ChartTooltip = ({ active, payload, label, unit, showTotal }: any) => {
  if (!active || !payload || !payload.length) return null;
  const fmt = (v: number) => (unit === '豆' ? fmtBean(v) : Number(v).toLocaleString());
  const total = payload.reduce((s: number, p: any) => s + (Number(p.value) || 0), 0);
  return (
    <div style={tipBoxStyle}>
      <div style={{ fontWeight: 700, marginBottom: 4, color: 'var(--text-title-c)' }}>{label}</div>
      {payload.map((p: any) => (
        <div key={p.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: p.color, display: 'inline-block', flexShrink: 0 }}></span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
          <b style={{ marginLeft: 12, whiteSpace: 'nowrap' }}>{fmt(p.value)} {unit}</b>
        </div>
      ))}
      {showTotal && payload.length > 1 && (
        <div style={{ marginTop: 4, paddingTop: 4, borderTop: '1px solid var(--card-border)', textAlign: 'right', fontWeight: 700, color: 'var(--text-title-c)' }}>
          合计 {fmt(total)} {unit}
        </div>
      )}
      {payload[0]?.payload?.__note ? (
        <div style={{ marginTop: 4, opacity: 0.85 }}>{payload[0].payload.__note}</div>
      ) : null}
    </div>
  );
};

// G-7 图例小方块行
const ChartLegend = ({ entries }: { entries: Array<{ label: string; color: string }> }) => (
  <div className="flex flex-wrap gap-x-4 gap-y-1 mb-2 text-xs meow-text-sub">
    {entries.map((e) => (
      <span key={e.label} className="flex items-center gap-1.5">
        <span style={{ width: 8, height: 8, borderRadius: 2, background: e.color, display: 'inline-block' }}></span>
        {e.label}
      </span>
    ))}
  </div>
);

// G-7 三图共用的轴样式
const axisTick = { fill: 'var(--text-sub-c)', fontSize: 11 };

export default function Dashboard() {
  const [balance, setBalance] = useState<number>(0);
  const [stats, setStats] = useState<DailyStats | null>(null);

  // G-7.1 按月查看(DeepSeek 同款): 默认本月, ‹ › 切换, 三张图共用一个月份
  const nowD = new Date();
  const curMonth = `${nowD.getFullYear()}-${String(nowD.getMonth() + 1).padStart(2, '0')}`;
  const [statsMonth, setStatsMonth] = useState<string>(curMonth);
  const stepMonth = (m: string, delta: number) => {
    const [y, mo] = m.split('-').map(Number);
    const d = new Date(Date.UTC(y, mo - 1 + delta, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  };
  const monthLabel = (m: string) => {
    const [y, mo] = m.split('-');
    return `${y} 年 ${+mo} 月`;
  };
  const navigate = useNavigate();

  // F6 每日签到 state
  const [checkin, setCheckin] = useState<{ checked_in: boolean; enabled: boolean; reward: number } | null>(null);
  const [checkinLoading, setCheckinLoading] = useState(false);
  const [checkinToast, setCheckinToast] = useState('');

  // F7 公告栏 state(只读, 最新 3 条)
  const [anns, setAnns] = useState<Array<{ id: number; title: string; content: string; created_at: string }>>([]);

  useEffect(() => {
    fetchData();
  }, []);

  // G-7.1 月份统计单独拉取, 切月即刷新, 与其余数据解耦
  useEffect(() => {
    let cancelled = false;
    console.info(`[USER-PORTAL][Dashboard][Fetch] daily-stats month=${statsMonth}`);
    apiClient.get(`/api/v1/user/bills/daily-stats?month=${statsMonth}`)
      .then((res) => { if (!cancelled) setStats(res.data || null); })
      .catch((err) => { console.error('Error fetching daily stats:', err); });
    return () => { cancelled = true; };
  }, [statsMonth]);

  const fetchData = async () => {
    try {
      console.info('[USER-PORTAL][Dashboard][Fetch] Fetching user info and daily stats');
      const [infoRes, checkinRes, annRes] = await Promise.all([
        apiClient.get('/api/v1/user/info'),
        apiClient.get('/api/v1/user/checkin/status'),
        apiClient.get('/api/v1/user/announcements')
      ]);
      setBalance(infoRes.data.balance || 0);
      setCheckin(checkinRes.data);
      setAnns(annRes.data.items || []);
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    }
  };

  // G-7 图表数据组装: 铺满 30 天日轴(没数据的日子补 0), 模型按总消费降序定色
  const chart = useMemo(() => {
    if (!stats) {
      return { days: [] as any[], models: [] as string[], callsData: [] as any[], tokenData: [] as any[], hasSpend: false, hasTokens: false, hasCached: false };
    }
    const dayKeys: string[] = [];
    const startMs = new Date(`${stats.start_date}T00:00:00Z`).getTime();
    const endMs = new Date(`${stats.end_date}T00:00:00Z`).getTime();
    if (Number.isFinite(startMs) && Number.isFinite(endMs)) {
      for (let t = startMs; t <= endMs; t += 86400000) {
        const d = new Date(t);
        dayKeys.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`);
      }
    }
    const totals: Record<string, number> = {};
    stats.spend.forEach((r) => { totals[r.model] = (totals[r.model] || 0) + r.amount; });
    const models = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);

    const spendMap: Record<string, Record<string, number>> = {};
    const callsMap: Record<string, number> = {};
    stats.spend.forEach((r) => {
      (spendMap[r.date] = spendMap[r.date] || {})[r.model] = r.amount;
      callsMap[r.date] = (callsMap[r.date] || 0) + r.calls;
    });
    // F5.3 数据诚实原则: 命中段是"已知下界"(只统计有回传的调用); 有未回传时提示框里明说
    const tokenMap: Record<string, { pt: number; ct: number; ch: number; note: string }> = {};
    stats.tokens.forEach((r) => {
      const pt = r.prompt_tokens || 0;
      const ch = Math.min(r.cached_tokens || 0, pt);
      const un = r.unreported_calls || 0;
      const calls = r.calls || 0;
      const note = un > 0 && calls > 0 ? `⚠️ 该日 ${un}/${calls} 笔调用未回传缓存数据` : '';
      tokenMap[r.date] = { pt, ct: r.completion_tokens || 0, ch, note };
    });

    const days = dayKeys.map((d) => {
      const row: Record<string, any> = { date: d };
      models.forEach((m) => { row[m] = spendMap[d]?.[m] || 0; });
      return row;
    });
    const callsData = dayKeys.map((d) => ({ date: d, 调用次数: callsMap[d] || 0 }));
    const tokenData = dayKeys.map((d) => {
      const t = tokenMap[d];
      const pt = t?.pt || 0;
      const ch = t?.ch || 0;
      return {
        date: d,
        命中缓存: ch,
        其余输入: Math.max(0, pt - ch),
        输出: t?.ct || 0,
        __note: t?.note || '',
      };
    });
    const hasCached = stats.tokens.some((r) => (r.cached_tokens || 0) > 0);
    const hasTokens = stats.tokens.some((r) => (r.prompt_tokens || 0) + (r.completion_tokens || 0) > 0);
    return { days, models, callsData, tokenData, hasSpend: models.length > 0, hasTokens, hasCached };
  }, [stats]);

  const handleLogout = () => {
    console.info('[USER-PORTAL][Dashboard][Action] Logout');
    localStorage.removeItem('token');
    navigate('/login');
  };

  // F6 每日签到:点一下领豆。后端 409=今天已签(也置已签态), 其它错误弹提示
  const handleCheckin = async () => {
    if (checkin?.checked_in || checkinLoading) return;
    setCheckinLoading(true);
    try {
      console.info('[USER-PORTAL][Dashboard][Action] 签到');
      const res = await apiClient.post('/api/v1/user/checkin');
      setBalance(res.data.balance);
      setCheckin((prev) => (prev ? { ...prev, checked_in: true } : prev));
      setCheckinToast(`签到成功! 领到 ${res.data.reward} 颗咖啡豆喵~ 🐾`);
    } catch (err: any) {
      if (err?.response?.status === 409) {
        setCheckin((prev) => (prev ? { ...prev, checked_in: true } : prev));
        setCheckinToast('今天已经签到过了喵~');
      } else {
        setCheckinToast(err?.response?.data?.message || '签到失败, 稍后再试喵');
      }
    } finally {
      setCheckinLoading(false);
      setTimeout(() => setCheckinToast(''), 3000);
    }
  };

  // F.1.7 注销账号入口已迁移到「客人餐桌」页(/profile),不在 Dashboard 重复实现
  // F7 的 linkify 已被 G-6 Markdown 渲染取代(MarkdownContent 组件, gfm 自动识别裸链接)
  // G-7 饼图退役: 只能看"钱花在哪", 换成三张近30日时序图(消费/次数/tokens),
  //   数据来自 /bills/daily-stats 聚合端点, 不再受 /bills 默认分页 20 条的"近视"影响

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour >= 6 && hour < 12) return "早上好，主人~ 今天也要元气满满哦 ☀️";
    if (hour >= 12 && hour < 18) return "下午好，主人~ 要来一杯拿铁吗 ☕";
    if (hour >= 18 && hour < 24) return "晚上好，主人~ 今天辛苦了 🌙";
    return "主人还没睡吗？要注意休息哦 🌛";
  };

  return (
    <div className="min-h-screen font-harmony">
      {/* Main Content */}
      <main className="max-w-6xl mx-auto p-4 md:p-8 space-y-6 md:space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 md:gap-8">

          {/* Balance Card */}
          <div className="meow-card hoverable p-6 md:p-8 flex flex-col justify-center items-center text-center">
            <h2 className="text-xl meow-text-sub mb-2">当前余额</h2>
            <div className="text-5xl md:text-6xl font-black meow-accent mb-4">
              {balance} <span className="text-2xl">☕</span>
            </div>
            <p className="meow-text-sub mb-8">可继续享用的魔法次数</p>
            <button
              onClick={() => navigate('/topup')}
              className="meow-btn-primary px-8 py-4"
            >
              去充值 →
            </button>
          </div>

          {/* G-7 图① 消费金额(近30日, 按模型堆叠柱) */}
          <div className="meow-card p-6 md:p-8 h-[320px] md:h-[400px] flex flex-col">
            <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
              <h2 className="text-xl meow-h">消费分析 ☕</h2>
              <div className="flex items-center gap-2 text-xs meow-text-sub">
                <button type="button" className="meow-page-btn !px-2 !py-0.5" onClick={() => setStatsMonth((m) => stepMonth(m, -1))} aria-label="上一月">‹</button>
                <span className="whitespace-nowrap">{monthLabel(statsMonth)} · 按模型</span>
                <button type="button" className="meow-page-btn !px-2 !py-0.5" disabled={statsMonth >= curMonth} onClick={() => setStatsMonth((m) => stepMonth(m, 1))} aria-label="下一月">›</button>
              </div>
            </div>
            {chart.hasSpend ? (
              <>
                <ChartLegend entries={chart.models.map((m, i) => ({ label: modelLabel(m), color: COLORS[i % COLORS.length] }))} />
                <div className="flex-1 min-h-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chart.days} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
                      <CartesianGrid stroke="var(--card-border)" vertical={false} />
                      <XAxis dataKey="date" tickFormatter={shortDate} tick={axisTick} axisLine={{ stroke: 'var(--card-border)' }} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
                      <YAxis tick={axisTick} axisLine={false} tickLine={false} width={54} tickFormatter={(v: number) => fmtBean(v)} />
                      <Tooltip content={<ChartTooltip unit="豆" showTotal />} cursor={{ fill: 'var(--card-border)', fillOpacity: 0.35 }} />
                      {chart.models.map((m, i) => (
                        <Bar key={m} dataKey={m} name={modelLabel(m)} stackId="spend" fill={COLORS[i % COLORS.length]} maxBarSize={18} />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center meow-text-sub">
                <div className="text-4xl mb-4 animate-float">☕</div>
                <p>{monthLabel(statsMonth)}暂无消费记录，去探索魔法吧~</p>
              </div>
            )}
          </div>

        </div>

        {/* G-7 图② API 调用次数(近30日, 每日消费笔数, 面积线) */}
        {chart.hasSpend && (
          <div className="meow-card p-6 md:p-8 h-[240px] md:h-[300px] flex flex-col">
            <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
              <h2 className="text-xl meow-h">API 调用次数 🐾</h2>
              <span className="text-xs meow-text-sub">{monthLabel(statsMonth)} · 每日消费笔数</span>
            </div>
            <div className="flex-1 min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chart.callsData} margin={{ top: 4, right: 4, left: -14, bottom: 0 }}>
                  <CartesianGrid stroke="var(--card-border)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDate} tick={axisTick} axisLine={{ stroke: 'var(--card-border)' }} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis tick={axisTick} axisLine={false} tickLine={false} width={44} allowDecimals={false} />
                  <Tooltip content={<ChartTooltip unit="次" />} cursor={{ stroke: 'var(--card-border)' }} />
                  <Area type="monotone" dataKey="调用次数" stroke="var(--accent-c)" strokeWidth={2} fill="var(--accent-c)" fillOpacity={0.15} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* G-7 图③ Tokens(近30日, 输入/输出双段堆叠; Logs 无缓存命中字段, 不造数) */}
        {chart.hasTokens && (
          <div className="meow-card p-6 md:p-8 h-[240px] md:h-[300px] flex flex-col">
            <div className="flex items-baseline justify-between gap-3 flex-wrap mb-3">
              <h2 className="text-xl meow-h">Tokens 📖</h2>
              <span className="text-xs meow-text-sub">{monthLabel(statsMonth)} · 输入/输出</span>
            </div>
            <ChartLegend entries={[
              ...(chart.hasCached ? [{ label: '命中缓存', color: COLORS[1] }] : []),
              { label: chart.hasCached ? '其余输入' : '输入', color: COLORS[0] },
              { label: '输出', color: COLORS[4] },
            ]} />
            <div className="flex-1 min-h-0">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chart.tokenData} margin={{ top: 4, right: 4, left: -6, bottom: 0 }}>
                  <CartesianGrid stroke="var(--card-border)" vertical={false} />
                  <XAxis dataKey="date" tickFormatter={shortDate} tick={axisTick} axisLine={{ stroke: 'var(--card-border)' }} tickLine={false} interval="preserveStartEnd" minTickGap={24} />
                  <YAxis tick={axisTick} axisLine={false} tickLine={false} width={62} tickFormatter={(v: number) => Number(v).toLocaleString()} />
                  <Tooltip content={<ChartTooltip unit="tokens" showTotal />} cursor={{ fill: 'var(--card-border)', fillOpacity: 0.35 }} />
                  {chart.hasCached && <Bar dataKey="命中缓存" stackId="tk" fill={COLORS[1]} maxBarSize={18} />}
                  <Bar dataKey="其余输入" name={chart.hasCached ? '其余输入' : '输入'} stackId="tk" fill={COLORS[0]} maxBarSize={18} />
                  <Bar dataKey="输出" stackId="tk" fill={COLORS[4]} maxBarSize={18} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* F6 每日签到卡片(admin 关闭总闸时整卡隐藏)*/}
        {checkin?.enabled && (
          <div className="meow-card p-6 flex flex-col md:flex-row items-center justify-between gap-4">
            <div className="text-center md:text-left">
              <h2 className="text-xl meow-h mb-1">🐾 每日签到</h2>
              <p className="meow-text-sub text-sm">
                每天来书店打个卡, 领 {checkin.reward} 颗咖啡豆喵~ (每天东八区 0 点刷新)
              </p>
            </div>
            <button
              onClick={handleCheckin}
              disabled={checkin.checked_in || checkinLoading}
              className={`px-8 py-4 font-bold transition-all whitespace-nowrap ${
                checkin.checked_in
                  ? 'meow-btn-primary'
                  : 'meow-btn-primary'
              }`}
            >
              {checkinLoading ? '签到中...' : checkin.checked_in ? '今天已签到 ✓' : `签到领 ${checkin.reward} 豆`}
            </button>
          </div>
        )}

        {/* Banner */}
        <div className="meow-banner p-6 text-center text-xl">
          {getGreeting()}
        </div>

        {/* F7 书店公告(只读, 最新 3 条; 无公告时整卡隐藏)*/}
        {anns.length > 0 && (
          <div className="meow-card p-6">
            <div className="flex items-baseline justify-between gap-3 flex-wrap mb-4">
              <h2 className="text-xl meow-h">📢 书店公告</h2>
              <Link to="/announcements" className="text-sm meow-text-sub underline">
                查看全部 →
              </Link>
            </div>
            <div className="space-y-4">
              {anns.map((a) => (
                <div key={a.id} className="border-b last:border-0 pb-4 last:pb-0" style={{ borderColor: 'var(--card-border)' }}>
                  <div className="flex items-baseline justify-between gap-3 flex-wrap">
                    <h3 className="font-bold meow-text">{a.title}</h3>
                    <span className="text-xs meow-text-sub">
                      {new Date(a.created_at).toLocaleString('zh-CN')}
                    </span>
                  </div>
                  <div className="mt-2">
                    <MarkdownContent content={a.content} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* F.1.7 危险区域(注销账号)已迁移到「客人餐桌」页(/profile),Dashboard 不再展示 */}
      </main>

      {/* F6 签到提示条 (3 秒自动消失) */}
      {checkinToast && (
        <div
          className="meow-toast meow-toast-info fixed top-8 left-1/2 z-50 px-8 py-4"
          style={{ transform: 'translateX(-50%)' }}
        >
          {checkinToast}
        </div>
      )}

      {/* F.1.7 注销成功提示条已随注销区一并迁移到「客人餐桌」页(/profile) */}
    </div>
  );
}
