import React, { useEffect, useState } from 'react';
import client from '../api/client';

interface MailChannel {
  id: number;
  name: string;
  host: string;
  port: number;
  user: string;
  pass: string; // 列表返回的是遮罩串(如 32****50)喵
  status: 'UNVERIFIED' | 'INACTIVE' | 'ACTIVE' | 'ERROR';
  weight: number;
  priority: number;
  group_name: string | null;
  last_verified_at: string | null;
  created_at: string;
}

interface FormData {
  name: string;
  host: string;
  port: number;
  user: string;
  pass: string; // 编辑时留空 = 不修改授权码喵
  weight: number;
  priority: number;
  group_name: string;
}

const emptyForm: FormData = {
  name: '',
  host: 'smtp.qq.com',
  port: 465,
  user: '',
  pass: '',
  weight: 1,
  priority: 1,
  group_name: '',
};

export default function MailChannels() {
  const [channels, setChannels] = useState<MailChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [submitting, setSubmitting] = useState(false);
  const [verifyingId, setVerifyingId] = useState<number | null>(null);

  const fetchChannels = async () => {
    try {
      console.info('[ADMIN-PORTAL][送信窝][请求] 获取送信渠道列表');
      const res = await client.get('/api/v1/admin/mail-channels');
      setChannels(res.data.items || []);
    } catch (err: any) {
      const msg = err.response?.data?.message || '加载失败';
      console.error('[ADMIN-PORTAL][送信窝][失败]', msg);
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchChannels();
  }, []);

  const openNewDrawer = () => {
    setEditingId(null);
    setForm(emptyForm);
    setDrawerOpen(true);
  };

  const openEditDrawer = (mc: MailChannel) => {
    setEditingId(mc.id);
    setForm({
      name: mc.name,
      host: mc.host,
      port: mc.port,
      user: mc.user,
      pass: '', // 不回填遮罩串;留空提交 = 保持原授权码不变喵
      weight: mc.weight,
      priority: mc.priority,
      group_name: mc.group_name || '',
    });
    setDrawerOpen(true);
  };

  const closeDrawer = () => {
    setDrawerOpen(false);
    setEditingId(null);
    setForm(emptyForm);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name || !form.host || !form.user) {
      alert('名称、SMTP 主机、登录账号不能为空喵');
      return;
    }
    if (editingId === null && !form.pass) {
      alert('新增渠道必须填授权码喵');
      return;
    }

    setSubmitting(true);
    // 授权码:新增必带;编辑时留空则不传(后端保持原值不变)喵
    const payload: any = {
      name: form.name,
      host: form.host,
      port: form.port,
      user: form.user,
      weight: form.weight,
      priority: form.priority,
      group_name: form.group_name.trim() || null,
    };
    if (form.pass) {
      payload.pass = form.pass;
    }

    try {
      if (editingId === null) {
        console.info('[ADMIN-PORTAL][送信窝][新增] 提交');
        await client.post('/api/v1/admin/mail-channels', payload);
      } else {
        console.info(`[ADMIN-PORTAL][送信窝][编辑] 提交 ID: ${editingId}`);
        await client.put(`/api/v1/admin/mail-channels/${editingId}`, payload);
      }
      closeDrawer();
      await fetchChannels();
    } catch (err: any) {
      const msg = err.response?.data?.message || '保存失败';
      alert(`保存失败：${msg}`);
      console.error('[ADMIN-PORTAL][送信窝][保存失败]', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!window.confirm(`确定要放归送信小猫「${name}」吗喵？`)) return;
    try {
      console.info(`[ADMIN-PORTAL][送信窝][删除] ID: ${id}`);
      await client.delete(`/api/v1/admin/mail-channels/${id}`);
      await fetchChannels();
    } catch (err: any) {
      const msg = err.response?.data?.message || '删除失败';
      alert(`删除失败：${msg}`);
    }
  };

  // 巡检:当场发测试信验证连通性。留空 = 发给渠道账号自己喵
  const handleVerify = async (mc: MailChannel) => {
    const target = window.prompt(
      `让「${mc.name}」送一封巡检测试信,寄到哪个邮箱喵？\n（留空 = 小猫寄给它自己 ${mc.user}）`,
      ''
    );
    if (target === null) return; // 用户取消
    setVerifyingId(mc.id);
    try {
      console.info(`[ADMIN-PORTAL][送信窝][巡检] ID: ${mc.id}`);
      const res = await client.post(`/api/v1/admin/mail-channels/${mc.id}/verify`, {
        to: target.trim(),
      });
      alert(res.data?.message || '巡检完成喵~');
      await fetchChannels();
    } catch (err: any) {
      const msg = err.response?.data?.message || '巡检失败';
      alert(`巡检失败：${msg}`);
      await fetchChannels(); // 失败也刷新,状态可能已被标 ERROR
    } finally {
      setVerifyingId(null);
    }
  };

  // 激活/停用:只在 INACTIVE ⇄ ACTIVE 之间切换(走专用 /status 接口)喵
  const handleToggleActive = async (mc: MailChannel) => {
    const newStatus = mc.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    try {
      console.info(`[ADMIN-PORTAL][送信窝][状态] ID: ${mc.id}, 新状态: ${newStatus}`);
      await client.post(`/api/v1/admin/mail-channels/${mc.id}/status`, { status: newStatus });
      await fetchChannels();
    } catch (err: any) {
      const msg = err.response?.data?.message || '操作失败';
      alert(`操作失败：${msg}`);
    }
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, { bg: string; text: string; label: string }> = {
      UNVERIFIED: { bg: 'rgba(224,162,58,0.12)', text: '#e0a23a', label: '待巡检' },
      INACTIVE: { bg: 'rgba(122,134,148,0.14)', text: '#9aa6b3', label: '待命中' },
      ACTIVE: { bg: 'rgba(45,212,167,0.12)', text: '#2dd4a7', label: '送信中' },
      ERROR: { bg: 'rgba(216,112,74,0.12)', text: '#d8704a', label: '巡检失败' },
    };
    const style = styles[status] || styles.UNVERIFIED;
    return (
      <span
        style={{ padding: '3px 10px', fontSize: '11px', borderRadius: '2px', fontWeight: 500, backgroundColor: style.bg, color: style.text, border: `1px solid ${style.text}` }}
      >
        {style.label}
      </span>
    );
  };

  const fmtTime = (t: string | null) => {
    if (!t) return '从未巡检';
    try {
      return new Date(t).toLocaleString('zh-CN', { hour12: false });
    } catch {
      return t;
    }
  };

  return (
    <div className="mecha-content">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="mecha-page-title">📮 送信小猫的窝</h1>
          <p className="mecha-page-sub">
            管理多个 SMTP 发信渠道,只有「送信中」的小猫会加权轮流送验证码喵🐾
          </p>
        </div>
        <button
          onClick={openNewDrawer}
          className="mecha-btn"
          style={{ width: 'auto', padding: '0 18px', height: '38px', letterSpacing: 'normal' }}
        >
          ➕ 收编送信猫
        </button>
      </div>

      {loading && <p style={{ color: 'var(--m-text-sub)' }}>正在召唤送信小猫们喵...</p>}

      {errorMsg && <div className="mecha-error">加载失败：{errorMsg}</div>}

      {!loading && !errorMsg && channels.length === 0 && (
        <div className="mecha-card" style={{ padding: '48px', textAlign: 'center' }}>
          <p style={{ fontSize: '15px', marginBottom: '12px', color: 'var(--m-text-sub)' }}>
            窝里还没有送信小猫喵~
          </p>
          <p style={{ color: 'var(--m-text-faint)' }}>
            点右上角"收编送信猫",填好 SMTP 后记得先巡检再激活哦📮
          </p>
        </div>
      )}

      {!loading && channels.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '12px' }}>
          {channels.map((mc) => (
            <div
              key={mc.id}
              className="mecha-card"
              style={{ borderLeft: `3px solid ${mc.status === 'ACTIVE' ? 'var(--m-ok)' : 'var(--m-border-strong)'}` }}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 style={{ fontSize: '15px', fontWeight: 500, color: 'var(--m-text)', margin: 0 }}>
                      {mc.name}
                    </h3>
                    {getStatusBadge(mc.status)}
                    {mc.group_name && (
                      <span
                        style={{ padding: '3px 10px', fontSize: '11px', borderRadius: '2px', fontWeight: 500, backgroundColor: 'var(--m-accent-dim)', color: 'var(--m-accent)', border: '1px solid var(--m-accent)' }}
                      >
                        🏷 分组·{mc.group_name}
                      </span>
                    )}
                  </div>
                  <p style={{ fontSize: '13px', marginBottom: '4px', color: 'var(--m-text-sub)' }}>
                    📬 {mc.host}:{mc.port}　·　账号 {mc.user}
                  </p>
                  <div style={{ display: 'flex', gap: '16px', fontSize: '11px', color: 'var(--m-text-faint)' }}>
                    <span>权重: {mc.weight}</span>
                    <span>优先级: {mc.priority}</span>
                    <span>ID: {mc.id}</span>
                    <span>上次巡检: {fmtTime(mc.last_verified_at)}</span>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2 ml-4 justify-end" style={{ maxWidth: '320px' }}>
                  <button
                    onClick={() => openEditDrawer(mc)}
                    className="mecha-row-btn"
                    style={{ borderColor: 'var(--m-accent)', color: 'var(--m-accent)', padding: '5px 12px', fontSize: '12px' }}
                  >
                    编辑
                  </button>
                  <button
                    onClick={() => handleVerify(mc)}
                    disabled={verifyingId === mc.id}
                    className="mecha-row-btn"
                    style={{ color: 'var(--m-accent)', borderColor: 'var(--m-accent)', padding: '5px 12px', fontSize: '12px' }}
                  >
                    {verifyingId === mc.id ? '巡检中...' : '🔍 巡检'}
                  </button>
                  {mc.status === 'ACTIVE' || mc.status === 'INACTIVE' ? (
                    <button
                      onClick={() => handleToggleActive(mc)}
                      className="mecha-row-btn"
                      style={{
                        padding: '5px 12px', fontSize: '12px',
                        color: mc.status === 'ACTIVE' ? 'var(--m-warn)' : 'var(--m-ok)',
                        borderColor: mc.status === 'ACTIVE' ? 'var(--m-warn)' : 'var(--m-ok)',
                      }}
                    >
                      {mc.status === 'ACTIVE' ? '停用' : '激活'}
                    </button>
                  ) : (
                    <span
                      style={{ padding: '5px 12px', fontSize: '11px', alignSelf: 'center', color: 'var(--m-text-faint)' }}
                    >
                      巡检通过后可激活
                    </span>
                  )}
                  <button
                    onClick={() => handleDelete(mc.id, mc.name)}
                    className="mecha-row-btn"
                    style={{ padding: '5px 12px', fontSize: '12px', color: 'var(--m-danger)', borderColor: 'var(--m-danger)' }}
                  >
                    删除
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {drawerOpen && (
        <>
          <div className="mecha-modal-mask" onClick={closeDrawer} />
          <div className="mecha-drawer">
            <div style={{ padding: '24px' }}>
              <div className="flex items-center justify-between mb-6">
                <h2 className="mecha-modal-title">
                  {editingId === null ? '🐾 收编送信猫' : '✏️ 编辑送信猫'}
                </h2>
                <button onClick={closeDrawer} className="mecha-modal-close">×</button>
              </div>

              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <label className="mecha-label">
                    渠道名称 *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="如：QQ主力信使猫"
                    className="mecha-input"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '12px' }}>
                  <div>
                    <label className="mecha-label">
                      SMTP 主机 *
                    </label>
                    <input
                      type="text"
                      required
                      placeholder="smtp.qq.com"
                      className="mecha-input"
                      value={form.host}
                      onChange={(e) => setForm({ ...form, host: e.target.value })}
                    />
                  </div>
                  <div>
                    <label className="mecha-label">
                      端口
                    </label>
                    <input
                      type="number"
                      min="1"
                      className="mecha-input"
                      value={form.port}
                      onChange={(e) => setForm({ ...form, port: parseInt(e.target.value) || 465 })}
                    />
                  </div>
                </div>
                <p style={{ fontSize: '11px', color: 'var(--m-text-faint)', marginTop: '-8px' }}>
                  465 = SSL / 587 = STARTTLS,系统按端口自动判断喵
                </p>

                <div>
                  <label className="mecha-label">
                    登录账号 *（也是发信人）
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="如：123456@qq.com"
                    className="mecha-input"
                    value={form.user}
                    onChange={(e) => setForm({ ...form, user: e.target.value })}
                  />
                </div>

                <div>
                  <label className="mecha-label">
                    授权码 / 密码 {editingId === null ? '*' : '（留空 = 不修改）'}
                  </label>
                  <input
                    type="password"
                    placeholder={editingId === null ? 'SMTP 授权码' : '留空则保持原授权码不变喵'}
                    className="mecha-input"
                    value={form.pass}
                    onChange={(e) => setForm({ ...form, pass: e.target.value })}
                  />
                  <p style={{ fontSize: '11px', marginTop: '4px', color: 'var(--m-text-faint)' }}>
                    暂以明文存储,后续会同 api_key 一起加密喵
                  </p>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                  <div>
                    <label className="mecha-label">
                      权重
                    </label>
                    <input
                      type="number"
                      min="1"
                      className="mecha-input"
                      value={form.weight}
                      onChange={(e) => setForm({ ...form, weight: parseInt(e.target.value) || 1 })}
                    />
                  </div>
                  <div>
                    <label className="mecha-label">
                      优先级
                    </label>
                    <input
                      type="number"
                      min="1"
                      className="mecha-input"
                      value={form.priority}
                      onChange={(e) => setForm({ ...form, priority: parseInt(e.target.value) || 1 })}
                    />
                  </div>
                </div>

                <div>
                  <label className="mecha-label">
                    分组（选填·P2 预留）
                  </label>
                  <input
                    type="text"
                    placeholder="留空即可,以后多层抽样才用得上喵"
                    className="mecha-input"
                    value={form.group_name}
                    onChange={(e) => setForm({ ...form, group_name: e.target.value })}
                  />
                </div>

                {editingId !== null && (
                  <p style={{ fontSize: '11px', color: 'var(--m-text-mute)' }}>
                    💡 改了主机/端口/账号/授权码后,状态会自动打回「待巡检」,需重新巡检才能再激活喵
                  </p>
                )}

                <div className="flex gap-3 pt-4">
                  <button
                    type="button"
                    onClick={closeDrawer}
                    className="mecha-btn-ghost"
                    style={{ flex: 1, height: '40px' }}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="mecha-btn"
                    style={{ flex: 1, letterSpacing: 'normal' }}
                  >
                    {submitting ? '保存中...' : editingId === null ? '收编入窝 🐾' : '保存修改'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
