import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../api/client';
import { useConfirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

interface TokenItem {
  id: number;
  name: string;
  token_mask: string;
  quota: number;
  used_quota: number;
  status: 'ENABLE' | 'DISABLE';
  ip_whitelist: string;
  created_at: string;
}

// F.5 诊断模式 status 接口返回结构(对应 GET /api/v1/user/debug-mode/status)
interface DebugShelfUsage {
  itemCount: number;
  usedBytes: number;
  usedMB: number;   // 后端精度仅到 0.01 MB(技术债 34),前端用 usedBytes 自己格式化更准
  maxMB: number;
}
interface DebugStatus {
  enabled: boolean;
  ttl_minutes: number | null;
  expires_at: string | null;
  admin_enabled: boolean;   // admin 总闸,false 时 user 不能开启(后端返 403)
  shelf_usage: DebugShelfUsage;
}

// F.5 货架占用格式化:< 1KB 显示字节, < 1MB 显示 KB, >= 1MB 显示 MB
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} 字节`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

// F.5 剩余时间格式化:精确到秒
//   >= 1 小时: X 小时 X 分 X 秒
//   >= 1 分钟: X 分 X 秒
//   < 1 分钟: X 秒
//   <= 0: 已过期
function formatRemaining(expiresAtIso: string | null, nowMs: number): string {
  if (!expiresAtIso) return '';
  const remaining = new Date(expiresAtIso).getTime() - nowMs;
  if (remaining <= 0) return '已过期';
  const totalSeconds = Math.floor(remaining / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h} 小时 ${m} 分 ${s} 秒`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

