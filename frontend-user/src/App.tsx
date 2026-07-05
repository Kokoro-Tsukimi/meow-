import React, { useEffect } from 'react';
import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import Dashboard from './pages/Dashboard';
import Topup from './pages/Topup';
import Bills from './pages/Bills';
import Tokens from './pages/Tokens';
import Models from './pages/Models';
import Profile from './pages/Profile';
import Announcements from './pages/Announcements';
import Layout from './components/Layout';
import { globalEvents } from './api/client';

const AuthGuard = ({ children }: { children: React.ReactNode }) => {
  const token = localStorage.getItem('token');
  if (!token) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
};

const GlobalEventHandler = () => {
  const navigate = useNavigate();

  useEffect(() => {
    const handleBalanceEmpty = () => {
      console.info('[USER-PORTAL][Global] Balance empty event received, redirecting to topup');
      navigate('/topup');
    };

    globalEvents.addEventListener('balance:empty', handleBalanceEmpty);
    return () => {
      globalEvents.removeEventListener('balance:empty', handleBalanceEmpty);
    };
  }, [navigate]);

  return null;
};

export default function App() {
  return (
    <BrowserRouter>
      <GlobalEventHandler />
      <Routes>
        <Route path="/" element={<Navigate to="/dashboard" replace />} />

        {/* 公开页：不套侧栏，保持全屏 */}
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/forgot-password" element={<ForgotPassword />} />

        {/* 受保护页：套在 Layout 侧栏外壳里（嵌套路由 + Outlet） */}
        <Route
          element={
            <AuthGuard>
              <Layout />
            </AuthGuard>
          }
        >
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/topup" element={<Topup />} />
          <Route path="/bills" element={<Bills />} />
          <Route path="/tokens" element={<Tokens />} />
          <Route path="/models" element={<Models />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/announcements" element={<Announcements />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
