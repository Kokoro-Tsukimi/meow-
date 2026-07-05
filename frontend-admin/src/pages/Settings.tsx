import React, { useEffect, useState } from 'react';
import client from '../api/client';
import { useConfirm } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';

// F.5 SystemSettings 表的一行,后端 GET /admin/settings 返回 items[] 结构
interface Setting {
  key: string;
  value: string;
  updated_at?: string;
}

export default function Settings() {
  const { confirm, ConfirmDialog } = useConfirm();
  const { toast, ToastContainer } = useToast();
  const [items, setItems] = useState<Setting[]>([]);
  const [loading, setLoading] = useState(true);
  const [errorMsg, setErrorMsg] = useState('');
  const [savingKey, setSavingKey] = useState<string>('');  // 正在保存的 key,用来 disable 对应按钮
  const [maxMbDraft, setMaxMbDraft] = useState<string>(''); // maxMB 编辑草稿(单独 state,允许用户输入未保存的值)
  const [globalRpmDraft, setGlobalRpmDraft] = useState<string>('');     // S1+: 全站 RPM 草稿
  const [blacklistRpmDraft, setBlacklistRpmDraft] = useState<string>(''); // S1+: 拉黑账号 RPM 草稿
  const [checkinRewardDraft, setCheckinRewardDraft] = useState<string>(''); // F6: 每日签到奖励豆数草稿

  const fetchSettings = async () => {
    setLoading(true);
    try {
      console.info('[ADMIN-PORTAL][店规][请求] 拉取系统配置');
      const res = await client.get('/api/v1/admin/settings');
      const list: Setting[] = res.data.items || [];
      setItems(list);
      // 把 maxMB 当前值同步进编辑草稿
      const maxMb = list.find((s) => s.key === 'debug_cache_per_user_max_mb');
      if (maxMb) setMaxMbDraft(maxMb.value);
      // S1+: 同步 RPM 草稿
      const globalRpm = list.find((s) => s.key === 'global_rpm_limit');
      if (globalRpm) setGlobalRpmDraft(globalRpm.value);
      const blacklistRpm = list.find((s) => s.key === 'blacklist_rpm_limit');
      if (blacklistRpm) setBlacklistRpmDraft(blacklistRpm.value);
      const checkinReward = list.find((s) => s.key === 'checkin_reward_amount');
      if (checkinReward) setCheckinRewardDraft(checkinReward.value);
      setErrorMsg('');
    } catch (err: any) {
      setErrorMsg(err.response?.data?.message || '加载失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const getValue = (key: string): string =>
    items.find((s) => s.key === key)?.value || '';

  // 通用 PATCH 单项配置, 成功后 refetch 同步进程内 cache
  const handlePatch = async (key: string, value: string): Promise<boolean> => {
    setSavingKey(key);
    try {
      console.info(`[ADMIN-PORTAL][店规][保存] ${key} = ${value}`);
      await client.patch('/api/v1/admin/settings', { key, value });
      await fetchSettings();
      return true;
    } catch (err: any) {
      toast.error(err.response?.data?.message || '保存失败');
      return false;
    } finally {
      setSavingKey('');
    }
  };

  const handleToggleDebug = async () => {
    const current = getValue('debug_cache_enabled');
    const next = current === 'true' ? 'false' : 'true';
    // 关闭总闸时二次确认(影响面大)
    if (current === 'true') {
      const ok = await confirm({
        message: '关闭总闸后, 所有用户都不能再开启诊断模式; 已开启的用户其后续请求也不再写入货架。继续吗喵?',
        danger: true,
      });
      if (!ok) return;
    }
    await handlePatch('debug_cache_enabled', next);
  };

  const handleSaveMaxMb = async () => {
    const n = parseInt(maxMbDraft, 10);
    if (!Number.isFinite(n) || n < 1 || n > 1024) {
      toast.error('每用户上限必须是 1-1024 之间的整数喵');
      return;
    }
    await handlePatch('debug_cache_per_user_max_mb', String(n));
  };

  // S1+(2026-06-23): 保存全站 RPM 上限
  const handleSaveGlobalRpm = async () => {
    const n = parseInt(globalRpmDraft, 10);
    if (!Number.isFinite(n) || n < 1 || n > 1000) {
      toast.error('全站 RPM 上限必须是 1-1000 之间的整数喵');
      return;
    }
    await handlePatch('global_rpm_limit', String(n));
  };

  // S1+(2026-06-23): 保存拉黑账号 RPM 上限
  const handleSaveBlacklistRpm = async () => {
    const n = parseInt(blacklistRpmDraft, 10);
    if (!Number.isFinite(n) || n < 1 || n > 1000) {
      toast.error('拉黑账号 RPM 上限必须是 1-1000 之间的整数喵');
      return;
    }
    await handlePatch('blacklist_rpm_limit', String(n));
  };

  // F6: 切换签到总开关(关闭时二次确认)
  const handleToggleCheckin = async () => {
    const current = getValue('checkin_enabled');
    const next = current === 'true' ? 'false' : 'true';
    if (current === 'true') {
      const ok = await confirm({
        message: '关闭后, 用户端签到卡片会整张隐藏, 大家都不能再签到领豆。继续吗喵?',
        danger: true,
      });
      if (!ok) return;
    }
    await handlePatch('checkin_enabled', next);
  };

  // F6: 保存每日签到奖励豆数(0-100000 整数)
  const handleSaveCheckinReward = async () => {
    const n = parseInt(checkinRewardDraft, 10);
    if (!Number.isFinite(n) || n < 0 || n > 100000) {
      toast.error('每日签到奖励必须是 0-100000 之间的整数喵');
      return;
    }
    await handlePatch('checkin_reward_amount', String(n));
  };

  const debugEnabled = getValue('debug_cache_enabled') === 'true';
  const currentMaxMb = getValue('debug_cache_per_user_max_mb');
  const maxMbDirty = maxMbDraft !== currentMaxMb && maxMbDraft !== '';
  // S1+: RPM 派生 state
  const currentGlobalRpm = getValue('global_rpm_limit');
  const currentBlacklistRpm = getValue('blacklist_rpm_limit');
  const globalRpmDirty = globalRpmDraft !== currentGlobalRpm && globalRpmDraft !== '';
  const blacklistRpmDirty = blacklistRpmDraft !== currentBlacklistRpm && blacklistRpmDraft !== '';
  // F6: 签到派生 state
  const checkinEnabled = getValue('checkin_enabled') === 'true';
  const currentCheckinReward = getValue('checkin_reward_amount');
  const checkinRewardDirty = checkinRewardDraft !== currentCheckinReward && checkinRewardDraft !== '';

  return (
    <div className="mecha-content">
      <div className="mb-6">
        <h1 className="text-3xl font-bold" style={{ color: 'var(--m-text)' }}>
          📜 店规
        </h1>
        <p className="mt-2" style={{ color: 'var(--m-text-sub)' }}>
          F.5 诊断模式总闸 + 每用户货架配额 + S1+ 限流配置(全局生效, 保存后实时同步到所有网关进程的内存 cache)
        </p>
      </div>

      {loading && (
        <p style={{ color: 'var(--m-text)' }}>加载中喵...</p>
      )}
      {errorMsg && (
        <div className="mecha-error">加载失败:{errorMsg}</div>
      )}

      {!loading && !errorMsg && (
        <div className="grid grid-cols-1 gap-4 max-w-2xl">
          {/* ===== 卡片 1:诊断模式总闸 ===== */}
          <div className="mecha-card">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <h3
                  className="text-lg font-bold flex items-center gap-2"
                  style={{ color: 'var(--m-text)' }}
                >
                  🔍 诊断模式总闸
                  <span
                    style={{
                      padding: '2px 8px', fontSize: '11px', borderRadius: '2px', fontWeight: 500, marginLeft: '8px',
                      backgroundColor: debugEnabled ? 'rgba(45,212,167,0.12)' : 'rgba(216,112,74,0.12)',
                      color: debugEnabled ? 'var(--m-ok)' : 'var(--m-danger)',
                      border: `1px solid ${debugEnabled ? 'var(--m-ok)' : 'var(--m-danger)'}`,
                    }}
                  >
                    {debugEnabled ? '✅ 开启' : '⛔ 关闭'}
                  </span>
                </h3>
                <p
                  className="text-sm mt-2 leading-relaxed"
                  style={{ color: 'var(--m-text-sub)' }}
                >
                  关闭后, 用户尝试在用户端开启诊断模式会返 403;
                  已开启的用户其后续请求也不再写入货架(已有内容仍可读至过期)。
                </p>
              </div>
              <button
                onClick={handleToggleDebug}
                disabled={savingKey === 'debug_cache_enabled'}
                className="px-4 py-2 text-sm rounded-md border font-medium transition-colors disabled:opacity-50 whitespace-nowrap"
                style={{
                  borderColor: 'var(--m-accent)',
                  color: debugEnabled ? 'var(--m-accent)' : 'var(--m-accent-text)',
                  background: debugEnabled ? 'transparent' : 'var(--m-accent)',
                }}
              >
                {savingKey === 'debug_cache_enabled'
                  ? '保存中...'
                  : debugEnabled
                  ? '关闭'
                  : '开启'}
              </button>
            </div>
          </div>

          {/* ===== 卡片 2:每用户货架上限 ===== */}
          <div className="mecha-card">
            <h3
              className="text-lg font-bold flex items-center gap-2"
              style={{ color: 'var(--m-text)' }}
            >
              📦 每用户货架上限
            </h3>
            <p
              className="text-sm mt-2 leading-relaxed"
              style={{ color: 'var(--m-text-sub)' }}
            >
              每位用户的诊断货架最大占用(MB)。超过会触发 FIFO 自动淘汰最旧条目。
              当前生效值:<span className="font-medium">{currentMaxMb || '—'} MB</span>
            </p>
            <div className="mt-4 flex items-center gap-3">
              <input
                type="number"
                min={1}
                max={1024}
                step={1}
                value={maxMbDraft}
                onChange={(e) => setMaxMbDraft(e.target.value)}
                className="mecha-input" style={{ width: '128px', display: 'inline-block' }}
                placeholder="1-1024"
              />
              <span style={{ color: 'var(--m-text-mute)' }}>MB</span>
              <button
                onClick={handleSaveMaxMb}
                disabled={!maxMbDirty || savingKey === 'debug_cache_per_user_max_mb'}
                className="px-4 py-2 text-sm text-white rounded-md hover:opacity-90 transition-opacity font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'var(--m-accent)' }}
              >
                {savingKey === 'debug_cache_per_user_max_mb' ? '保存中...' : '保存'}
              </button>
              {maxMbDirty && (
                <button
                  onClick={() => setMaxMbDraft(currentMaxMb)}
                  className="text-sm hover:underline"
                  style={{ color: 'var(--m-text-mute)' }}
                >
                  重置
                </button>
              )}
            </div>
          </div>

          {/* ===== 卡片 3:S1+ 全站 RPM 上限 ===== */}
          <div className="mecha-card">
            <h3
              className="text-lg font-bold flex items-center gap-2"
              style={{ color: 'var(--m-text)' }}
            >
              🚦 全站 RPM 上限
            </h3>
            <p
              className="text-sm mt-2 leading-relaxed"
              style={{ color: 'var(--m-text-sub)' }}
            >
              每位用户每分钟最多调用 API 的次数。AI 单条回复通常需要 30-60 秒,5 RPM 已能覆盖 airp 场景。<br />
              当前生效值:<span className="font-medium">{currentGlobalRpm || '—'} 次 / 分钟</span>
            </p>
            <div className="mt-4 flex items-center gap-3">
              <input
                type="number"
                min={1}
                max={1000}
                step={1}
                value={globalRpmDraft}
                onChange={(e) => setGlobalRpmDraft(e.target.value)}
                className="mecha-input" style={{ width: '128px', display: 'inline-block' }}
                placeholder="1-1000"
              />
              <span style={{ color: 'var(--m-text-mute)' }}>次 / 分钟</span>
              <button
                onClick={handleSaveGlobalRpm}
                disabled={!globalRpmDirty || savingKey === 'global_rpm_limit'}
                className="px-4 py-2 text-sm text-white rounded-md hover:opacity-90 transition-opacity font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'var(--m-accent)' }}
              >
                {savingKey === 'global_rpm_limit' ? '保存中...' : '保存'}
              </button>
              {globalRpmDirty && (
                <button
                  onClick={() => setGlobalRpmDraft(currentGlobalRpm)}
                  className="text-sm hover:underline"
                  style={{ color: 'var(--m-text-mute)' }}
                >
                  重置
                </button>
              )}
            </div>
          </div>

          {/* ===== 卡片 4:S1+ 拉黑账号 RPM 上限 ===== */}
          <div className="mecha-card">
            <h3
              className="text-lg font-bold flex items-center gap-2"
              style={{ color: 'var(--m-text)' }}
            >
              ⛔ 拉黑账号 RPM 上限
            </h3>
            <p
              className="text-sm mt-2 leading-relaxed"
              style={{ color: 'var(--m-text-sub)' }}
            >
              BLACKLIST 状态用户的独立 RPM 上限(语义:能用但不能滥用)。建议比全站 RPM 更严。<br />
              当前生效值:<span className="font-medium">{currentBlacklistRpm || '—'} 次 / 分钟</span>
            </p>
            <div className="mt-4 flex items-center gap-3">
              <input
                type="number"
                min={1}
                max={1000}
                step={1}
                value={blacklistRpmDraft}
                onChange={(e) => setBlacklistRpmDraft(e.target.value)}
                className="mecha-input" style={{ width: '128px', display: 'inline-block' }}
                placeholder="1-1000"
              />
              <span style={{ color: 'var(--m-text-mute)' }}>次 / 分钟</span>
              <button
                onClick={handleSaveBlacklistRpm}
                disabled={!blacklistRpmDirty || savingKey === 'blacklist_rpm_limit'}
                className="px-4 py-2 text-sm text-white rounded-md hover:opacity-90 transition-opacity font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'var(--m-accent)' }}
              >
                {savingKey === 'blacklist_rpm_limit' ? '保存中...' : '保存'}
              </button>
              {blacklistRpmDirty && (
                <button
                  onClick={() => setBlacklistRpmDraft(currentBlacklistRpm)}
                  className="text-sm hover:underline"
                  style={{ color: 'var(--m-text-mute)' }}
                >
                  重置
                </button>
              )}
            </div>
          </div>

          {/* ===== 卡片 5:F6 签到系统总开关 ===== */}
          <div className="mecha-card">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <h3
                  className="text-lg font-bold flex items-center gap-2"
                  style={{ color: 'var(--m-text)' }}
                >
                  🎁 每日签到总开关
                  <span
                    style={{
                      padding: '2px 8px', fontSize: '11px', borderRadius: '2px', fontWeight: 500, marginLeft: '8px',
                      backgroundColor: checkinEnabled ? 'rgba(45,212,167,0.12)' : 'rgba(216,112,74,0.12)',
                      color: checkinEnabled ? 'var(--m-ok)' : 'var(--m-danger)',
                      border: `1px solid ${checkinEnabled ? 'var(--m-ok)' : 'var(--m-danger)'}`,
                    }}
                  >
                    {checkinEnabled ? '✅ 开启' : '⛔ 关闭'}
                  </span>
                </h3>
                <p
                  className="text-sm mt-2 leading-relaxed"
                  style={{ color: 'var(--m-text-sub)' }}
                >
                  关闭后, 用户端"每日签到"卡片整张隐藏, 调签到接口返 403。
                  BLACKLIST / BANNED 用户无论开关如何都不能领福利。
                </p>
              </div>
              <button
                onClick={handleToggleCheckin}
                disabled={savingKey === 'checkin_enabled'}
                className="px-4 py-2 text-sm rounded-md border font-medium transition-colors disabled:opacity-50 whitespace-nowrap"
                style={{
                  borderColor: 'var(--m-accent)',
                  color: checkinEnabled ? 'var(--m-accent)' : 'var(--m-accent-text)',
                  background: checkinEnabled ? 'transparent' : 'var(--m-accent)',
                }}
              >
                {savingKey === 'checkin_enabled'
                  ? '保存中...'
                  : checkinEnabled
                  ? '关闭'
                  : '开启'}
              </button>
            </div>
          </div>

          {/* ===== 卡片 6:F6 每日签到奖励豆数 ===== */}
          <div className="mecha-card">
            <h3
              className="text-lg font-bold flex items-center gap-2"
              style={{ color: 'var(--m-text)' }}
            >
              🐾 每日签到奖励
            </h3>
            <p
              className="text-sm mt-2 leading-relaxed"
              style={{ color: 'var(--m-text-sub)' }}
            >
              用户每天签到领取的咖啡豆数(人类可读豆数)。改动后用户端签到卡片即时显示新值。<br />
              当前生效值:<span className="font-medium">{currentCheckinReward || '—'} 豆 / 天</span>
            </p>
            <div className="mt-4 flex items-center gap-3">
              <input
                type="number"
                min={0}
                max={100000}
                step={1}
                value={checkinRewardDraft}
                onChange={(e) => setCheckinRewardDraft(e.target.value)}
                className="mecha-input" style={{ width: '128px', display: 'inline-block' }}
                placeholder="0-100000"
              />
              <span style={{ color: 'var(--m-text-mute)' }}>豆 / 天</span>
              <button
                onClick={handleSaveCheckinReward}
                disabled={!checkinRewardDirty || savingKey === 'checkin_reward_amount'}
                className="px-4 py-2 text-sm text-white rounded-md hover:opacity-90 transition-opacity font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ background: 'var(--m-accent)' }}
              >
                {savingKey === 'checkin_reward_amount' ? '保存中...' : '保存'}
              </button>
              {checkinRewardDirty && (
                <button
                  onClick={() => setCheckinRewardDraft(currentCheckinReward)}
                  className="text-sm hover:underline"
                  style={{ color: 'var(--m-text-mute)' }}
                >
                  重置
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {ConfirmDialog}
      {ToastContainer}
    </div>
  );
}