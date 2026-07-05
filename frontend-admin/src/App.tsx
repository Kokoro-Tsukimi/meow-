import React from 'react';
import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Channels from './pages/Channels';
import Users from './pages/Users';
import RedeemCodes from './pages/RedeemCodes';
import DryRun from './pages/DryRun';
import Rules from './pages/Rules';
import ModelGroups from './pages/ModelGroups';
import MailChannels from './pages/MailChannels';
import Settings from './pages/Settings';

// 鉴权守卫
const AuthGuard: React.FC = () => {
  const token = localStorage.getItem('admin_token');
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return <Outlet />;
};

// 包含侧边栏的主布局
const MainLayout: React.FC = () => {
  return (
    <div className="flex min-h-screen" style={{ background: 'var(--m-bg-0)' }}>
      <Sidebar />
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
};

const App: React.FC = () => {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        
        <Route element={<AuthGuard />}>
          <Route element={<MainLayout />}>
            <Route path="/" element={<Navigate to="/dashboard" replace />} />
            <Route path="/dashboard" element={<Dashboard />} />
            <Route path="/channels" element={<Channels />} />
            <Route path="/model-groups" element={<ModelGroups />} />
            <Route path="/users" element={<Users />} />
            <Route path="/redeem-codes" element={<RedeemCodes />} />
            <Route path="/dry-run" element={<DryRun />} />
            <Route path="/rules" element={<Rules />} />
            <Route path="/mail-channels" element={<MailChannels />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  );
};

export default App;
