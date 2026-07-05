import React, { useEffect, useState } from 'react';
import client from '../api/client';
import { useConfirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

interface Channel {
  id: number;
  name: string;
  base_url: string;
  api_key_encrypted: string;
  models: string[] | string | null;
  weight: number;
  priority: number;
  status: 'ENABLE' | 'DISABLE' | 'ERROR';
  owner_user_id: number | null;
  created_at: string;
}

interface FormData {
  name: string;
  base_url: string;
  api_key: string;
  models: string;
  weight: number;
  priority: number;
  status: 'ENABLE' | 'DISABLE' | 'ERROR';
  owner_user_id: string; // 表单里用字符串,空=公共渠道喵
}

const emptyForm: FormData = {
  name: '',
  base_url: '',
  api_key: '',
  models: '',
  weight: 1,
  priority: 1,
  status: 'ENABLE',
  owner_user_id: '',
};

export default function Channels() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const fetchChannels = async () => {
    try {
      console.info('[ADMIN-PORTAL][渠道页][请求] 获取渠道列表');
      const res = await client.get('/api/v1/admin/channels');
      setChannels(res.data.items || []);
    } catch (err: any) {
      const msg = err.response?.data?.message || '加载失败';
      console.error('[ADMIN-PORTAL][渠道页][失败]', msg);
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

  const openEditDrawer = (channel: Channel) => {
    setEditingId(channel.id);
    let modelsStr = '';
    if (Array.isArray(channel.models)) {
      modelsStr = channel.models.join(',');
    } else if (typeof channel.models === 'string' && channel.models) {
      try {
        const parsed = JSON.parse(channel.models);
        modelsStr = Array.isArray(parsed) ? parsed.join(',') : '';
      } catch {
        modelsStr = '';
      }
    }
    setForm({
      name: channel.name,
      base_url: channel.base_url,
      api_key: channel.api_key_encrypted,
      models: modelsStr,
      weight: channel.weight,
      priority: channel.priority,
      status: channel.status,
      owner_user_id: channel.owner_user_id != null ? String(channel.owner_user_id) : '',
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
    if (!form.name || !form.base_url || !form.api_key) {
      toast.error('名称、Base URL、API Key 不能为空喵');
      return;
    }

    setSubmitting(true);
    const modelsArr = form.models
      .split(',')
      .map((m) => m.trim())
      .filter((m) => m.length > 0);

    const payload = {
      name: form.name,
      base_url: form.base_url,
      api_key: form.api_key,
      models: modelsArr,
      weight: form.weight,
      priority: form.priority,
      status: form.status,
      owner_user_id: form.owner_user_id.trim() || null,
    };

    try {
      if (editingId === null) {
        console.info('[ADMIN-PORTAL][渠道页][新增] 提交');
        await client.post('/api/v1/admin/channels', payload);
      } else {
        console.info(`[ADMIN-PORTAL][渠道页][编辑] 提交 ID: ${editingId}`);
        await client.put(`/api/v1/admin/channels/${editingId}`, payload);
      }
      closeDrawer();
      await fetchChannels();
    } catch (err: any) {
      const msg = err.response?.data?.message || '保存失败';
      toast.error(`保存失败：${msg}`);
      console.error('[ADMIN-PORTAL][渠道页][保存失败]', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!(await confirm({ message: `确定要下架渠道「${name}」吗喵？`, danger: true }))) return;
    try {
      console.info(`[ADMIN-PORTAL][渠道页][删除] ID: ${id}`);
      await client.delete(`/api/v1/admin/channels/${id}`);
      await fetchChannels();
    } catch (err: any) {
      const msg = err.response?.data?.message || '删除失败';
      toast.error(`删除失败：${msg}`);
    }
  };

  const handleToggleStatus = async (channel: Channel) => {
    const newStatus = channel.status === 'ENABLE' ? 'DISABLE' : 'ENABLE';
    try {
      console.info(`[ADMIN-PORTAL][渠道页][切换状态] ID: ${channel.id}, 新状态: ${newStatus}`);
      let modelsArr: string[] = [];
      if (Array.isArray(channel.models)) {
        modelsArr = channel.models;
      } else if (typeof channel.models === 'string' && channel.models) {
        try { modelsArr = JSON.parse(channel.models); } catch { modelsArr = []; }
      }
      await client.put(`/api/v1/admin/channels/${channel.id}`, {
        name: channel.name,
        base_url: channel.base_url,
        api_key: channel.api_key_encrypted,
        models: modelsArr,
        weight: channel.weight,
        priority: channel.priority,
        status: newStatus,
        owner_user_id: channel.owner_user_id, // 别让快捷切换把专属归属冲掉喵
      });
      await fetchChannels();
    } catch (err: any) {
      const msg = err.response?.data?.message || '操作失败';
      toast.error(`操作失败：${msg}`);
    }
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, { bg: string; text: string; label: string }> = {
      ENABLE: { bg: 'rgba(45,212,167,0.12)', text: '#2dd4a7', label: '营业中' },
      DISABLE: { bg: 'rgba(216,112,74,0.12)', text: '#d8704a', label: '已下架' },
      ERROR: { bg: 'rgba(224,162,58,0.12)', text: '#e0a23a', label: '异常' },
    };
    const style = styles[status] || styles.ENABLE;
    return (
      <span
        style={{ padding: '3px 10px', fontSize: '11px', borderRadius: '2px', fontWeight: 500, backgroundColor: style.bg, color: style.text, border: `1px solid ${style.text}` }}
      >
        {style.label}
      </span>
    );
  };

  const parseModels = (models: string[] | string | null): string[] => {
    if (Array.isArray(models)) return models;
    if (typeof models === 'string' && models) {
      try {
        const parsed = JSON.parse(models);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    }
    return [];
  };

  const maskUrl = (url: string) => {
    try {
      const u = new URL(url);
      return u.hostname;
    } catch {
      return url;
    }
  };

  return (
    <div className="mecha-content">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="mecha-page-title">📡 进货书架</h1>
          <p className="mecha-page-sub">
            管理上游 API 渠道喵🐾
          </p>
        </div>
        <button
          onClick={openNewDrawer}
          className="mecha-btn"
          style={{ width: 'auto', padding: '0 18px', height: '38px', letterSpacing: 'normal' }}
        >
          ➕ 新增渠道
        </button>
      </div>

      {loading && (
        <p style={{ color: 'var(--m-text-sub)' }}>正在加载渠道列表喵...</p>
      )}

      {errorMsg && (
        <div className="mecha-error">加载失败：{errorMsg}</div>
      )}

      {!loading && !errorMsg && channels.length === 0 && (
        <div className="mecha-card" style={{ padding: '48px', textAlign: 'center' }}>
          <p style={{ fontSize: '15px', marginBottom: '12px', color: 'var(--m-text-sub)' }}>
            还没有任何渠道喵~
          </p>
          <p style={{ color: 'var(--m-text-faint)' }}>
            点击右上角"新增渠道"开始进货吧🛒
          </p>
        </div>
      )}

      {!loading && channels.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '12px' }}>
          {channels.map((ch) => {
            const modelList = parseModels(ch.models);
            return (
              <div
                key={ch.id}
                className="mecha-card"
                style={{ borderLeft: `3px solid ${ch.status === 'ENABLE' ? 'var(--m-ok)' : 'var(--m-border-strong)'}` }}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 style={{ fontSize: '15px', fontWeight: 500, color: 'var(--m-text)', margin: 0 }}>
                        {ch.name}
                      </h3>
                      {getStatusBadge(ch.status)}
                      {ch.owner_user_id != null && (
                        <span
                          style={{ padding: '3px 10px', fontSize: '11px', borderRadius: '2px', fontWeight: 500, backgroundColor: 'var(--m-accent-dim)', color: 'var(--m-accent)', border: '1px solid var(--m-accent)' }}
                        >
                          🔒 专属书架·主人ID {ch.owner_user_id}
                        </span>
                      )}
                    </div>
                    <p style={{ fontSize: '13px', marginBottom: '8px', color: 'var(--m-text-sub)' }}>
                      🌐 {maskUrl(ch.base_url)}
                    </p>
                    <div className="flex flex-wrap gap-1 mb-2">
                      {modelList.length > 0 ? (
                        modelList.map((m) => (
                          <span
                            key={m}
                            className="mecha-chip"
                          >
                            {m}
                          </span>
                        ))
                      ) : (
                        <span style={{ fontSize: '11px', color: 'var(--m-text-faint)' }}>
                          未指定模型
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '16px', fontSize: '11px', color: 'var(--m-text-faint)' }}>
                      <span>权重: {ch.weight}</span>
                      <span>优先级: {ch.priority}</span>
                      <span>ID: {ch.id}</span>
                    </div>
                  </div>
                  <div className="flex gap-2 ml-4">
                    <button
                      onClick={() => openEditDrawer(ch)}
                      className="mecha-row-btn"
                      style={{ borderColor: 'var(--m-accent)', color: 'var(--m-accent)', padding: '5px 12px', fontSize: '12px' }}
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => handleToggleStatus(ch)}
                      className="mecha-row-btn"
                      style={{
                        padding: '5px 12px', fontSize: '12px',
                        color: ch.status === 'ENABLE' ? 'var(--m-warn)' : 'var(--m-ok)',
                        borderColor: ch.status === 'ENABLE' ? 'var(--m-warn)' : 'var(--m-ok)',
                      }}
                    >
                      {ch.status === 'ENABLE' ? '禁用' : '启用'}
                    </button>
                    <button
                      onClick={() => handleDelete(ch.id, ch.name)}
                      className="mecha-row-btn"
                      style={{ padding: '5px 12px', fontSize: '12px', color: 'var(--m-danger)', borderColor: 'var(--m-danger)' }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {drawerOpen && (
        <>
          <div className="mecha-modal-mask" onClick={closeDrawer} />
          <div className="mecha-drawer">
            <div style={{ padding: '24px' }}>
              <div className="flex items-center justify-between mb-6">
                <h2 className="mecha-modal-title">
                  {editingId === null ? '🐾 新增渠道' : '✏️ 编辑渠道'}
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
                    placeholder="如：硅基流动-主力"
                    className="mecha-input"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>

                <div>
                  <label className="mecha-label">
                    Base URL *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="如：https://api.siliconflow.cn/v1"
                    className="mecha-input"
                    value={form.base_url}
                    onChange={(e) => setForm({ ...form, base_url: e.target.value })}
                  />
                  <p style={{ fontSize: '11px', marginTop: '4px', color: 'var(--m-text-faint)' }}>
                    填到 /v1 为止喵~网关只在末尾拼 /chat/completions，上游带不带 /v1 都听这个 URL 的
                  </p>
                </div>

                <div>
                  <label className="mecha-label">
                    API Key *
                  </label>
                  <input
                    type="password"
                    required
                    placeholder="sk-xxxxxxxxxxxxxxxxxx"
                    className="mecha-input"
                    value={form.api_key}
                    onChange={(e) => setForm({ ...form, api_key: e.target.value })}
                  />
                  <p style={{ fontSize: '11px', marginTop: '4px', color: 'var(--m-text-faint)' }}>
                    暂以明文存储，后续会加密层处理
                  </p>
                </div>

                <div>
                  <label className="mecha-label">
                    支持的模型（逗号分隔）
                  </label>
                  <input
                    type="text"
                    placeholder="如：deepseek-ai/DeepSeek-V3.2,gpt-4"
                    className="mecha-input"
                    value={form.models}
                    onChange={(e) => setForm({ ...form, models: e.target.value })}
                  />
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

                {editingId !== null && (
                  <div>
                    <label className="mecha-label">
                      状态
                    </label>
                    <select
                      className="mecha-input"
                      value={form.status}
                      onChange={(e) => setForm({ ...form, status: e.target.value as any })}
                    >
                      <option value="ENABLE">启用</option>
                      <option value="DISABLE">禁用</option>
                      <option value="ERROR">异常</option>
                    </select>
                  </div>
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
                    {submitting ? '保存中...' : editingId === null ? '上架入库 🐾' : '保存修改'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </>
      )}

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}
