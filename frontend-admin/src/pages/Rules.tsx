import React, { useEffect, useState } from 'react';
import client from '../api/client';
import { useConfirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

interface Rule {
  id: number;
  name: string;
  rule_type: 'BLACKLIST' | 'SHADOW' | 'DRYRUN';
  match_conditions: { keywords?: string[]; models?: string[] } | string | null;
  status: 'ENABLE' | 'DISABLE';
  created_at: string;
}

interface FormData {
  name: string;
  rule_type: 'BLACKLIST' | 'SHADOW' | 'DRYRUN';
  keywords: string;
  models: string;
  status: 'ENABLE' | 'DISABLE';
}

const emptyForm: FormData = {
  name: '',
  rule_type: 'BLACKLIST',
  keywords: '',
  models: '',
  status: 'ENABLE',
};

// 把数据库里的 match_conditions(可能是对象,也可能是 JSON 字符串)安全拆开喵
const parseConditions = (
  mc: Rule['match_conditions']
): { keywords: string[]; models: string[] } => {
  let obj: any = mc;
  if (typeof mc === 'string' && mc) {
    try {
      obj = JSON.parse(mc);
    } catch {
      obj = null;
    }
  }
  return {
    keywords: Array.isArray(obj?.keywords) ? obj.keywords : [],
    models: Array.isArray(obj?.models) ? obj.models : [],
  };
};

// 逗号分隔字符串 → 去空格去空项的数组喵
const splitCsv = (s: string): string[] =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

export default function Rules() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormData>(emptyForm);
  const [submitting, setSubmitting] = useState(false);

  const fetchRules = async () => {
    try {
      console.info('[ADMIN-PORTAL][规则页][请求] 获取规则列表');
      const res = await client.get('/api/v1/admin/rules');
      setRules(res.data.items || []);
    } catch (err: any) {
      const msg = err.response?.data?.message || '加载失败';
      console.error('[ADMIN-PORTAL][规则页][失败]', msg);
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRules();
  }, []);

  const openNewDrawer = () => {
    setEditingId(null);
    setForm(emptyForm);
    setDrawerOpen(true);
  };

  const openEditDrawer = (rule: Rule) => {
    const cond = parseConditions(rule.match_conditions);
    setEditingId(rule.id);
    setForm({
      name: rule.name,
      rule_type: rule.rule_type,
      keywords: cond.keywords.join(','),
      models: cond.models.join(','),
      status: rule.status,
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
    if (!form.name.trim()) {
      toast.error('请给规则起个名字喵');
      return;
    }
    const keywordsArr = splitCsv(form.keywords);
    const modelsArr = splitCsv(form.models);
    if (keywordsArr.length === 0 && modelsArr.length === 0) {
      toast.error('关键词和模型至少要填一个,不然安检员不知道要拦谁喵');
      return;
    }

    // 只把真正填了的条件放进 JSON,保持和后端注释的格式一致喵
    const matchConditions: { keywords?: string[]; models?: string[] } = {};
    if (keywordsArr.length > 0) matchConditions.keywords = keywordsArr;
    if (modelsArr.length > 0) matchConditions.models = modelsArr;

    const payload = {
      name: form.name.trim(),
      rule_type: form.rule_type,
      match_conditions: matchConditions,
      status: form.status,
    };

    setSubmitting(true);
    try {
      if (editingId === null) {
        console.info('[ADMIN-PORTAL][规则页][新增] 提交');
        await client.post('/api/v1/admin/rules', payload);
      } else {
        console.info(`[ADMIN-PORTAL][规则页][编辑] 提交 ID: ${editingId}`);
        await client.put(`/api/v1/admin/rules/${editingId}`, payload);
      }
      closeDrawer();
      await fetchRules();
    } catch (err: any) {
      const msg = err.response?.data?.message || '保存失败';
      toast.error(`保存失败：${msg}`);
      console.error('[ADMIN-PORTAL][规则页][保存失败]', msg);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!(await confirm({ message: `确定要撤下安检规则「${name}」吗喵？`, danger: true }))) return;
    try {
      console.info(`[ADMIN-PORTAL][规则页][删除] ID: ${id}`);
      await client.delete(`/api/v1/admin/rules/${id}`);
      await fetchRules();
    } catch (err: any) {
      const msg = err.response?.data?.message || '删除失败';
      toast.error(`删除失败：${msg}`);
    }
  };

  // 规则接口支持只传要改的字段,所以切状态只发一个 status 就够了喵
  const handleToggleStatus = async (rule: Rule) => {
    const newStatus = rule.status === 'ENABLE' ? 'DISABLE' : 'ENABLE';
    try {
      console.info(`[ADMIN-PORTAL][规则页][切换状态] ID: ${rule.id}, 新状态: ${newStatus}`);
      await client.put(`/api/v1/admin/rules/${rule.id}`, { status: newStatus });
      await fetchRules();
    } catch (err: any) {
      const msg = err.response?.data?.message || '操作失败';
      toast.error(`操作失败：${msg}`);
    }
  };

  const getTypeBadge = (ruleType: Rule['rule_type']) => {
    const styles: Record<string, { bg: string; text: string; label: string }> = {
      BLACKLIST: { bg: 'rgba(216,112,74,0.12)', text: '#d8704a', label: '🚫 黑名单·拒之门外' },
      SHADOW: { bg: 'rgba(122,134,148,0.14)', text: '#9aa6b3', label: '👻 影子·暗中观察' },
      DRYRUN: { bg: 'rgba(224,162,58,0.12)', text: '#e0a23a', label: '☕ Dry-Run·等店长裁决' },
    };
    const style = styles[ruleType] || styles.BLACKLIST;
    return (
      <span
        style={{ padding: '3px 10px', fontSize: '11px', borderRadius: '2px', fontWeight: 500, backgroundColor: style.bg, color: style.text, border: `1px solid ${style.text}` }}
      >
        {style.label}
      </span>
    );
  };

  const getStatusBadge = (status: Rule['status']) => {
    const styles: Record<string, { bg: string; text: string; label: string }> = {
      ENABLE: { bg: 'rgba(45,212,167,0.12)', text: '#2dd4a7', label: '生效中' },
      DISABLE: { bg: 'rgba(122,134,148,0.12)', text: '#7a8694', label: '已停用' },
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

  return (
    <div className="mecha-content">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h1 className="mecha-page-title">安检规则手册</h1>
          <p className="mecha-page-sub">管理风控规则,女仆猫按手册安检喵🐾</p>
        </div>
        <button
          onClick={openNewDrawer}
          className="mecha-btn"
          style={{ width: 'auto', padding: '0 18px', height: '38px', letterSpacing: 'normal' }}
        >
          ➕ 新增规则
        </button>
      </div>

      {loading && (
        <p style={{ color: 'var(--m-text-sub)' }}>正在加载规则列表喵...</p>
      )}

      {errorMsg && (
        <div className="mecha-error">加载失败：{errorMsg}</div>
      )}

      {!loading && !errorMsg && rules.length === 0 && (
        <div className="mecha-card" style={{ padding: '48px', textAlign: 'center' }}>
          <p style={{ fontSize: '15px', marginBottom: '12px', color: 'var(--m-text-sub)' }}>
            手册还是空白的喵~
          </p>
          <p style={{ color: 'var(--m-text-faint)' }}>
            点击右上角"新增规则"写下第一条安检条款📝
          </p>
        </div>
      )}

      {!loading && rules.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '12px' }}>
          {rules.map((rule) => {
            const cond = parseConditions(rule.match_conditions);
            return (
              <div
                key={rule.id}
                className="mecha-card"
                style={{ borderLeft: `3px solid ${rule.status === 'ENABLE' ? 'var(--m-ok)' : 'var(--m-border-strong)'}` }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                      <h3 style={{ fontSize: '15px', fontWeight: 500, color: 'var(--m-text)', margin: 0 }}>
                        {rule.name}
                      </h3>
                      {getTypeBadge(rule.rule_type)}
                      {getStatusBadge(rule.status)}
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px', marginBottom: '8px' }}>
                      {cond.keywords.map((k) => (
                        <span key={`kw-${k}`} className="mecha-chip" style={{ color: 'var(--m-danger)', borderColor: 'var(--m-danger)', background: 'rgba(216,112,74,0.08)' }}>
                          🔍 {k}
                        </span>
                      ))}
                      {cond.models.map((m) => (
                        <span key={`md-${m}`} className="mecha-chip">
                          🤖 {m}
                        </span>
                      ))}
                      {cond.keywords.length === 0 && cond.models.length === 0 && (
                        <span style={{ fontSize: '11px', color: 'var(--m-text-faint)' }}>
                          未设置匹配条件
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '16px', fontSize: '11px', color: 'var(--m-text-faint)' }}>
                      <span>ID: {rule.id}</span>
                      <span>登记于: {rule.created_at ? String(rule.created_at).replace('T', ' ').slice(0, 19) : '-'}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: '8px', marginLeft: '16px' }}>
                    <button
                      onClick={() => openEditDrawer(rule)}
                      className="mecha-row-btn"
                      style={{ borderColor: 'var(--m-accent)', color: 'var(--m-accent)', padding: '5px 12px', fontSize: '12px' }}
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => handleToggleStatus(rule)}
                      className="mecha-row-btn"
                      style={{
                        padding: '5px 12px', fontSize: '12px',
                        color: rule.status === 'ENABLE' ? 'var(--m-warn)' : 'var(--m-ok)',
                        borderColor: rule.status === 'ENABLE' ? 'var(--m-warn)' : 'var(--m-ok)',
                      }}
                    >
                      {rule.status === 'ENABLE' ? '停用' : '启用'}
                    </button>
                    <button
                      onClick={() => handleDelete(rule.id, rule.name)}
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
                <h2 className="mecha-modal-title">
                  {editingId === null ? '🐾 新增安检规则' : '✏️ 编辑安检规则'}
                </h2>
                <button onClick={closeDrawer} className="mecha-modal-close">×</button>
              </div>

              <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div>
                  <label className="mecha-label">规则名称 *</label>
                  <input
                    type="text"
                    required
                    placeholder="如：危险词拦截"
                    className="mecha-input"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>

                <div>
                  <label className="mecha-label">规则类型 *</label>
                  <select
                    className="mecha-input"
                    value={form.rule_type}
                    onChange={(e) => setForm({ ...form, rule_type: e.target.value as FormData['rule_type'] })}
                  >
                    <option value="BLACKLIST">🚫 黑名单(直接 403 拒之门外)</option>
                    <option value="SHADOW">👻 影子(放行但克隆进档案柜)</option>
                    <option value="DRYRUN">☕ Dry-Run(挂起等店长裁决)</option>
                  </select>
                </div>

                <div>
                  <label className="mecha-label">匹配关键词（逗号分隔）</label>
                  <input
                    type="text"
                    placeholder="如：炸弹,做炸弹"
                    className="mecha-input"
                    value={form.keywords}
                    onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                  />
                  <p style={{ fontSize: '11px', marginTop: '4px', color: 'var(--m-text-faint)' }}>
                    消息内容命中任意一个关键词即触发规则喵
                  </p>
                </div>

                <div>
                  <label className="mecha-label">匹配模型（逗号分隔，可留空）</label>
                  <input
                    type="text"
                    placeholder="如：deepseek-ai/DeepSeek-V3.2"
                    className="mecha-input"
                    value={form.models}
                    onChange={(e) => setForm({ ...form, models: e.target.value })}
                  />
                  <p style={{ fontSize: '11px', marginTop: '4px', color: 'var(--m-text-faint)' }}>
                    关键词和模型至少填一个喵
                  </p>
                </div>

                {editingId !== null && (
                  <div>
                    <label className="mecha-label">状态</label>
                    <select
                      className="mecha-input"
                      value={form.status}
                      onChange={(e) => setForm({ ...form, status: e.target.value as FormData['status'] })}
                    >
                      <option value="ENABLE">生效中</option>
                      <option value="DISABLE">已停用</option>
                    </select>
                  </div>
                )}

                <div style={{ display: 'flex', gap: '12px', paddingTop: '8px' }}>
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
                    {submitting ? '保存中...' : editingId === null ? '登记入册 🐾' : '保存修改'}
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
