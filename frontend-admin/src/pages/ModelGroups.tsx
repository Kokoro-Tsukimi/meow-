import React, { useEffect, useState } from 'react';
import client from '../api/client';
import { useConfirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

// ============ 类型 ============

interface Group {
  id: number;
  name: string;
  description: string | null;
  prompt_price: number;          // 原始放大值(×10万)
  completion_price: number;
  prompt_price_real: number;     // 豆/百万 tokens(展示用)
  completion_price_real: number;
  access_mode: 'PUBLIC' | 'WHITELIST';
  status: 'ENABLE' | 'DISABLE';
  channel_count: number;
  grant_count: number;
  created_at: string;
}

interface GroupChannelLink {
  id: number;                    // linkId(挂载关系主键)
  group_id: number;
  channel_id: number;
  real_model_name: string;
  weight: number;
  status: 'ENABLE' | 'DISABLE';
  channel_name: string | null;
  channel_base_url: string | null;
  channel_status: string | null;
  created_at: string;
}

interface ChannelOption {
  id: number;
  name: string;
  base_url: string;
  status: string;
}

interface Grant {
  user_id: number;
  granted_at: string;
  user_email: string | null;
  user_remark: string | null;
}

interface UserOption {
  id: number;
  email: string;
  remark: string | null;
  status: string;
}

interface GroupForm {
  name: string;
  description: string;
  prompt_price: string;          // 输入框用字符串,提交时转 Number(豆/百万)
  completion_price: string;
  access_mode: 'PUBLIC' | 'WHITELIST';
  status: 'ENABLE' | 'DISABLE';
}

interface ChannelForm {
  channel_id: string;
  real_model_name: string;
  weight: string;
  status: 'ENABLE' | 'DISABLE';
}

const emptyGroupForm: GroupForm = {
  name: '',
  description: '',
  prompt_price: '',
  completion_price: '',
  access_mode: 'PUBLIC',
  status: 'ENABLE',
};

const emptyChannelForm: ChannelForm = {
  channel_id: '',
  real_model_name: '',
  weight: '1',
  status: 'ENABLE',
};


// 抽屉模式:null=关闭 / group=新增编辑分组 / channels=管渠道 / grants=管授权
type DrawerMode = null | 'group' | 'channels' | 'grants';

// 【M-虫3 修复】后端 mysql2 返回的是 UTC ISO 串(带 Z), 旧版只做字符串截取
// 等于把 UTC 裸贴出来, 永远比本地慢 8 小时。现在真正过 new Date() 本地化,
// 输出格式不变(YYYY-MM-DD HH:mm:ss); 解析失败时回退旧的字符串截取兜底。
const fmtTime = (s: string) => {
  if (!s) return '-';
  const d = new Date(s);
  if (isNaN(d.getTime())) return String(s).replace('T', ' ').slice(0, 19);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export default function ModelGroups() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');

  const [drawerMode, setDrawerMode] = useState<DrawerMode>(null);
  const [activeGroup, setActiveGroup] = useState<Group | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // 分组表单
  const [editingId, setEditingId] = useState<number | null>(null);
  const [groupForm, setGroupForm] = useState<GroupForm>(emptyGroupForm);

  // 管渠道
  const [links, setLinks] = useState<GroupChannelLink[]>([]);
  const [allChannels, setAllChannels] = useState<ChannelOption[]>([]);
  const [channelForm, setChannelForm] = useState<ChannelForm>(emptyChannelForm);

  // 管授权
  const [grants, setGrants] = useState<Grant[]>([]);
  const [allUsers, setAllUsers] = useState<UserOption[]>([]);
  const [grantUserId, setGrantUserId] = useState('');

  // ---------- 分组列表 ----------
  const fetchGroups = async () => {
    try {
      console.info('[ADMIN-PORTAL][菜单页][请求] 获取分组列表');
      const res = await client.get('/api/v1/admin/model-groups');
      setGroups(res.data.items || []);
    } catch (err: any) {
      const msg = err.response?.data?.message || '加载失败';
      console.error('[ADMIN-PORTAL][菜单页][失败]', msg);
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchGroups();
  }, []);

  const closeDrawer = () => {
    setDrawerMode(null);
    setActiveGroup(null);
    setEditingId(null);
    setGroupForm(emptyGroupForm);
    setChannelForm(emptyChannelForm);
    setLinks([]);
    setGrants([]);
    setGrantUserId('');
  };

  // ---------- 分组 新增/编辑 ----------
  const openNewGroup = () => {
    setEditingId(null);
    setGroupForm(emptyGroupForm);
    setActiveGroup(null);
    setDrawerMode('group');
  };

  const openEditGroup = (g: Group) => {
    setEditingId(g.id);
    setGroupForm({
      name: g.name,
      description: g.description || '',
      prompt_price: String(g.prompt_price_real),
      completion_price: String(g.completion_price_real),
      access_mode: g.access_mode,
      status: g.status,
    });
    setActiveGroup(g);
    setDrawerMode('group');
  };

  const submitGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!groupForm.name.trim()) {
      toast.error('请给菜单起个名字喵(就是 user 在 SillyTavern 填的 model)');
      return;
    }
    const p = Number(groupForm.prompt_price);
    const c = Number(groupForm.completion_price);
    if (!Number.isFinite(p) || !Number.isFinite(c) || p < 0 || c < 0) {
      toast.error('入价和出价必须是非负数字喵(单位:豆/百万 tokens)');
      return;
    }
    const payload = {
      name: groupForm.name.trim(),
      description: groupForm.description.trim(),
      prompt_price: p,
      completion_price: c,
      access_mode: groupForm.access_mode,
      status: groupForm.status,
    };
    setSubmitting(true);
    try {
      if (editingId === null) {
        await client.post('/api/v1/admin/model-groups', payload);
      } else {
        await client.put(`/api/v1/admin/model-groups/${editingId}`, payload);
      }
      closeDrawer();
      await fetchGroups();
    } catch (err: any) {
      toast.error(`保存失败：${err.response?.data?.message || '未知错误'}`);
    } finally {
      setSubmitting(false);
    }
  };

  const deleteGroup = async (g: Group) => {
    if (!(await confirm({ message: `确定下架菜单「${g.name}」吗喵？\n组内的渠道挂载和授权会一并清理(级联),但渠道本身不受影响。`, danger: true }))) return;
    try {
      await client.delete(`/api/v1/admin/model-groups/${g.id}`);
      await fetchGroups();
    } catch (err: any) {
      toast.error(`删除失败：${err.response?.data?.message || '未知错误'}`);
    }
  };

  const toggleGroupStatus = async (g: Group) => {
    const newStatus = g.status === 'ENABLE' ? 'DISABLE' : 'ENABLE';
    try {
      await client.put(`/api/v1/admin/model-groups/${g.id}`, { status: newStatus });
      await fetchGroups();
    } catch (err: any) {
      toast.error(`操作失败：${err.response?.data?.message || '未知错误'}`);
    }
  };

  // ---------- 管理组内渠道 ----------
  const openChannels = async (g: Group) => {
    setActiveGroup(g);
    setChannelForm(emptyChannelForm);
    setDrawerMode('channels');
    try {
      const [linkRes, chRes] = await Promise.all([
        client.get(`/api/v1/admin/model-groups/${g.id}/channels`),
        client.get('/api/v1/admin/channels'),
      ]);
      setLinks(linkRes.data.items || []);
      setAllChannels(chRes.data.items || []);
    } catch (err: any) {
      toast.error(`加载渠道失败：${err.response?.data?.message || '未知错误'}`);
    }
  };

  const refreshLinks = async (groupId: number) => {
    const res = await client.get(`/api/v1/admin/model-groups/${groupId}/channels`);
    setLinks(res.data.items || []);
  };

  const addChannel = async () => {
    if (!activeGroup) return;
    if (!channelForm.channel_id) {
      toast.error('请先选一条渠道喵');
      return;
    }
    if (!channelForm.real_model_name.trim()) {
      toast.error('真实模型名必填喵(就是要发给上游的那个名字)');
      return;
    }
    const w = Number(channelForm.weight);
    setSubmitting(true);
    try {
      await client.post(`/api/v1/admin/model-groups/${activeGroup.id}/channels`, {
        channel_id: Number(channelForm.channel_id),
        real_model_name: channelForm.real_model_name.trim(),
        weight: Number.isFinite(w) && w > 0 ? w : 1,
        status: channelForm.status,
      });
      setChannelForm(emptyChannelForm);
      await refreshLinks(activeGroup.id);
      await fetchGroups();
    } catch (err: any) {
      toast.error(`挂载失败：${err.response?.data?.message || '未知错误'}`);
    } finally {
      setSubmitting(false);
    }
  };

  const toggleLinkStatus = async (link: GroupChannelLink) => {
    if (!activeGroup) return;
    const newStatus = link.status === 'ENABLE' ? 'DISABLE' : 'ENABLE';
    try {
      await client.put(`/api/v1/admin/model-groups/${activeGroup.id}/channels/${link.id}`, { status: newStatus });
      await refreshLinks(activeGroup.id);
    } catch (err: any) {
      toast.error(`操作失败：${err.response?.data?.message || '未知错误'}`);
    }
  };

  const deleteLink = async (link: GroupChannelLink) => {
    if (!activeGroup) return;
    if (!(await confirm({ message: `把渠道「${link.channel_name || link.channel_id}→${link.real_model_name}」从本菜单卸下吗喵？`, danger: true }))) return;
    try {
      await client.delete(`/api/v1/admin/model-groups/${activeGroup.id}/channels/${link.id}`);
      await refreshLinks(activeGroup.id);
      await fetchGroups();
    } catch (err: any) {
      toast.error(`卸载失败：${err.response?.data?.message || '未知错误'}`);
    }
  };

  // ---------- 管理授权(打勾)----------
  const openGrants = async (g: Group) => {
    setActiveGroup(g);
    setGrantUserId('');
    setDrawerMode('grants');
    try {
      const [grantRes, userRes] = await Promise.all([
        client.get(`/api/v1/admin/model-groups/${g.id}/grants`),
        client.get('/api/v1/admin/users', { params: { limit: 200 } }),
      ]);
      setGrants(grantRes.data.items || []);
      setAllUsers(userRes.data.items || []);
    } catch (err: any) {
      toast.error(`加载授权失败：${err.response?.data?.message || '未知错误'}`);
    }
  };

  const refreshGrants = async (groupId: number) => {
    const res = await client.get(`/api/v1/admin/model-groups/${groupId}/grants`);
    setGrants(res.data.items || []);
  };

  const addGrant = async () => {
    if (!activeGroup) return;
    if (!grantUserId) {
      toast.error('请先选一位客人喵');
      return;
    }
    setSubmitting(true);
    try {
      await client.post(`/api/v1/admin/model-groups/${activeGroup.id}/grants`, { user_id: Number(grantUserId) });
      setGrantUserId('');
      await refreshGrants(activeGroup.id);
      await fetchGroups();
    } catch (err: any) {
      toast.error(`授权失败：${err.response?.data?.message || '未知错误'}`);
    } finally {
      setSubmitting(false);
    }
  };

  const removeGrant = async (grant: Grant) => {
    if (!activeGroup) return;
    if (!(await confirm({ message: `撤销「${grant.user_email || grant.user_id}」对菜单「${activeGroup.name}」的使用权吗喵？`, danger: true }))) return;
    try {
      await client.delete(`/api/v1/admin/model-groups/${activeGroup.id}/grants/${grant.user_id}`);
      await refreshGrants(activeGroup.id);
      await fetchGroups();
    } catch (err: any) {
      toast.error(`撤销失败：${err.response?.data?.message || '未知错误'}`);
    }
  };

  // ---------- 小组件:badge ----------
  const accessBadge = (mode: Group['access_mode']) => {
    const s = mode === 'PUBLIC'
      ? { bg: 'rgba(45,212,167,0.12)', text: '#2dd4a7', label: '🌐 公开' }
      : { bg: 'rgba(224,162,58,0.12)', text: '#e0a23a', label: '🔒 白名单' };
    return (
      <span style={{ padding: '3px 10px', fontSize: '11px', borderRadius: '2px', fontWeight: 500, backgroundColor: s.bg, color: s.text, border: `1px solid ${s.text}` }}>
        {s.label}
      </span>
    );
  };

  const statusBadge = (status: Group['status']) => {
    const s = status === 'ENABLE'
      ? { bg: 'rgba(45,212,167,0.12)', text: '#2dd4a7', label: '上架中' }
      : { bg: 'rgba(122,134,148,0.12)', text: '#7a8694', label: '已下架' };
    return (
      <span style={{ padding: '3px 10px', fontSize: '11px', borderRadius: '2px', fontWeight: 500, backgroundColor: s.bg, color: s.text, border: `1px solid ${s.text}` }}>
        {s.label}
      </span>
    );
  };

  // 授权下拉里排除已授权的人,只展示还没打勾的客人喵
  const grantedIds = new Set(grants.map((x) => x.user_id));
  const grantableUsers = allUsers.filter((u) => !grantedIds.has(u.id));

  return (
    <div className="mecha-content">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="mecha-page-title">📖 魔法菜单册</h1>
          <p className="mecha-page-sub">
            把后台真实模型包装成对外菜单名,定价、挂渠道、给客人打勾授权喵🐾
          </p>
        </div>
        <button
          onClick={openNewGroup}
          className="mecha-btn"
          style={{ width: 'auto', padding: '0 18px', height: '38px', letterSpacing: 'normal' }}
        >
          ＋ 新增菜单
        </button>
      </div>

      {errorMsg && (
        <div className="mecha-error" style={{ marginBottom: '16px' }}>{errorMsg}</div>
      )}

      {loading && <p style={{ color: 'var(--m-text-faint)' }}>加载中喵...</p>}

      {!loading && groups.length === 0 && (
        <div className="mecha-card" style={{ padding: '40px', textAlign: 'center' }}>
          <p style={{ fontSize: '15px', marginBottom: '8px', color: 'var(--m-text-sub)' }}>菜单册还是空的喵</p>
          <p style={{ color: 'var(--m-text-faint)' }}>点击右上角"新增菜单"写下第一道招牌📝</p>
        </div>
      )}

      {!loading && groups.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '12px' }}>
          {groups.map((g) => (
            <div
              key={g.id}
              className="mecha-card"
              style={{ borderLeft: `3px solid ${g.status === 'ENABLE' ? 'var(--m-ok)' : 'var(--m-border-strong)'}` }}
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <div className="flex items-center gap-3 mb-2">
                    <h3 style={{ fontSize: '15px', fontWeight: 500, color: 'var(--m-text)', margin: 0 }}>{g.name}</h3>
                    {accessBadge(g.access_mode)}
                    {statusBadge(g.status)}
                  </div>
                  {g.description && (
                    <p style={{ fontSize: '13px', marginBottom: '8px', color: 'var(--m-text-sub)' }}>{g.description}</p>
                  )}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '16px', fontSize: '11px', marginBottom: '4px', color: 'var(--m-text-sub)' }}>
                    <span>💰 入价 {g.prompt_price_real} 豆/百万</span>
                    <span>💸 出价 {g.completion_price_real} 豆/百万</span>
                    <span>📡 挂载渠道 {g.channel_count} 条</span>
                    <span>{g.access_mode === 'PUBLIC' ? '🌐 公开(人人可用)' : `🔒 已授权 ${g.grant_count} 人`}</span>
                  </div>
                  <div style={{ display: 'flex', gap: '16px', fontSize: '11px', color: 'var(--m-text-faint)' }}>
                    <span>ID: {g.id}</span>
                    <span>登记于: {fmtTime(g.created_at)}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-2 ml-4 shrink-0">
                  <div className="flex gap-2">
                    <button
                      onClick={() => openChannels(g)}
                      className="mecha-row-btn"
                      style={{ borderColor: 'var(--m-accent)', color: 'var(--m-accent)', padding: '5px 12px', fontSize: '12px' }}
                    >
                      📡 渠道
                    </button>
                    <button
                      onClick={() => openGrants(g)}
                      className="mecha-row-btn"
                      style={{ borderColor: 'var(--m-accent)', color: 'var(--m-accent)', padding: '5px 12px', fontSize: '12px' }}
                    >
                      ✅ 授权
                    </button>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => openEditGroup(g)}
                      className="mecha-row-btn"
                      style={{ borderColor: 'var(--m-accent)', color: 'var(--m-accent)', padding: '5px 12px', fontSize: '12px' }}
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => toggleGroupStatus(g)}
                      className="mecha-row-btn"
                      style={{
                        padding: '5px 12px', fontSize: '12px',
                        color: g.status === 'ENABLE' ? 'var(--m-warn)' : 'var(--m-ok)',
                        borderColor: g.status === 'ENABLE' ? 'var(--m-warn)' : 'var(--m-ok)',
                      }}
                    >
                      {g.status === 'ENABLE' ? '下架' : '上架'}
                    </button>
                    <button
                      onClick={() => deleteGroup(g)}
                      className="mecha-row-btn"
                      style={{ padding: '5px 12px', fontSize: '12px', color: 'var(--m-danger)', borderColor: 'var(--m-danger)' }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ========== 抽屉 ========== */}
      {drawerMode && (
        <>
          <div className="mecha-modal-mask" onClick={closeDrawer} />
          <div className="mecha-drawer" style={{ maxWidth: '520px' }}>
            <div style={{ padding: '24px' }}>
              <div className="flex items-center justify-between mb-6">
                <h2 className="mecha-modal-title">
                  {drawerMode === 'group' && (editingId === null ? '🐾 新增菜单' : '✏️ 编辑菜单')}
                  {drawerMode === 'channels' && `📡 管理渠道 · ${activeGroup?.name}`}
                  {drawerMode === 'grants' && `✅ 授权打勾 · ${activeGroup?.name}`}
                </h2>
                <button onClick={closeDrawer} className="mecha-modal-close">×</button>
              </div>

              {/* ----- 模式1:分组表单 ----- */}
              {drawerMode === 'group' && (
                <form onSubmit={submitGroup} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                  <div>
                    <label className="mecha-label">菜单名 *</label>
                    <input
                      type="text"
                      required
                      placeholder="如：deepseek3.2"
                      className="mecha-input"
                      value={groupForm.name}
                      onChange={(e) => setGroupForm({ ...groupForm, name: e.target.value })}
                    />
                    <p style={{ fontSize: '11px', marginTop: '4px', color: 'var(--m-text-faint)' }}>
                      这就是客人在 SillyTavern 的 model 字段里填的名字喵
                    </p>
                  </div>

                  <div>
                    <label className="mecha-label">描述(可选)</label>
                    <input
                      type="text"
                      placeholder="如：DeepSeek 满血版"
                      className="mecha-input"
                      value={groupForm.description}
                      onChange={(e) => setGroupForm({ ...groupForm, description: e.target.value })}
                    />
                  </div>

                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="mecha-label">入价(豆/百万)*</label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        required
                        placeholder="如：100"
                        className="mecha-input"
                        value={groupForm.prompt_price}
                        onChange={(e) => setGroupForm({ ...groupForm, prompt_price: e.target.value })}
                      />
                    </div>
                    <div className="flex-1">
                      <label className="mecha-label">出价(豆/百万)*</label>
                      <input
                        type="number"
                        step="any"
                        min="0"
                        required
                        placeholder="如：500"
                        className="mecha-input"
                        value={groupForm.completion_price}
                        onChange={(e) => setGroupForm({ ...groupForm, completion_price: e.target.value })}
                      />
                    </div>
                  </div>

                  <div>
                    <label className="mecha-label">授权模式 *</label>
                    <select
                      className="mecha-input"
                      value={groupForm.access_mode}
                      onChange={(e) => setGroupForm({ ...groupForm, access_mode: e.target.value as GroupForm['access_mode'] })}
                    >
                      <option value="PUBLIC">🌐 公开(所有客人都能用)</option>
                      <option value="WHITELIST">🔒 白名单(只有被打勾的客人能用)</option>
                    </select>
                  </div>

                  <div>
                    <label className="mecha-label">上架状态</label>
                    <select
                      className="mecha-input"
                      value={groupForm.status}
                      onChange={(e) => setGroupForm({ ...groupForm, status: e.target.value as GroupForm['status'] })}
                    >
                      <option value="ENABLE">上架中</option>
                      <option value="DISABLE">已下架</option>
                    </select>
                  </div>

                  <div className="flex gap-3 pt-4">
                    <button type="button" onClick={closeDrawer}
                      className="mecha-btn-ghost"
                      style={{ flex: 1, height: '40px' }}>取消</button>
                    <button type="submit" disabled={submitting}
                      className="mecha-btn"
                      style={{ flex: 1, letterSpacing: 'normal' }}>
                      {submitting ? '保存中...' : editingId === null ? '上架菜单 🐾' : '保存修改'}
                    </button>
                  </div>
                </form>
              )}

              {/* ----- 模式2:管理渠道 ----- */}
              {drawerMode === 'channels' && activeGroup && (
                <div className="space-y-5">
                  <div>
                    <h3 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--m-text-sub)' }}>已挂载的渠道</h3>
                    {links.length === 0 && (
                      <p style={{ fontSize: '13px', padding: '12px', borderRadius: '3px', background: 'var(--m-bg-3)', color: 'var(--m-text-mute)' }}>
                        还没挂任何渠道喵。空菜单客人是看不到、也点不了的,记得挂一条~
                      </p>
                    )}
                    <div className="space-y-2">
                      {links.map((link) => (
                        <div key={link.id} style={{ border: '1px solid var(--m-border)', borderRadius: '3px', padding: '12px', opacity: link.status === 'ENABLE' ? 1 : 0.6 }}>
                          <div className="flex items-center justify-between">
                            <div className="flex-1 min-w-0">
                              <div style={{ fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--m-text)' }}>
                                {link.channel_name || `渠道#${link.channel_id}`}
                                <span style={{ marginLeft: '8px', fontSize: '11px', color: 'var(--m-text-faint)' }}>→ {link.real_model_name}</span>
                              </div>
                              <div style={{ fontSize: '11px', marginTop: '2px', color: 'var(--m-text-faint)' }}>
                                权重 {link.weight} · {link.status === 'ENABLE' ? '生效中' : '已停用'}
                                {link.channel_status && link.channel_status !== 'ENABLE' && (
                                  <span style={{ color: 'var(--m-danger)' }}> · ⚠️ 渠道本身已停用</span>
                                )}
                              </div>
                            </div>
                            <div className="flex gap-2 ml-3 shrink-0">
                              <button onClick={() => toggleLinkStatus(link)}
                                className="mecha-row-btn"
                                style={{ borderColor: 'var(--m-accent)', color: 'var(--m-accent)' }}>
                                {link.status === 'ENABLE' ? '停用' : '启用'}
                              </button>
                              <button onClick={() => deleteLink(link)}
                                className="mecha-row-btn"
                                style={{ color: 'var(--m-danger)', borderColor: 'var(--m-danger)' }}>
                                卸下
                              </button>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ borderTop: '1px solid var(--m-border)', paddingTop: '16px' }}>
                    <h3 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--m-text-sub)' }}>挂一条新渠道</h3>
                    <div className="space-y-3">
                      <div>
                        <label className="mecha-label">选择渠道</label>
                        <select
                          className="mecha-input"
                          value={channelForm.channel_id}
                          onChange={(e) => setChannelForm({ ...channelForm, channel_id: e.target.value })}
                        >
                          <option value="">— 请选择 —</option>
                          {allChannels.map((c) => (
                            <option key={c.id} value={c.id}>
                              {c.name}（#{c.id}{c.status !== 'ENABLE' ? ' · 已停用' : ''}）
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="mecha-label">真实模型名</label>
                        <input
                          type="text"
                          placeholder="如：deepseek-ai/DeepSeek-V3.2"
                          className="mecha-input"
                          value={channelForm.real_model_name}
                          onChange={(e) => setChannelForm({ ...channelForm, real_model_name: e.target.value })}
                        />
                        <p style={{ fontSize: '11px', marginTop: '4px', color: 'var(--m-text-faint)' }}>
                          同一菜单下不同渠道可填各自的真名(负载均衡时上游命名可能不同)喵
                        </p>
                      </div>
                      <div className="flex gap-3">
                        <div className="w-24">
                          <label className="mecha-label">权重</label>
                          <input
                            type="number"
                            min="1"
                            className="mecha-input"
                            value={channelForm.weight}
                            onChange={(e) => setChannelForm({ ...channelForm, weight: e.target.value })}
                          />
                        </div>
                        <div className="flex-1">
                          <label className="mecha-label">状态</label>
                          <select
                            className="mecha-input"
                            value={channelForm.status}
                            onChange={(e) => setChannelForm({ ...channelForm, status: e.target.value as ChannelForm['status'] })}
                          >
                            <option value="ENABLE">生效中</option>
                            <option value="DISABLE">已停用</option>
                          </select>
                        </div>
                      </div>
                      <button onClick={addChannel} disabled={submitting}
                        className="mecha-btn"
                        style={{ width: '100%', letterSpacing: 'normal' }}>
                        {submitting ? '挂载中...' : '挂上这条渠道 📡'}
                      </button>
                    </div>
                  </div>
                </div>
              )}

              {/* ----- 模式3:授权打勾 ----- */}
              {drawerMode === 'grants' && activeGroup && (
                <div className="space-y-5">
                  {activeGroup.access_mode === 'PUBLIC' && (
                    <div style={{ padding: '12px', borderRadius: '3px', fontSize: '13px', background: 'rgba(45,212,167,0.1)', color: 'var(--m-ok)', border: '1px solid var(--m-ok)' }}>
                      🌐 这是公开菜单,所有客人都能用,无需打勾喵。
                      <span style={{ opacity: 0.8 }}>(下面的授权只在改成「白名单」后才会生效)</span>
                    </div>
                  )}

                  <div>
                    <h3 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--m-text-sub)' }}>已授权的客人({grants.length})</h3>
                    {grants.length === 0 && (
                      <p style={{ fontSize: '13px', padding: '12px', borderRadius: '3px', background: 'var(--m-bg-3)', color: 'var(--m-text-mute)' }}>
                        还没给任何客人打勾喵。
                      </p>
                    )}
                    <div className="space-y-2">
                      {grants.map((grant) => (
                        <div key={grant.user_id} style={{ border: '1px solid var(--m-border)', borderRadius: '3px', padding: '12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                          <div className="flex-1 min-w-0">
                            <div style={{ fontSize: '13px', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--m-text)' }}>
                              {grant.user_email || `用户#${grant.user_id}`}
                            </div>
                            <div style={{ fontSize: '11px', marginTop: '2px', color: 'var(--m-text-faint)' }}>
                              {grant.user_remark ? `备注: ${grant.user_remark} · ` : ''}打勾于 {fmtTime(grant.granted_at)}
                            </div>
                          </div>
                          <button onClick={() => removeGrant(grant)}
                            className="mecha-row-btn"
                            style={{ color: 'var(--m-danger)', borderColor: 'var(--m-danger)', marginLeft: '12px', flexShrink: 0 }}>
                            撤销
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div style={{ borderTop: '1px solid var(--m-border)', paddingTop: '16px' }}>
                    <h3 style={{ fontSize: '13px', fontWeight: 600, marginBottom: '8px', color: 'var(--m-text-sub)' }}>给客人打勾</h3>
                    <div className="flex gap-2">
                      <select
                        className="mecha-input" style={{ flex: 1 }}
                        value={grantUserId}
                        onChange={(e) => setGrantUserId(e.target.value)}
                      >
                        <option value="">— 选一位客人 —</option>
                        {grantableUsers.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.email}{u.remark ? `（${u.remark}）` : ''}
                          </option>
                        ))}
                      </select>
                      <button onClick={addGrant} disabled={submitting || !grantUserId}
                        className="mecha-btn"
                        style={{ width: 'auto', padding: '0 18px', letterSpacing: 'normal', flexShrink: 0 }}>
                        {submitting ? '...' : '✅ 打勾'}
                      </button>
                    </div>
                    {grantableUsers.length === 0 && allUsers.length > 0 && (
                      <p style={{ fontSize: '11px', marginTop: '8px', color: 'var(--m-text-faint)' }}>所有客人都已授权啦喵~</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
