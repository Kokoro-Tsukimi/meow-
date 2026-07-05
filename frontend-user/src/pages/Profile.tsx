import React, { useEffect, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { apiClient } from '../api/client';

// 客人餐桌(H-1):个人信息中心
// 三张卡:
//   ① 身份名片(邮箱 / 余额 / 加入日期 / 入店方式)
//   ② 重置秘密咒语(改密 + 跳忘记密码)
//   ③ 告别猫咖(注销账号,从 Dashboard 迁移过来)

interface ProfileData {
  email: string;
  balance: number;
  created_at: string;
  register_source: 'EMAIL' | 'CDK' | 'ADMIN';
}

// 入店方式徽章定义
const REGISTER_SOURCE_INFO: Record<string, { icon: string; label: string }> = {
  EMAIL: { icon: '📮', label: '邮箱验证注册' },
  CDK:   { icon: '🎟️', label: '邀请码注册' },
  ADMIN: { icon: '🐾', label: '店长亲手接待' },
};

export default function Profile() {
  const navigate = useNavigate();

  // 客人餐桌数据
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loading, setLoading] = useState(true);

  // 改密 state
  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [confirmPwd, setConfirmPwd] = useState('');
  const [pwdError, setPwdError] = useState('');
  const [pwdSuccessToast, setPwdSuccessToast] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // F.1.7 注销账号 state(完整从 Dashboard 搬来)
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deleteSuccess, setDeleteSuccess] = useState(false);

  useEffect(() => {
    fetchProfile();
  }, []);

  const fetchProfile = async () => {
    try {
      console.info('[USER-PORTAL][Profile][Fetch] 拉取客人餐桌信息');
      const res = await apiClient.get('/api/v1/user/profile');
      setProfile(res.data);
    } catch (e) {
      console.error('[USER-PORTAL][Profile] fetch error:', e);
    } finally {
      setLoading(false);
    }
  };

  // 格式化加入日期(yyyy/m/d hh:mm)
  const formatDate = (iso: string) => {
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  // 改密提交
  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPwdError('');

    if (!oldPwd || !newPwd) {
      setPwdError('请填写原密码和新密码喵');
      return;
    }
    if (newPwd.length < 4) {
      setPwdError('新密码至少 4 位喵');
      return;
    }
    if (newPwd !== confirmPwd) {
      setPwdError('两次输入的新密码不一样喵');
      return;
    }
    if (newPwd === oldPwd) {
      setPwdError('新密码不能和原密码一样喵~');
      return;
    }

    setSubmitting(true);
    try {
      console.info('[USER-PORTAL][Profile][Action] 改密');
      const res = await apiClient.post('/api/v1/user/change-password', {
        old_password: oldPwd,
        new_password: newPwd,
      });
      // 清空表单 + 弹绿色 toast
      setOldPwd('');
      setNewPwd('');
      setConfirmPwd('');
      setPwdSuccessToast(res.data?.message || '密码已更新喵~ 下次记得用新的进店~');
      setTimeout(() => setPwdSuccessToast(''), 4000);
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 403) {
        setPwdError('原密码错误喵,再试一次?');
      } else {
        setPwdError(err?.response?.data?.message || '改密失败,请稍后再试喵');
      }
    } finally {
      setSubmitting(false);
    }
  };

  // F.1.7 打开/关闭注销模态框
  const openDeleteModal = () => {
    setDeletePassword('');
    setDeleteError('');
    setShowDeleteModal(true);
  };

  const closeDeleteModal = () => {
    if (deleting) return; // 注销进行中不让关
    setShowDeleteModal(false);
  };

  // F.1.7 执行注销
  const handleDeleteAccount = async () => {
    if (!deletePassword) {
      setDeleteError('请输入密码确认喵');
      return;
    }
    setDeleting(true);
    setDeleteError('');
    try {
      console.info('[USER-PORTAL][Profile][Action] 注销账号');
      // 密码放 data 里(axios delete 的 body 要写在 config.data)
      await apiClient.delete('/api/v1/user/account', { data: { password: deletePassword } });
      // 成功:显示绿色提示条 5 秒,然后清 token 跳登录页
      setShowDeleteModal(false);
      setDeleteSuccess(true);
      setTimeout(() => {
        localStorage.removeItem('token');
        navigate('/login');
      }, 5000);
    } catch (err: any) {
      // 后端密码错回 403(不是 401, 所以 client.ts 拦截器不会把人踢出登录)
      const status = err?.response?.status;
      if (status === 403) {
        setDeleteError('密码错误喵,再试一次?');
      } else {
        setDeleteError(err?.response?.data?.message || '注销失败,请稍后再试喵');
      }
      setDeleting(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen font-harmony flex items-center justify-center">
        <div className="meow-text-sub">客人餐桌准备中...</div>
      </div>
    );
  }
  if (!profile) {
    return (
      <div className="min-h-screen font-harmony flex items-center justify-center">
        <div className="meow-text-sub">客人信息读取失败喵,请刷新重试 🐾</div>
      </div>
    );
  }

  const srcInfo = REGISTER_SOURCE_INFO[profile.register_source] || REGISTER_SOURCE_INFO.EMAIL;

  return (
    <div className="min-h-screen font-harmony">
      <main className="max-w-4xl mx-auto p-8 space-y-8">

        {/* 页眉 */}
        <div>
          <h1 className="text-3xl font-black meow-h mb-2">🪑 客人餐桌</h1>
          <p className="meow-text-sub">您的会员信息、密码管理与告别入口</p>
        </div>

        {/* ① 身份名片卡 */}
        <div className="meow-card p-8">
          <div className="flex items-start gap-6 flex-wrap">
            <div className="text-6xl flex-shrink-0">🐾</div>
            <div className="flex-1 min-w-[200px]">
              <div>
                <div className="text-xs meow-text-sub mb-1">📧 邮箱</div>
                <div className="text-xl font-bold meow-text break-all">{profile.email}</div>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-6 mt-6">
                <div>
                  <div className="text-xs meow-text-sub mb-1">☕ 余额</div>
                  <div className="text-lg font-bold meow-accent">
                    {profile.balance} <span className="text-sm">咖啡豆</span>
                  </div>
                </div>
                <div>
                  <div className="text-xs meow-text-sub mb-1">📅 加入日期</div>
                  <div className="text-sm meow-text">{formatDate(profile.created_at)}</div>
                </div>
                <div>
                  <div className="text-xs meow-text-sub mb-1">🌷 入店方式</div>
                  <div className="text-sm meow-text">
                    <span className="mr-1">{srcInfo.icon}</span>{srcInfo.label}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* ② 重置秘密咒语卡 */}
        <div className="meow-card p-8">
          <div className="flex items-baseline justify-between mb-6 flex-wrap gap-2">
            <h2 className="text-xl meow-h">🔑 重置秘密咒语</h2>
            <Link
              to="/forgot-password"
              className="text-sm meow-text-sub hover:underline underline-offset-4"
            >
              忘记原密码? →
            </Link>
          </div>
          <form onSubmit={handleChangePassword} className="space-y-4 max-w-md">
            <div>
              <label className="block text-sm meow-text-sub mb-2">原密码</label>
              <input
                type="password"
                placeholder="输入原密码"
                className="w-full px-4 py-3 theme-input outline-none"
                value={oldPwd}
                onChange={(e) => setOldPwd(e.target.value)}
                autoComplete="current-password"
              />
            </div>
            <div>
              <label className="block text-sm meow-text-sub mb-2">新密码(至少 4 位)</label>
              <input
                type="password"
                placeholder="输入新密码"
                className="w-full px-4 py-3 theme-input outline-none"
                value={newPwd}
                onChange={(e) => setNewPwd(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            <div>
              <label className="block text-sm meow-text-sub mb-2">确认新密码</label>
              <input
                type="password"
                placeholder="再输一次新密码"
                className="w-full px-4 py-3 theme-input outline-none"
                value={confirmPwd}
                onChange={(e) => setConfirmPwd(e.target.value)}
                autoComplete="new-password"
              />
            </div>
            {pwdError && (
              <p className="meow-danger-text text-sm" style={{ opacity: 1 }}>{pwdError}</p>
            )}
            <button
              type="submit"
              disabled={submitting}
              className="meow-btn-primary px-6 py-3"
            >
              {submitting ? '换暗号中...' : '更新密码 🔐'}
            </button>
          </form>
        </div>

        {/* ③ 告别猫咖(从 Dashboard 搬来) */}
        <div className="meow-danger-zone p-6">
          <h3 className="text-lg meow-danger-title mb-1">⚠️ 告别猫咖</h3>
          <p className="text-sm meow-danger-text mb-4">
            注销后账号、召唤铃和余额都会消失,且无法恢复喵。账单流水会作为历史留存。
          </p>
          <button
            onClick={openDeleteModal}
            className="meow-btn-danger px-6 py-3"
          >
            注销我的账号
          </button>
        </div>
      </main>

      {/* F.1.7 注销密码确认模态框(从 Dashboard 完整搬来) */}
      {showDeleteModal && (
        <>
          <div className="meow-modal-mask" onClick={closeDeleteModal} />
          <div className="meow-modal">
            <h2 className="text-2xl meow-h mb-2">确认注销账号</h2>
            <p className="meow-text-sub text-sm mb-6">
              请输入密码确认。注销后这只小猫就要离开书店啦,无法回头喵~
            </p>
            <input
              type="password"
              autoFocus
              placeholder="输入当前密码"
              className="w-full px-4 py-3 theme-input mb-2 outline-none"
              value={deletePassword}
              onChange={(e) => setDeletePassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleDeleteAccount(); }}
            />
            {deleteError && (
              <p className="meow-danger-text text-sm mb-2" style={{ opacity: 1 }}>{deleteError}</p>
            )}
            <div className="flex gap-3 mt-4">
              <button
                onClick={closeDeleteModal}
                disabled={deleting}
                className="flex-1 meow-btn-ghost px-4 py-3"
              >
                再想想
              </button>
              <button
                onClick={handleDeleteAccount}
                disabled={deleting}
                className="flex-1 meow-btn-danger-solid px-4 py-3"
              >
                {deleting ? '注销中...' : '确认注销'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* 改密成功 toast(4 秒自动消失) */}
      {pwdSuccessToast && (
        <div
          className="meow-toast meow-toast-success fixed top-8 left-1/2 z-50 px-8 py-4"
          style={{ transform: 'translateX(-50%)' }}
        >
          {pwdSuccessToast}
        </div>
      )}

      {/* F.1.7 注销成功提示条(5 秒后跳登录页) */}
      {deleteSuccess && (
        <div
          className="meow-toast meow-toast-success fixed top-8 left-1/2 z-50 px-8 py-4"
          style={{ transform: 'translateX(-50%)' }}
        >
          账号已注销,咖啡豆随风而去了喵~ 即将返回登录页 🐾
        </div>
      )}
    </div>
  );
}
