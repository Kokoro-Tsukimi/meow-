import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client';

export default function Topup() {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');
  const [fallingItems, setFallingItems] = useState<{ id: number; char: string; left: string; delay: string }[]>([]);
  const navigate = useNavigate();

  const handleTopup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code) return;

    setLoading(true);
    setError('');
    console.info(`[USER-PORTAL][Topup][Submit] Redeeming code: ${code}`);

    try {
      await apiClient.post('/api/v1/user/topup/redeem', { code });

      // Success state
      setSuccess(true);
      setCode('');

      // Trigger falling animation
      const items = Array.from({ length: 20 }).map((_, i) => ({
        id: Date.now() + i,
        char: Math.random() > 0.5 ? '🐾' : '☕',
        left: `${Math.random() * 100}%`,
        delay: `${Math.random() * 0.5}s`
      }));
      setFallingItems(items);

      setTimeout(() => {
        setSuccess(false);
        setFallingItems([]);
        navigate('/dashboard'); // Go back to dashboard to see updated balance
      }, 1500);

    } catch (err: any) {
      setError(err.response?.data?.message || '兑换失败，请检查兑换码');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 relative overflow-hidden font-harmony">

      {/* Falling Items Container */}
      {fallingItems.map(item => (
        <div
          key={item.id}
          className="absolute top-0 text-3xl animate-fall-down pointer-events-none z-50"
          style={{ left: item.left, animationDelay: item.delay }}
        >
          {item.char}
        </div>
      ))}

      <div className="meow-card p-10 w-full max-w-md text-center relative z-10">
        <div className="text-6xl mb-6">🎁</div>
        <h1 className="text-3xl font-black meow-h mb-8">投喂咖啡豆</h1>

        <form onSubmit={handleTopup} className="space-y-6">
          <div>
            <input
              type="text"
              placeholder="输入兑换码，给书店投喂能量~"
              className={`w-full px-5 py-4 theme-input text-center outline-none ${error ? 'meow-input-error' : ''}`}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                if (error) setError('');
              }}
              disabled={loading || success}
            />
            {error && <p className="meow-danger-text text-sm mt-2 text-left" style={{ opacity: 1 }}>{error}</p>}
          </div>

          <button
            type="submit"
            disabled={loading || success || !code}
            className={`w-full py-4 ${success ? 'meow-btn-success' : 'meow-btn-primary'}`}
          >
            {success ? '✅ 投喂成功！' : loading ? '投喂中...' : '投喂！'}
          </button>
        </form>
      </div>
    </div>
  );
}
