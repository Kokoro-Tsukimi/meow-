import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client';

interface ModelItem {
  id: number;
  name: string;
  description: string | null;
  access_mode: 'PUBLIC' | 'WHITELIST';
  prompt_price: number;     // 豆/百万 tokens, 后端已还原
  completion_price: number; // 豆/百万 tokens, 后端已还原
  created_at: string;
}

export default function Models() {
  const [models, setModels] = useState<ModelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    fetchModels();
  }, []);

  const fetchModels = async () => {
    setLoading(true);
    try {
      console.info('[USER-PORTAL][菜单页][请求] 获取可见菜单');
      const res = await apiClient.get('/api/v1/user/models');
      setModels(res.data.items || []);
      setErrorMsg('');
    } catch (err: any) {
      const msg = err.response?.data?.message || '菜单暂时拿不出来喵';
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  // 格式化价格 (豆/百万 tokens), 大数字四舍五入, 小数字保留两位
  const formatPrice = (price: number): string => {
    if (price === 0) return '免费喵~';
    if (price >= 100) return Math.round(price).toString();
    if (price >= 10) return price.toFixed(1);
    return price.toFixed(2);
  };

  // 描述兜底: null / 空字符串 / 全空白 都视为空
  const renderDescription = (desc: string | null): string => {
    if (!desc || desc.trim() === '') {
      return '店长还没写介绍喵, 不过用起来肯定美味~';
    }
    return desc;
  };

  // 访问模式 badge 文案 + 左边框强调色（颜色走主题 class）
  const accessInfo = (mode: 'PUBLIC' | 'WHITELIST') => {
    if (mode === 'WHITELIST') {
      return { text: '👑 专属', cls: 'meow-badge-whitelist' };
    }
    return { text: '🌸 公开', cls: 'meow-badge-public' };
  };

  return (
    <div className="min-h-screen font-harmony">
      <main className="max-w-6xl mx-auto p-8">
        <div className="mb-8">
          <h1 className="text-3xl font-black meow-h">📖 魔法菜单册</h1>
          <p className="mt-2 meow-text-sub">
            这里是为主人准备的菜单, 每张牌都是一道魔法喵~ 价格按「豆 / 百万 tokens」计算
          </p>
        </div>

        {loading && (
          <div className="meow-card p-12 text-center">
            <div className="text-4xl mb-4 animate-float">☕</div>
            <p className="meow-text-sub">正在烤热菜单喵...</p>
          </div>
        )}

        {!loading && errorMsg && (
          <div className="meow-card p-12 text-center">
            <div className="text-4xl mb-4">🙀</div>
            <p className="meow-danger-text mb-4" style={{ opacity: 1 }}>加载失败:{errorMsg}</p>
            <button
              onClick={fetchModels}
              className="meow-btn-ghost px-4 py-2"
            >
              重试一下喵
            </button>
          </div>
        )}

        {!loading && !errorMsg && models.length === 0 && (
          <div className="meow-card p-12 text-center">
            <div className="text-6xl mb-4">📭</div>
            <p className="meow-text-sub mb-2">目前还没有为你开放的菜单喵~</p>
            <p className="meow-text-sub text-sm" style={{ opacity: 0.6 }}>
              想要解锁更多魔法? 联系店长申请权限吧 ✨
            </p>
          </div>
        )}

        {!loading && !errorMsg && models.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {models.map((m) => {
              const info = accessInfo(m.access_mode);
              return (
                <div
                  key={m.id}
                  className={`meow-card hoverable p-6 flex flex-col meow-model-card ${info.cls}`}
                >
                  {/* 头部: 名字 + 访问模式 badge */}
                  <div className="flex items-start justify-between mb-3 gap-2">
                    <h3 className="text-xl font-bold meow-h break-all">
                      {m.name}
                    </h3>
                    <span className={`px-3 py-1 text-xs rounded-full font-medium whitespace-nowrap meow-badge ${info.cls}`}>
                      {info.text}
                    </span>
                  </div>

                  {/* 描述 (空时显示兜底文案) */}
                  <p className="meow-text-sub text-sm mb-5 flex-1">
                    {renderDescription(m.description)}
                  </p>

                  {/* 价格区: 输入 / 输出 */}
                  <div className="meow-price-box rounded-2xl p-4 space-y-2">
                    <div className="flex justify-between items-baseline">
                      <span className="meow-text-sub text-sm">输入</span>
                      <span className="meow-text font-bold">
                        ☕ {formatPrice(m.prompt_price)}
                        <span className="text-xs meow-text-sub ml-1">豆 / 百万</span>
                      </span>
                    </div>
                    <div className="flex justify-between items-baseline">
                      <span className="meow-text-sub text-sm">输出</span>
                      <span className="meow-text font-bold">
                        ☕ {formatPrice(m.completion_price)}
                        <span className="text-xs meow-text-sub ml-1">豆 / 百万</span>
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