export default function Tokens() {
  const [tokens, setTokens] = useState<TokenItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const navigate = useNavigate();
  const { confirm, ConfirmDialog } = useConfirm();
  const { showToast, ToastHost } = useToast();

  // 创建表单弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createQuota, setCreateQuota] = useState('');
  const [createIpWhitelist, setCreateIpWhitelist] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // 一次性显示新Token明文的弹窗
  const [newTokenDisplay, setNewTokenDisplay] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // F.5 诊断模式状态
  const [debugStatus, setDebugStatus] = useState<DebugStatus | null>(null);
  const [debugSubmitting, setDebugSubmitting] = useState(false);
  const [showTtlPicker, setShowTtlPicker] = useState(false);
  // 1 秒一跳的时间戳,只用来驱动剩余时间倒计时(不重拉接口)
  const [nowTick, setNowTick] = useState(() => Date.now());

  const fetchTokens = async () => {
    setLoading(true);
    try {
      console.info('[USER-PORTAL][Token页][请求] 获取Token列表');
      const res = await apiClient.get('/api/v1/user/tokens');
      setTokens(res.data.items || []);
      setErrorMsg('');
    } catch (err: any) {
      const msg = err.response?.data?.message || '加载失败';
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  };

  // F.5 诊断模式数据加载
  const fetchDebugStatus = async () => {
    try {
      console.info('[USER-PORTAL][诊断模式][请求] 获取状态');
      const res = await apiClient.get('/api/v1/user/debug-mode/status');
      setDebugStatus(res.data);
    } catch (err: any) {
      console.error('[USER-PORTAL][诊断模式][失败]', err.response?.data?.message || err.message);
    }
  };

  const handleOpenDebugMode = async (ttlMinutes: number) => {
    setDebugSubmitting(true);
    try {
      console.info(`[USER-PORTAL][诊断模式][开启] ttl=${ttlMinutes}`);
      await apiClient.patch('/api/v1/user/debug-mode', {
        enabled: true,
        ttl_minutes: ttlMinutes,
      });
      setShowTtlPicker(false);
      await fetchDebugStatus();
    } catch (err: any) {
      const msg = err.response?.data?.message || '开启失败';
      showToast(msg, 'error');
    } finally {
      setDebugSubmitting(false);
    }
  };

  const handleCloseDebugMode = async () => {
    setDebugSubmitting(true);
    try {
      console.info('[USER-PORTAL][诊断模式][关闭]');
      await apiClient.patch('/api/v1/user/debug-mode', { enabled: false });
      await fetchDebugStatus();
    } catch (err: any) {
      const msg = err.response?.data?.message || '关闭失败';
      showToast(msg, 'error');
    } finally {
      setDebugSubmitting(false);
    }
  };

  useEffect(() => {
    fetchTokens();
    fetchDebugStatus();
  }, []);

  // F.5 polling 频率切换:enabled 时 30s(快速更新进度/倒计时);disabled 时 60s 兜底同步 admin 配置
  //   兜底场景:admin 在「📜 店规」改了总闸/maxMB 后,user 端 UI 无需刷新即可在 60s 内同步
  useEffect(() => {
    const intervalMs = debugStatus?.enabled ? 30000 : 60000;
    const timer = setInterval(fetchDebugStatus, intervalMs);
    return () => clearInterval(timer);
  }, [debugStatus?.enabled]);

  // F.5 visibility 触发:切回 tab 时立即 refetch(组合 polling 兜底,体感最佳)
  //   场景:admin 改完总闸 → 切回 user 端 tab → 立即看到 ⚠️ 提示,而不必等 60s polling
  useEffect(() => {
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        fetchDebugStatus();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, []);

  // F.5 开启状态下,每 1 秒推进 nowTick(只驱动剩余时间显示,不发请求)
  useEffect(() => {
    if (!debugStatus?.enabled) return;
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [debugStatus?.enabled]);

  const openCreate = () => {
    setCreateName('');
    setCreateQuota('');
    setCreateIpWhitelist('');
    setCreateOpen(true);
  };

  const closeCreate = () => {
    setCreateOpen(false);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createName.trim()) {
      showToast('请填写召唤铃名称喵', 'error');
      return;
    }

    setSubmitting(true);
    try {
      const ipList = createIpWhitelist
        .split(/[\n,]/)
        .map((ip) => ip.trim())
        .filter((ip) => ip.length > 0);

      const payload = {
        name: createName.trim(),
        quota: createQuota ? parseFloat(createQuota) : -1,
        ip_whitelist: ipList,
      };

      const res = await apiClient.post('/api/v1/user/tokens', payload);
      const fullToken = res.data.token;
      setCreateOpen(false);
      setNewTokenDisplay(fullToken);
      await fetchTokens();
    } catch (err: any) {
      const msg = err.response?.data?.message || '创建失败';
      showToast(`创建失败：${msg}`, 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCopyNewToken = async () => {
    if (!newTokenDisplay) return;
    try {
      await navigator.clipboard.writeText(newTokenDisplay);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast('复制失败，请手动选中复制喵', 'error');
    }
  };

  const handleToggleStatus = async (token: TokenItem) => {
    const newStatus = token.status === 'ENABLE' ? 'DISABLE' : 'ENABLE';
    try {
      await apiClient.put(`/api/v1/user/tokens/${token.id}`, { status: newStatus });
      await fetchTokens();
    } catch (err: any) {
      showToast(`操作失败：${err.response?.data?.message || '未知错误'}`, 'error');
    }
  };

  const handleDelete = async (token: TokenItem) => {
    const ok = await confirm({
      title: '🔔 销毁确认',
      message: `确定销毁召唤铃「${token.name}」吗喵？\n销毁后无法恢复！`,
      confirmText: '销毁',
      cancelText: '手滑了',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/api/v1/user/tokens/${token.id}`);
      await fetchTokens();
      showToast(`召唤铃「${token.name}」已销毁喵~`, 'success');
    } catch (err: any) {
      showToast(`删除失败：${err.response?.data?.message || '未知错误'}`, 'error');
    }
  };

  return (
    <div className="min-h-screen font-harmony">
      <main className="max-w-6xl mx-auto p-8">
        <div className="flex items-center justify-between mb-6 flex-wrap gap-4">
          <div>
            <h1 className="text-3xl font-black meow-h">🔔 女仆召唤铃</h1>
            <p className="mt-2 meow-text-sub">
              管理调用 API 的秘钥，每个铃铛可以独立设置额度和 IP 白名单喵
            </p>
          </div>
          <button
            onClick={openCreate}
            className="meow-btn-primary px-6 py-3"
          >
            🐾 打造新铃铛
          </button>
        </div>

        {/* F.5 诊断模式卡片(开启后,后续请求的响应原文会临时保留在中转站货架上) */}
        {debugStatus && (
          <div className="meow-card p-6 mb-6">
            <div className="flex items-start justify-between mb-4">
              <div className="flex-1">
                <h2 className="text-xl font-bold meow-h flex items-center gap-2">
                  🔍 诊断模式
                  <span
                    className="px-2 py-0.5 text-xs rounded-full font-medium"
                    style={{
                      backgroundColor: debugStatus.enabled ? '#D1FAE5' : '#F3F4F6',
                      color: debugStatus.enabled ? '#065F46' : '#6B7280',
                    }}
                  >
                    {debugStatus.enabled ? '✅ 开启中' : '⭕ 未开启'}
                  </span>
                </h2>
                <p className="text-sm meow-text-sub mt-2 leading-relaxed">
                  开启后,在缓存时长内 API 调用的响应原文会临时保留在中转站货架上,
                  方便排查"模型没好好回话"的小问题。到期或关闭后会自动清理喵~
                </p>
              </div>
            </div>

            {/* 开启状态 ============================================ */}
            {debugStatus.enabled && (
              <div className="space-y-4">
                {/* 货架占用 */}
                <div>
                  <div className="flex items-center justify-between text-sm meow-text mb-1.5">
                    <span className="meow-text-sub">📦 货架占用</span>
                    <span className="font-medium">
                      {formatBytes(debugStatus.shelf_usage.usedBytes)} / {debugStatus.shelf_usage.maxMB} MB
                      <span className="meow-text-sub ml-2">
                        ({debugStatus.shelf_usage.itemCount} 件)
                      </span>
                    </span>
                  </div>
                  <div className="w-full h-3 meow-progress-track rounded-full overflow-hidden">
                    {(() => {
                      const maxBytes = debugStatus.shelf_usage.maxMB * 1024 * 1024;
                      const pct = maxBytes > 0
                        ? Math.min(100, (debugStatus.shelf_usage.usedBytes / maxBytes) * 100)
                        : 0;
                      let barColor = '#10B981';   // 绿
                      if (pct >= 80) barColor = '#EF4444';      // 红
                      else if (pct >= 50) barColor = '#F59E0B'; // 黄
                      return (
                        <div
                          className="h-full transition-all duration-500"
                          style={{ width: `${pct}%`, backgroundColor: barColor }}
                        />
                      );
                    })()}
                  </div>
                  <p className="text-xs meow-text-sub mt-1">
                    超过上限时,最旧的条目会被自动淘汰,不影响新请求记录
                  </p>
                </div>

                {/* 剩余时间 + 关闭按钮 */}
                <div className="flex items-center justify-between">
                  <div className="text-sm meow-text">
                    <span className="meow-text-sub">⏰ 剩余时间:</span>
                    <span className="ml-2 font-medium meow-accent">
                      {formatRemaining(debugStatus.expires_at, nowTick)}
                    </span>
                  </div>
                  <button
                    onClick={handleCloseDebugMode}
                    disabled={debugSubmitting}
                    className="meow-btn-ghost px-4 py-2 text-sm"
                  >
                    {debugSubmitting ? '处理中...' : '关闭诊断模式'}
                  </button>
                </div>
              </div>
            )}

            {/* 关闭状态 ============================================ */}
            {!debugStatus.enabled && (
              <div className="space-y-3">
                {/* admin 总闸 OFF 提示 */}
                {!debugStatus.admin_enabled && (
                  <div className="meow-price-box rounded-2xl p-3 text-sm meow-text border-l-4 border-amber-400">
                    ⚠️ 管理员暂时关闭了诊断功能,现在无法开启喵~
                  </div>
                )}

                {/* TTL 四档选择 */}
                {!showTtlPicker ? (
                  <div className="flex items-center justify-between">
                    <p className="text-sm meow-text-sub">
                      货架上限:{debugStatus.shelf_usage.maxMB} MB(由管理员设置)
                    </p>
                    <button
                      onClick={() => setShowTtlPicker(true)}
                      disabled={!debugStatus.admin_enabled}
                      className="meow-btn-primary px-4 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      🔍 开启诊断模式
                    </button>
                  </div>
                ) : (
                  <div>
                    <p className="text-sm meow-text mb-2">选择缓存时长喵~</p>
                    <div className="flex flex-wrap gap-2">
                      {[10, 30, 60, 120].map((m) => (
                        <button
                          key={m}
                          onClick={() => handleOpenDebugMode(m)}
                          disabled={debugSubmitting}
                          className="meow-btn-ghost px-4 py-2 text-sm disabled:opacity-50"
                        >
                          {m} 分钟
                        </button>
                      ))}
                      <button
                        onClick={() => setShowTtlPicker(false)}
                        disabled={debugSubmitting}
                        className="px-4 py-2 text-sm meow-text-sub hover:opacity-100 transition-opacity disabled:opacity-30"
                      >
                        取消
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {loading && <p className="meow-text">正在加载召唤铃...</p>}
        {errorMsg && <p className="meow-danger-text" style={{ opacity: 1 }}>加载失败：{errorMsg}</p>}

        {!loading && !errorMsg && tokens.length === 0 && (
          <div className="meow-card p-12 text-center">
            <div className="text-6xl mb-4">🔔</div>
            <p className="meow-text-sub mb-2">还没有任何召唤铃喵~</p>
            <p className="meow-text-sub text-sm" style={{ opacity: 0.6 }}>
              点击"打造新铃铛"创建第一个 API 秘钥吧
            </p>
          </div>
        )}

        {!loading && tokens.length > 0 && (
          <div className="grid grid-cols-1 gap-4">
            {tokens.map((t) => (
              <div
                key={t.id}
                className="meow-card hoverable p-5"
                style={{ borderLeft: `4px solid ${t.status === 'ENABLE' ? '#10B981' : '#9ca3af'}` }}
              >
                <div className="flex items-start justify-between flex-wrap gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-3 mb-2">
                      <h3 className="text-lg font-bold meow-h">🔔 {t.name}</h3>
                      <span
                        className="px-2 py-0.5 text-xs rounded-full font-medium"
                        style={{
                          backgroundColor: t.status === 'ENABLE' ? '#D1FAE5' : '#FEE2E2',
                          color: t.status === 'ENABLE' ? '#065F46' : '#991B1B',
                        }}
                      >
                        {t.status === 'ENABLE' ? '可用' : '已禁用'}
                      </span>
                    </div>
                    <p className="font-mono text-sm meow-text mb-2">
                      {t.token_mask}
                    </p>
                    <div className="flex gap-4 text-xs meow-text-sub flex-wrap">
                      <span>
                        额度: {t.quota === -1 ? '∞ 无限' : `${t.quota.toFixed(2)} 咖啡豆`}
                      </span>
                      <span>已用: {t.used_quota.toFixed(4)}</span>
                      <span>ID: {t.id}</span>
                      <span>创建: {new Date(t.created_at).toLocaleDateString('zh-CN')}</span>
                    </div>
                  </div>
                  <div className="flex gap-2 ml-4">
                    <button
                      onClick={() => handleToggleStatus(t)}
                      className="px-3 py-1 text-sm border-2 rounded-lg transition-colors"
                      style={{
                        color: t.status === 'ENABLE' ? '#B45309' : '#065F46',
                        borderColor: t.status === 'ENABLE' ? '#B45309' : '#065F46',
                      }}
                    >
                      {t.status === 'ENABLE' ? '禁用' : '启用'}
                    </button>
                    <button
                      onClick={() => handleDelete(t)}
                      className="meow-btn-danger px-3 py-1 text-sm rounded-lg"
                      style={{ borderWidth: '2px' }}
                    >
                      销毁
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {/* 创建Token弹窗 */}
      {createOpen && (
        <>
          <div className="meow-modal-mask" onClick={closeCreate} />
          <div className="meow-modal" style={{ maxWidth: '480px' }}>
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-2xl font-bold meow-h">🐾 打造新召唤铃</h2>
              <button onClick={closeCreate} className="meow-text-sub hover:opacity-100 text-2xl">×</button>
            </div>

            <form onSubmit={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium meow-text mb-1">召唤铃名称 *</label>
                <input
                  type="text"
                  required
                  autoFocus
                  placeholder="如：网站后端专用"
                  className="w-full px-4 py-2 theme-input outline-none"
                  value={createName}
                  onChange={(e) => setCreateName(e.target.value)}
                />
              </div>

              <div>
                <label className="block text-sm font-medium meow-text mb-1">独立额度（咖啡豆）</label>
                <input
                  type="number"
                  step="0.0001"
                  min="0"
                  placeholder="留空表示不限制（共享账户总余额）"
                  className="w-full px-4 py-2 theme-input outline-none"
                  value={createQuota}
                  onChange={(e) => setCreateQuota(e.target.value)}
                />
                <p className="text-xs mt-1 meow-text-sub">
                  设置后，此铃铛单独消耗的额度不会超过这个值
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium meow-text mb-1">IP 白名单（可选）</label>
                <textarea
                  rows={3}
                  placeholder="一行一个，或用逗号分隔。留空则不限制IP"
                  className="w-full px-4 py-2 theme-input outline-none font-mono text-sm"
                  value={createIpWhitelist}
                  onChange={(e) => setCreateIpWhitelist(e.target.value)}
                />
                <p className="text-xs mt-1 meow-text-sub">
                  示例：192.168.1.100 或 留空
                </p>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeCreate}
                  className="flex-1 meow-btn-ghost px-4 py-3"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="flex-1 meow-btn-primary px-4 py-3"
                >
                  {submitting ? '打造中...' : '🐾 立刻打造'}
                </button>
              </div>
            </form>
          </div>
        </>
      )}

      {/* 一次性显示新Token的弹窗 */}
      {newTokenDisplay && (
        <>
          <div className="meow-modal-mask" style={{ background: 'rgba(0,0,0,0.5)' }} />
          <div className="meow-modal" style={{ maxWidth: '560px' }}>
            <div className="text-center mb-6">
              <div className="text-5xl mb-3">🎁</div>
              <h2 className="text-2xl font-bold meow-h mb-2">召唤铃打造成功喵~</h2>
              <p className="meow-danger-text font-bold" style={{ opacity: 1 }}>
                ⚠️ 此 Token 只显示这一次，请立即保存到安全的地方！
              </p>
            </div>

            <div className="meow-code-block rounded-2xl p-4 mb-4">
              <p className="font-mono text-sm break-all select-all">
                {newTokenDisplay}
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={handleCopyNewToken}
                className="flex-1 meow-btn-primary px-4 py-3"
              >
                {copied ? '✅ 已复制!' : '📋 复制 Token'}
              </button>
              <button
                onClick={() => {
                  setNewTokenDisplay(null);
                  setCopied(false);
                }}
                className="flex-1 meow-btn-ghost px-4 py-3"
              >
                我已保存
              </button>
            </div>
          </div>
        </>
      )}
      {ConfirmDialog}
      {ToastHost}
    </div>
  );
}
