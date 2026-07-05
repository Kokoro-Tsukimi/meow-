import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import client from '../api/client';

const Login: React.FC = () => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const navigate = useNavigate();

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !password) {
      setErrorMsg('请填写邮箱和密码');
      return;
    }

    setLoading(true);
    setErrorMsg('');

    try {
      console.info('[ADMIN-PORTAL][登录页][提交] 尝试登录:', username);
      const res = await client.post('/api/v1/admin/auth/login', {
        email: username,
        password: password,
      });

      const { token, email } = res.data;
      localStorage.setItem('admin_token', token);
      localStorage.setItem('admin_email', email);

      console.info('[ADMIN-PORTAL][登录页][成功] 跳转仪表盘');
      navigate('/dashboard');
    } catch (err: any) {
      const msg = err.response?.data?.message || '登录失败，请检查网络';
      console.error('[ADMIN-PORTAL][登录页][失败]', msg);
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="mecha-login-bg">
      {/* 缓慢横向流动的数据流线 (护眼装饰) */}
      <div className="mecha-dataflow line-a" />
      <div className="mecha-dataflow line-b" />

      <div className="mecha-login-card">
        <div className="mecha-login-eyebrow">ADMIN PORTAL</div>
        <h2 className="mecha-login-title">超管后台登录</h2>

        <form onSubmit={handleLogin}>
          <div style={{ marginBottom: '16px' }}>
            <label className="mecha-label">邮箱</label>
            <input
              type="text"
              required
              className="mecha-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={loading}
            />
          </div>
          <div style={{ marginBottom: '20px' }}>
            <label className="mecha-label">密码</label>
            <input
              type="password"
              required
              className="mecha-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
            />
          </div>
          {errorMsg && (
            <div className="mecha-error" style={{ marginBottom: '20px' }}>
              {errorMsg}
            </div>
          )}
          <button type="submit" disabled={loading} className="mecha-btn">
            {loading ? '登 录 中...' : '登 录'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default Login;
