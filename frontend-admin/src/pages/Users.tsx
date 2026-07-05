import React, { useEffect, useState } from 'react';
import client from '../api/client';
import { useConfirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

interface User {
  id: number;
  email: string;
  balance: number;
  status: 'ACTIVE' | 'BANNED' | 'ARREARS' | 'BLACKLIST';
  remark: string | null;
  created_at: string;
}

export default function Users() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 20;

  // 亲手登记会员弹窗 (F.1a)
  const [registerOpen, setRegisterOpen] = useState(false);
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regRemark, setRegRemark] = useState('');
  const [regSubmitting, setRegSubmitting] = useState(false);

  // 备注行内编辑 (F.1a)
  const [editingRemarkId, setEditingRemarkId] = useState<number | null>(null);
  const [remarkDraft, setRemarkDraft] = useState('');
  const [remarkSaving, setRemarkSaving] = useState(false);

  // 手动充值弹窗
  const [topupOpen, setTopupOpen] = useState(false);
  const [topupUser, setTopupUser] = useState<User | null>(null);
  const [topupAmount, setTopupAmount] = useState('');
  const [topupNote, setTopupNote] = useState('');
  const [topupSubmitting, setTopupSubmitting] = useState(false);

  const fetchUsers = async () => {
    setLoading(true);
    try {
      console.info(`[ADMIN-PORTAL][用户页][请求] page=${page}, search=${search}`);
      const res = await client.get('/api/v1/admin/users', {
        params: { page, limit: pageSize, search },
      });
      setUsers(res.data.items || []);
      setTotal(res.data.total || 0);
      setErrorMsg('');
    } catch (err: any) {
      const msg = err.response?.data?.message || '加载失败';
      console.error('[ADMIN-PORTAL][用户页][失败]', msg);
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchUsers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, search]);

  const handleSearch = () => {
    setPage(1);
    setSearch(searchInput.trim());
  };

  const handleSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSearch();
  };

  const handleToggleBan = async (user: User) => {
    const newStatus = user.status === 'BANNED' ? 'ACTIVE' : 'BANNED';
    const action = newStatus === 'BANNED' ? '封号' : '解封';
    if (!(await confirm({
      message: `确定要${action}用户「${user.email}」吗喵？`,
      danger: newStatus === 'BANNED',
    }))) return;

    try {
      console.info(`[ADMIN-PORTAL][用户页][状态] ID: ${user.id}, 新状态: ${newStatus}`);
      await client.put(`/api/v1/admin/users/${user.id}/status`, { status: newStatus });
      await fetchUsers();
    } catch (err: any) {
      const msg = err.response?.data?.message || '操作失败';
      toast.error(`操作失败：${msg}`);
    }
  };

  // S1+(2026-06-23): 拉黑/解黑切换
  //   语义:能用但不能滥用——允许 API 但 RPM 降为 blacklist_rpm_limit(默认 2/min)
  //   与封号(BANNED)的区别:拉黑允许登录 + 允许 API + 拒福利, 封号全拒
  //   BANNED 状态下拉黑按钮置灰(已经更严, 不允许降级到 BLACKLIST)
  const handleToggleBlacklist = async (user: User) => {
    const newStatus = user.status === 'BLACKLIST' ? 'ACTIVE' : 'BLACKLIST';
    const hint = newStatus === 'BLACKLIST'
      ? `确定要拉黑用户「${user.email}」吗喵？\n拉黑后:仍可登录 + 可用 API 但限速到店长设定的上限,不能领福利。`
      : `确定要解黑用户「${user.email}」吗喵？\n解黑后恢复正常会员所有权限。`;
    if (!(await confirm({ message: hint, danger: newStatus === 'BLACKLIST' }))) return;

    try {
      console.info(`[ADMIN-PORTAL][用户页][拉黑] ID: ${user.id}, 新状态: ${newStatus}`);
      await client.put(`/api/v1/admin/users/${user.id}/status`, { status: newStatus });
      await fetchUsers();
    } catch (err: any) {
      const msg = err.response?.data?.message || '操作失败';
      toast.error(`操作失败：${msg}`);
    }
  };

  // ===== F.1.7 删除会员 (销账留账本, 两道确认) =====
  const handleDeleteUser = async (user: User) => {
    // 第一道: 普通确认
    if (!(await confirm({
      message: `确定删除会员「${user.email}」吗？账号、召唤铃、余额都会消失,此操作不可逆喵！`,
      danger: true,
    }))) return;

    // 第二道: 余额 > 0 多一道警告
    if (user.balance > 0) {
      if (!(await confirm({
        message: `⚠️ 这位还剩 ${user.balance.toFixed(4)} 颗咖啡豆,删除后豆豆会一起化烟,真的确定吗喵？`,
        danger: true,
      }))) return;
    }

    try {
      console.info(`[ADMIN-PORTAL][用户页][删除] userId: ${user.id}, email: ${user.email}`);
      await client.delete(`/api/v1/admin/users/${user.id}`);
      toast.success(`会员「${user.email}」已从店里抹去喵~(账单流水作为历史留存)`);
      await fetchUsers();
    } catch (err: any) {
      const msg = err.response?.data?.message || '删除失败';
      toast.error(`删除失败：${msg}`);
    }
  };

  // ===== 亲手登记会员 (F.1a) =====
  const openRegister = () => {
    setRegEmail('');
    setRegPassword('');
    setRegRemark('');
    setRegisterOpen(true);
  };

  const closeRegister = () => {
    setRegisterOpen(false);
  };

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!regEmail.trim() || !regPassword) {
      toast.error('邮箱和初始密码不能为空喵');
      return;
    }
    setRegSubmitting(true);
    try {
      console.info(`[ADMIN-PORTAL][用户页][登记会员] email: ${regEmail}`);
      const res = await client.post('/api/v1/admin/users', {
        email: regEmail.trim(),
        password: regPassword,
        remark: regRemark.trim() || undefined,
      });
      toast.success(res.data.message + `\n新会员ID：${res.data.id}`);
      closeRegister();
      await fetchUsers();
    } catch (err: any) {
      const msg = err.response?.data?.message || '登记失败';
      toast.error(`登记失败：${msg}`);
    } finally {
      setRegSubmitting(false);
    }
  };

  // ===== 备注行内编辑 (F.1a) =====
  const startEditRemark = (user: User) => {
    setEditingRemarkId(user.id);
    setRemarkDraft(user.remark || '');
  };

  const cancelEditRemark = () => {
    setEditingRemarkId(null);
    setRemarkDraft('');
  };

  const saveRemark = async (userId: number) => {
    setRemarkSaving(true);
    try {
      console.info(`[ADMIN-PORTAL][用户页][备注] userId: ${userId}`);
      await client.put(`/api/v1/admin/users/${userId}/remark`, {
        remark: remarkDraft.trim(),
      });
      cancelEditRemark();
      await fetchUsers();
    } catch (err: any) {
      const msg = err.response?.data?.message || '操作失败';
      toast.error(`保存备注失败：${msg}`);
    } finally {
      setRemarkSaving(false);
    }
  };

  const openTopup = (user: User) => {
    setTopupUser(user);
    setTopupAmount('');
    setTopupNote('');
    setTopupOpen(true);
  };

  const closeTopup = () => {
    setTopupOpen(false);
    setTopupUser(null);
    setTopupAmount('');
    setTopupNote('');
  };

  const handleTopupSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!topupUser) return;

    const amt = parseFloat(topupAmount);
    if (isNaN(amt) || amt === 0) {
      toast.error('请输入非零金额喵');
      return;
    }

    if (amt < 0) {
      if (!(await confirm({
        message: `确认扣除「${topupUser.email}」${Math.abs(amt)} 咖啡豆吗喵？`,
        danger: true,
      }))) return;
    }

    setTopupSubmitting(true);
    try {
      console.info(`[ADMIN-PORTAL][用户页][充值] userId: ${topupUser.id}, amount: ${amt}`);
      const res = await client.post(`/api/v1/admin/users/${topupUser.id}/topup`, {
        amount: amt,
        note: topupNote || undefined,
      });
      toast.success(res.data.message + `\n流水号：${res.data.reference_id}`);
      closeTopup();
      await fetchUsers();
    } catch (err: any) {
      const msg = err.response?.data?.message || '操作失败';
      toast.error(`操作失败：${msg}`);
    } finally {
      setTopupSubmitting(false);
    }
  };

  const getStatusBadge = (status: string) => {
    const styles: Record<string, { bg: string; text: string; label: string }> = {
      ACTIVE: { bg: 'rgba(45,212,167,0.12)', text: '#2dd4a7', label: '正常' },
      BANNED: { bg: 'rgba(216,112,74,0.12)', text: '#d8704a', label: '封禁' },
      ARREARS: { bg: 'rgba(224,162,58,0.12)', text: '#e0a23a', label: '欠费' },
      BLACKLIST: { bg: 'rgba(216,112,74,0.18)', text: '#e8845a', label: '拉黑' },
    };
    const style = styles[status] || styles.ACTIVE;
    return (
      <span
        style={{ padding: '3px 10px', fontSize: '11px', borderRadius: '2px', fontWeight: 500, backgroundColor: style.bg, color: style.text, border: `1px solid ${style.text}` }}
      >
        {style.label}
      </span>
    );
  };

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="mecha-content">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '20px' }}>
        <div>
          <h1 className="mecha-page-title">常客名册</h1>
          <p className="mecha-page-sub">管理下游客户的会员档案喵🐾</p>
        </div>
        <button
          onClick={openRegister}
          className="mecha-btn"
          style={{ width: 'auto', padding: '0 18px', height: '38px', letterSpacing: 'normal' }}
        >
          🐾 亲手登记会员
        </button>
      </div>

      {/* 搜索栏 */}
      <div className="mecha-card" style={{ marginBottom: '16px', display: 'flex', gap: '8px' }}>
        <input
          type="text"
          placeholder="按邮箱或备注搜索(如:同学)..."
          className="mecha-input"
          style={{ flex: 1 }}
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
          onKeyDown={handleSearchKey}
        />
        <button
          onClick={handleSearch}
          className="mecha-btn"
          style={{ width: 'auto', padding: '0 18px', height: '38px', letterSpacing: 'normal' }}
        >
          🔍 搜索
        </button>
        {search && (
          <button
            onClick={() => {
              setSearchInput('');
              setSearch('');
              setPage(1);
            }}
            className="mecha-btn-ghost"
            style={{ padding: '0 16px', height: '38px' }}
          >
            清除
          </button>
        )}
      </div>

      {loading && <p style={{ color: 'var(--m-text-sub)' }}>正在加载用户列表喵...</p>}
      {errorMsg && <div className="mecha-error">加载失败：{errorMsg}</div>}

      {!loading && !errorMsg && users.length === 0 && (
        <div className="mecha-card" style={{ padding: '48px', textAlign: 'center' }}>
          <p style={{ color: 'var(--m-text-faint)' }}>
            {search ? `没有找到匹配「${search}」的用户喵~` : '还没有任何用户喵~'}
          </p>
        </div>
      )}

      {!loading && users.length > 0 && (
        <>
          <div className="mecha-card" style={{ padding: 0, overflow: 'hidden' }}>
            <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ color: 'var(--m-text-mute)', background: 'var(--m-bg-1)', borderBottom: '1px solid var(--m-border)' }}>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 500 }}>ID</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 500 }}>邮箱</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right', fontWeight: 500 }}>余额（咖啡豆）</th>
                  <th style={{ padding: '12px 16px', textAlign: 'center', fontWeight: 500 }}>状态</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 500 }}>备注</th>
                  <th style={{ padding: '12px 16px', textAlign: 'left', fontWeight: 500 }}>注册时间</th>
                  <th style={{ padding: '12px 16px', textAlign: 'center', fontWeight: 500 }}>操作</th>
                </tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id} style={{ color: 'var(--m-text-sub)', borderTop: '1px solid var(--m-border-soft)' }}>
                    <td style={{ padding: '12px 16px' }}>{u.id}</td>
                    <td style={{ padding: '12px 16px' }}>{u.email}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'right', fontFamily: 'monospace' }}>{u.balance.toFixed(4)}</td>
                    <td style={{ padding: '12px 16px', textAlign: 'center' }}>{getStatusBadge(u.status)}</td>
                    <td style={{ padding: '12px 16px', maxWidth: '220px' }}>
                      {editingRemarkId === u.id ? (
                        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                          <input
                            type="text"
                            autoFocus
                            className="mecha-input"
                            style={{ flex: 1, height: '30px', fontSize: '12px', padding: '0 8px' }}
                            value={remarkDraft}
                            onChange={(e) => setRemarkDraft(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveRemark(u.id);
                              if (e.key === 'Escape') cancelEditRemark();
                            }}
                          />
                          <button
                            onClick={() => saveRemark(u.id)}
                            disabled={remarkSaving}
                            className="mecha-row-btn"
                            style={{ borderColor: 'var(--m-accent)', color: 'var(--m-accent)' }}
                          >
                            存
                          </button>
                          <button
                            onClick={cancelEditRemark}
                            className="mecha-row-btn"
                            style={{ borderColor: 'var(--m-text-mute)', color: 'var(--m-text-mute)' }}
                          >
                            ×
                          </button>
                        </div>
                      ) : (
                        <div
                          style={{ fontSize: '12px', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: u.remark ? 'var(--m-text-sub)' : 'var(--m-text-faint)' }}
                          title="点击编辑备注喵"
                          onClick={() => startEditRemark(u)}
                        >
                          {u.remark || '✏️ 点击写备注'}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '12px 16px', fontSize: '11px', color: 'var(--m-text-faint)' }}>
                      {new Date(u.created_at).toLocaleString('zh-CN')}
                    </td>
                    <td style={{ padding: '12px 16px' }}>
                      <div style={{ display: 'flex', gap: '6px', justifyContent: 'center' }}>
                        <button
                          onClick={() => openTopup(u)}
                          className="mecha-row-btn"
                          style={{ borderColor: 'var(--m-accent)', color: 'var(--m-accent)' }}
                        >
                          💰 充值
                        </button>
                        <button
                          onClick={() => handleToggleBan(u)}
                          className="mecha-row-btn"
                          style={{
                            color: u.status === 'BANNED' ? 'var(--m-ok)' : 'var(--m-danger)',
                            borderColor: u.status === 'BANNED' ? 'var(--m-ok)' : 'var(--m-danger)',
                          }}
                        >
                          {u.status === 'BANNED' ? '🔓 解封' : '🔒 封号'}
                        </button>
                        {/* S1+: 拉黑/解黑按钮 — BANNED 状态下置灰(封号已经更严,不允许降级到 BLACKLIST) */}
                        <button
                          onClick={() => handleToggleBlacklist(u)}
                          disabled={u.status === 'BANNED'}
                          className="mecha-row-btn"
                          style={{
                            color: u.status === 'BLACKLIST' ? 'var(--m-ok)' : 'var(--m-warn)',
                            borderColor: u.status === 'BLACKLIST' ? 'var(--m-ok)' : 'var(--m-warn)',
                            opacity: u.status === 'BANNED' ? 0.3 : 1,
                            cursor: u.status === 'BANNED' ? 'not-allowed' : 'pointer',
                          }}
                          title={u.status === 'BANNED' ? '封号优先级更高,无需再拉黑' : ''}
                        >
                          {u.status === 'BLACKLIST' ? '✅ 解黑' : '⛔ 拉黑'}
                        </button>
                        <button
                          onClick={() => handleDeleteUser(u)}
                          className="mecha-row-btn"
                          style={{ borderColor: 'var(--m-danger)', color: 'var(--m-danger)' }}
                        >
                          🗑 删除
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 分页 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '16px' }}>
            <p style={{ fontSize: '13px', color: 'var(--m-text-mute)' }}>
              共 {total} 位主人，第 {page} / {totalPages} 页
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

      {/* 亲手登记会员弹窗 (F.1a) */}
      {registerOpen && (
        <>
          <div className="mecha-modal-mask" onClick={closeRegister} />
          <div className="mecha-modal">
            <div className="mecha-modal-head">
              <h2 className="mecha-modal-title">🐾 亲手登记新会员</h2>
              <button onClick={closeRegister} className="mecha-modal-close">×</button>
            </div>

            <form onSubmit={handleRegisterSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label className="mecha-label">邮箱 *</label>
                <input
                  type="email"
                  required
                  autoFocus
                  placeholder="friend@example.com"
                  className="mecha-input"
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                />
              </div>

              <div>
                <label className="mecha-label">初始密码 *</label>
                <input
                  type="text"
                  required
                  placeholder="至少4位,告诉朋友后让TA自己改"
                  className="mecha-input"
                  value={regPassword}
                  onChange={(e) => setRegPassword(e.target.value)}
                />
                <p style={{ fontSize: '11px', marginTop: '4px', color: 'var(--m-text-faint)' }}>
                  明文显示方便店长复制发给朋友喵
                </p>
              </div>

              <div>
                <label className="mecha-label">备注（可选,只有店长能看到）</label>
                <input
                  type="text"
                  placeholder="如：高中同学小鱼"
                  className="mecha-input"
                  value={regRemark}
                  onChange={(e) => setRegRemark(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', gap: '12px', paddingTop: '4px' }}>
                <button
                  type="button"
                  onClick={closeRegister}
                  className="mecha-btn-ghost"
                  style={{ flex: 1, height: '40px' }}
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={regSubmitting}
                  className="mecha-btn"
                  style={{ flex: 1, letterSpacing: 'normal' }}
                >
                  {regSubmitting ? '登记中...' : '登记入册 🐾'}
                </button>
              </div>
            </form>

            <p style={{ fontSize: '11px', marginTop: '16px', paddingTop: '12px', borderTop: '1px solid var(--m-border)', color: 'var(--m-text-faint)' }}>
              💡 登记成功后余额为 0,用列表里的「💰 充值」按钮投喂开户咖啡豆喵
            </p>
          </div>
        </>
      )}

      {/* 手动充值弹窗 */}
      {topupOpen && topupUser && (
        <>
          <div className="mecha-modal-mask" onClick={closeTopup} />
          <div className="mecha-modal">
            <div className="mecha-modal-head">
              <h2 className="mecha-modal-title">💰 手动充值/扣除</h2>
              <button onClick={closeTopup} className="mecha-modal-close">×</button>
            </div>

            <p style={{ fontSize: '13px', marginBottom: '16px', color: 'var(--m-text-sub)' }}>
              用户：<span style={{ fontWeight: 500, color: 'var(--m-text)' }}>{topupUser.email}</span><br />
              当前余额：<span style={{ fontFamily: 'monospace' }}>{topupUser.balance.toFixed(4)}</span> 咖啡豆
            </p>

            <form onSubmit={handleTopupSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label className="mecha-label">金额（咖啡豆）*</label>
                <input
                  type="number"
                  step="0.0001"
                  required
                  autoFocus
                  placeholder="正数充值，负数扣除"
                  className="mecha-input"
                  value={topupAmount}
                  onChange={(e) => setTopupAmount(e.target.value)}
                />
                <p style={{ fontSize: '11px', marginTop: '4px', color: 'var(--m-text-faint)' }}>
                  正数表示充值，负数表示扣除
                </p>
              </div>

              <div>
                <label className="mecha-label">备注（可选）</label>
                <input
                  type="text"
                  placeholder="如：客服补偿、误扣退还"
                  className="mecha-input"
                  value={topupNote}
                  onChange={(e) => setTopupNote(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', gap: '12px', paddingTop: '4px' }}>
                <button
                  type="button"
                  onClick={closeTopup}
                  className="mecha-btn-ghost"
                  style={{ flex: 1, height: '40px' }}
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={topupSubmitting}
                  className="mecha-btn"
                  style={{ flex: 1, letterSpacing: 'normal' }}
                >
                  {topupSubmitting ? '处理中...' : '确认提交 🐾'}
                </button>
              </div>
            </form>
          </div>
        </>
      )}

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}