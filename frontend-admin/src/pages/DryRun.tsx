import React, { useEffect, useRef, useState } from 'react';
import client from '../api/client';

// ============ 吧台安检区(E.3.5) ============
// 店长亲自端着咖啡确认订单的地方喵~
// 左耳听专线(WebSocket 实时推送),右手翻订单池(HTTP 接口兜底),
// 每张可疑订单都摆上解剖台,店长可以原样端上桌、加点糖再端、或者倒掉喵。

// 一张待裁决的订单(和后端暂存区/推送的字段对齐)
interface PendingOrder {
  trace_id: string;
  user_id: string;
  client_ip: string;
  model: string;
  rule_id: number;
  rule_name: string;
  request_body: unknown; // 配方内容是客人写的,形状不可预知,用 unknown 比 any 更守规矩喵
  expire_at: string;
}

// 接口报错时 axios 错误对象的形状(只描述我们用到的部分喵)
interface ApiErrorShape {
  response?: { status?: number; data?: { message?: string } };
}

export default function DryRun() {
  const [orders, setOrders] = useState<PendingOrder[]>([]);
  const [loading, setLoading] = useState(true);
  // 猫咪信标:true=专线通讯中(绿点) false=失联(红点)喵
  const [wsConnected, setWsConnected] = useState(false);
  // 每张订单解剖台上的配方草稿(店长可以改,key 是 trace_id)
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // 正在提交裁决的订单,按钮要变灰防止店长手抖连点喵
  const [judging, setJudging] = useState<Record<string, boolean>>({});
  // 每秒走一格的时钟,用来算倒计时
  // (惰性初始化:把 Date.now 包进函数里,渲染期就不算"偷跑不纯函数"了喵)
  const [now, setNow] = useState<number>(() => Date.now());

  const wsRef = useRef<WebSocket | null>(null);
  const aliveRef = useRef(true); // 页面还活着吗?离开页面后就别再重连了喵

  // ---- 收一张新订单进池子(去重,专线和接口可能送来同一张喵) ----
  const addOrder = (order: PendingOrder) => {
    setOrders((prev) => {
      if (prev.some((o) => o.trace_id === order.trace_id)) return prev;
      return [...prev, order];
    });
    setDrafts((prev) => ({
      ...prev,
      // 解剖台上预先摆好原配方,店长想加糖就直接在上面改喵
      [order.trace_id]: JSON.stringify(order.request_body, null, 2),
    }));
  };

  // ---- 裁决完毕,把订单撤下吧台 ----
  const removeOrder = (trace_id: string) => {
    setOrders((prev) => prev.filter((o) => o.trace_id !== trace_id));
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[trace_id];
      return next;
    });
  };

  // ---- 翻一遍订单池(进页面时 + 专线重连后兜底用喵) ----
  const fetchPending = async () => {
    try {
      console.info('[ADMIN-PORTAL][安检区][请求] 获取待裁决订单池');
      const res = await client.get('/api/v1/admin/dry-run/pending');
      const items: PendingOrder[] = res.data.items || [];
      for (const it of items) addOrder(it);
    } catch (err) {
      const e = err as ApiErrorShape;
      console.error('[ADMIN-PORTAL][安检区][失败]', e.response?.data?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  // ---- 接通店长专线(断线后每3秒重拨一次喵) ----
  const connectWs = () => {
    if (!aliveRef.current) return;
    // 防分身术:已有活线/正在拨号中就不再开新线
    // (React 开发模式会故意把页面挂载两次来抓bug,不防的话店里会出现分身店长喵)
    if (
      wsRef.current &&
      (wsRef.current.readyState === WebSocket.OPEN ||
        wsRef.current.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    const token = localStorage.getItem('admin_token');
    if (!token) return; // 没工牌连不了,AuthGuard 会管的喵

    const metaEnv = (import.meta as unknown as { env?: { VITE_API_BASE_URL?: string } }).env;
    const apiBase: string = metaEnv?.VITE_API_BASE_URL || 'http://localhost:3000';
    const wsUrl = apiBase.replace(/^http/, 'ws') + '/ws/admin/events?token=' + encodeURIComponent(token);

    console.info('[ADMIN-PORTAL][安检区][专线] 正在接通店长专线...');
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      console.info('[ADMIN-PORTAL][安检区][专线] 已接通喵~');
      // 断线期间可能漏听了"叮铃",重连成功后翻一遍订单池补课
      fetchPending();
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.event === 'DRY_RUN_PENDING') {
          // 叮铃~有可疑的魔法订单飞进来了喵!
          const p = msg.payload;
          console.info('[ADMIN-PORTAL][安检区][叮铃] 新订单:', p.trace_id);
          addOrder({
            trace_id: p.trace_id,
            user_id: p.user_id,
            client_ip: p.client_ip,
            model: p.request_detail?.model || 'unknown',
            rule_id: p.rule_id,
            rule_name: p.trigger_rule,
            request_body: p.request_detail?.body ?? {},
            expire_at: p.expire_at,
          });
        }
      } catch {
        // 听不懂的广播就当没听见喵
      }
    };

    ws.onclose = () => {
      // 只有"现役专线"断了才算失联;被换下的旧分身安静退场,不触发重拨喵
      if (wsRef.current !== ws) return;
      setWsConnected(false);
      wsRef.current = null;
      if (aliveRef.current) {
        console.warn('[ADMIN-PORTAL][安检区][专线] ⚠️ 与猫咪总部失去联系,3秒后重新拨号...');
        setTimeout(() => { if (aliveRef.current) connectWs(); }, 3000);
      }
    };
    ws.onerror = () => { try { ws.close(); } catch { /* 已经断了喵 */ } };
  };

  useEffect(() => {
    aliveRef.current = true;
    // 进门盘点是异步请求,真正的 setState 都发生在 await 之后,不会引发级联渲染喵
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchPending();
    connectWs();
    // 倒计时时钟:每秒滴答一次,顺手把过期订单撤下吧台(后端那边它们早已408退回喵)
    const tick = setInterval(() => {
      const t = Date.now();
      setNow(t);
      setOrders((prev) => prev.filter((o) => new Date(o.expire_at).getTime() > t));
    }, 1000);
    return () => {
      // 离开页面:挂断专线、停掉时钟,不留幽灵连接喵
      aliveRef.current = false;
      try { wsRef.current?.close(); } catch { /* 无伤大雅 */ }
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 裁决:端上桌(放行) ----
  const handleApprove = async (order: PendingOrder) => {
    const draft = drafts[order.trace_id] ?? '';
    const original = JSON.stringify(order.request_body, null, 2);

    const payload: { trace_id: string; override_body?: unknown } = { trace_id: order.trace_id };
    // 店长动过配方 → 校验改完的还是不是合法 JSON,然后作为 override_body 端上去
    if (draft.trim() !== original.trim()) {
      try {
        payload.override_body = JSON.parse(draft);
      } catch {
        alert('改过的配方不是合法的 JSON 喵!检查一下引号和逗号~');
        return;
      }
    }

    setJudging((prev) => ({ ...prev, [order.trace_id]: true }));
    try {
      console.info(`[ADMIN-PORTAL][安检区][放行] ${order.trace_id}${payload.override_body ? '(加糖)' : ''}`);
      const res = await client.post('/api/v1/admin/dry-run/approve', payload);
      console.info('[ADMIN-PORTAL][安检区][放行成功]', res.data.message);
      removeOrder(order.trace_id);
    } catch (err) {
      const e = err as ApiErrorShape;
      alert(`放行失败:${e.response?.data?.message || '未知错误'}`);
      // 404=已过期或已被裁决,这张卡留着也没意义了,撤下喵
      if (e.response?.status === 404) removeOrder(order.trace_id);
    } finally {
      setJudging((prev) => ({ ...prev, [order.trace_id]: false }));
    }
  };

  // ---- 裁决:倒掉(拒绝) ----
  const handleReject = async (order: PendingOrder) => {
    setJudging((prev) => ({ ...prev, [order.trace_id]: true }));
    try {
      console.info(`[ADMIN-PORTAL][安检区][倒掉] ${order.trace_id}`);
      const res = await client.post('/api/v1/admin/dry-run/reject', { trace_id: order.trace_id });
      console.info('[ADMIN-PORTAL][安检区][倒掉成功]', res.data.message);
      removeOrder(order.trace_id);
    } catch (err) {
      const e = err as ApiErrorShape;
      alert(`拒绝失败:${e.response?.data?.message || '未知错误'}`);
      if (e.response?.status === 404) removeOrder(order.trace_id);
    } finally {
      setJudging((prev) => ({ ...prev, [order.trace_id]: false }));
    }
  };

  // 剩余秒数 → "m:ss" 倒计时牌
  const countdown = (expire_at: string) => {
    const remain = Math.max(0, Math.floor((new Date(expire_at).getTime() - now) / 1000));
    const m = Math.floor(remain / 60);
    const s = remain % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  };

  return (
    <div className="mecha-content">
      {/* 标题栏 + 猫咪信标 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h1 className="mecha-page-title">🛡️ 吧台安检区</h1>
          <p className="mecha-page-sub" style={{ marginTop: '4px' }}>
            可疑的魔法订单会被端到这里,店长检查后再决定要不要上桌喵🐾
          </p>
        </div>
        {/* 猫咪信标:专线状态灯 (语义色: 通=绿/断=红, 不随主题变) */}
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: '8px',
            padding: '6px 14px', borderRadius: '3px', fontSize: '13px', fontWeight: 500,
            backgroundColor: wsConnected ? 'rgba(45,212,167,0.12)' : 'rgba(216,112,74,0.12)',
            color: wsConnected ? 'var(--m-ok)' : 'var(--m-danger)',
            border: `1px solid ${wsConnected ? 'var(--m-ok)' : 'var(--m-danger)'}`,
          }}
        >
          <span
            style={{ display: 'inline-block', width: '9px', height: '9px', borderRadius: '50%', backgroundColor: wsConnected ? 'var(--m-ok)' : 'var(--m-danger)' }}
          />
          {wsConnected ? '专线通讯中' : '失联,重新拨号中...'}
        </div>
      </div>

      {loading ? (
        <p style={{ color: 'var(--m-text-faint)' }}>正在查看吧台...</p>
      ) : orders.length === 0 ? (
        // 空状态:今天的客人都很乖喵
        <div
          style={{ border: '2px dashed var(--m-border-strong)', borderRadius: '4px', padding: '64px', textAlign: 'center', color: 'var(--m-text-sub)' }}
        >
          <div style={{ fontSize: '48px', marginBottom: '12px' }}>😺☕</div>
          <p style={{ fontWeight: 500 }}>吧台空空如也,没有可疑订单喵~</p>
          <p style={{ fontSize: '13px', marginTop: '4px', color: 'var(--m-text-faint)' }}>
            有订单触发安检时,会伴随"叮铃"自动飞进这里,不用刷新页面喵
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {orders.map((order) => (
            <div
              key={order.trace_id}
              className="mecha-card"
              style={{ borderLeft: '3px solid var(--m-danger)' }}
            >
              {/* 订单头:规则名 + 倒计时 */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '18px' }}>🚨</span>
                  <h3 style={{ fontWeight: 500, color: 'var(--m-text)', margin: 0 }}>
                    {order.rule_name}
                  </h3>
                  <span
                    style={{ padding: '2px 8px', fontSize: '11px', borderRadius: '2px', backgroundColor: 'rgba(224,162,58,0.12)', color: 'var(--m-warn)', border: '1px solid var(--m-warn)' }}
                  >
                    规则 #{order.rule_id}
                  </span>
                </div>
                <span
                  style={{ padding: '4px 12px', fontSize: '13px', fontFamily: 'monospace', borderRadius: '2px', backgroundColor: 'rgba(216,112,74,0.12)', color: 'var(--m-danger)', border: '1px solid var(--m-danger)' }}
                  title="超过时间没裁决,订单会自动退回(408)喵"
                >
                  ⏳ {countdown(order.expire_at)}
                </span>
              </div>

              {/* 订单身份信息 */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', fontSize: '11px', marginBottom: '12px', color: 'var(--m-text-mute)' }}>
                <span>👤 客人 #{order.user_id}</span>
                <span>📍 {order.client_ip}</span>
                <span>🤖 {order.model}</span>
                <span style={{ fontFamily: 'monospace' }}>🎫 {order.trace_id}</span>
              </div>

              {/* 订单解剖台:可编辑的配方 JSON */}
              <label style={{ display: 'block', fontSize: '11px', fontWeight: 500, marginBottom: '4px', color: 'var(--m-text-sub)' }}>
                📋 订单配方(可以直接修改后再端上桌喵)
              </label>
              <textarea
                className="mecha-input"
                style={{ width: '100%', height: '176px', fontFamily: 'monospace', fontSize: '11px', padding: '10px 12px', resize: 'vertical', lineHeight: 1.6 }}
                value={drafts[order.trace_id] ?? ''}
                onChange={(e) =>
                  setDrafts((prev) => ({ ...prev, [order.trace_id]: e.target.value }))
                }
                spellCheck={false}
              />

              {/* 裁决猫爪区 (语义色: 放行绿/拒绝红) */}
              <div style={{ display: 'flex', gap: '12px', marginTop: '12px' }}>
                <button
                  onClick={() => handleApprove(order)}
                  disabled={!!judging[order.trace_id]}
                  className="mecha-btn"
                  style={{ flex: 1, letterSpacing: 'normal', background: 'var(--m-ok)', color: '#06231a' }}
                >
                  {judging[order.trace_id] ? '端送中...' : '🐾 加点糖端上桌(放行)'}
                </button>
                <button
                  onClick={() => handleReject(order)}
                  disabled={!!judging[order.trace_id]}
                  className="mecha-btn"
                  style={{ flex: 1, letterSpacing: 'normal', background: 'var(--m-danger)', color: '#2a0f08' }}
                >
                  🐾 配方危险倒掉(拒绝)
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
