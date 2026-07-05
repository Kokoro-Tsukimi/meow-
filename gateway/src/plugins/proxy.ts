import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import { request as undiciRequest } from 'undici';
import { redis } from '../redis';
import { pool } from '../db';
import { broadcastToAdmins } from '../realtime';
import { isDebugCacheEnabled } from '../services/systemSettings';
import { writeToShelf } from '../services/debugCache';

// ============ 渠道选择辅助函数 ============

interface ChannelInfo {
  id: number;
  name: string;
  base_url: string;
  api_key: string;
  models: string[];
  weight: number;
  priority: number;
  owner_user_id: number | null; // F.1.5: NULL=公共渠道,填了=某用户的专属书架喵(F.1.6 后 proxy 不再据此过滤,DB 列保留)
  real_model_name?: string;     // F.1.6: 走分组时该渠道在本分组下转发用的真实模型名;走老路/兜底时不填
}

/**
 * 渠道池加载器:60s 缓存读 + miss 回源 MySQL(只取 ENABLE)+ 写回。
 * 从原 selectChannelCandidates 抽出来,因为 F.1.6 分组路径也要用同一份渠道池喵。
 */
async function loadAllChannels(trace_id: string): Promise<ChannelInfo[]> {
  const cacheKey = 'gateway:cache:channels:all';

  // 1. 尝试从 Redis 缓存读取
  let channelsJson = await redis.get(cacheKey);
  let allChannels: ChannelInfo[] = [];

  if (channelsJson) {
    try {
      allChannels = JSON.parse(channelsJson);
    } catch {
      allChannels = [];
    }
  }

  // 2. Cache Miss → 回源 MySQL
  if (allChannels.length === 0) {
    console.info(`[GATEWAY][渠道缓存][${trace_id}] Cache Miss, 回源 MySQL`);
    const [rows]: any = await pool.query(
      "SELECT id, name, base_url, api_key_encrypted, models, weight, priority, owner_user_id FROM Channels WHERE status = 'ENABLE' ORDER BY priority ASC, id DESC"
    );

    allChannels = rows.map((r: any) => {
      let modelsArr: string[] = [];
      if (Array.isArray(r.models)) {
        modelsArr = r.models;
      } else if (typeof r.models === 'string' && r.models) {
        try { modelsArr = JSON.parse(r.models); } catch { modelsArr = []; }
      }
      return {
        id: r.id,
        name: r.name,
        base_url: r.base_url,
        api_key: r.api_key_encrypted,
        models: modelsArr,
        weight: r.weight || 1,
        priority: r.priority || 1,
        owner_user_id: r.owner_user_id ?? null,
      };
    });

    // 写回 Redis,TTL 60秒
    await redis.set(cacheKey, JSON.stringify(allChannels), 'EX', 60);
    console.info(`[GATEWAY][渠道缓存][${trace_id}] 写入缓存,共 ${allChannels.length} 个渠道`);
  }

  return allChannels;
}

/**
 * D.1: 根据"真实模型名"选出候选渠道列表(过渡期老路 / 客人直接发真名时用)
 * - 按 priority 升序分组(数字越小越优先)
 * - 同 priority 组内按 weight 加权随机排序(Efraimidis-Spirakis)
 * - 跳过熔断冷却中的渠道
 * 返回空数组表示无可用渠道(调用方应回退 .env 兜底)
 * F.1.6(路A):owner_user_id 归属过滤已上移到分组层,这里不再按 owner 过滤;
 *             DB 列保留,ChannelInfo 仍读它,只是不参与筛选喵。
 */
async function selectChannelCandidates(model: string, trace_id: string): Promise<ChannelInfo[]> {
  try {
    const allChannels = await loadAllChannels(trace_id);

    // 1. 按真实模型名筛选(不再做 owner 过滤)
    let matched = allChannels.filter((c) => c.models.includes(model));
    if (matched.length === 0) {
      console.warn(`[GATEWAY][渠道选择][${trace_id}] 找不到支持 ${model} 的可用渠道,将兜底`);
      return [];
    }

    // 2. 剔除熔断冷却中的渠道(D.2: 上游连续出错后会被临时拉黑60秒)
    const aliveFlags = await Promise.all(
      matched.map((c) => redis.exists(`gateway:channel:cooldown:${c.id}`))
    );
    const cooled = matched.filter((_, i) => aliveFlags[i] === 1).map((c) => c.name);
    matched = matched.filter((_, i) => aliveFlags[i] === 0);
    if (cooled.length > 0) {
      console.warn(`[GATEWAY][渠道选择][${trace_id}] 熔断冷却中,跳过: ${cooled.join(', ')}`);
    }
    if (matched.length === 0) {
      console.warn(`[GATEWAY][渠道选择][${trace_id}] 所有渠道均在熔断中,将兜底`);
      return [];
    }

    // 3. 按 priority 分组,组内加权随机排序(Efraimidis-Spirakis)
    const sorted = matched
      .map((c) => ({ c, sortKey: Math.pow(Math.random(), 1 / c.weight) }))
      .sort((a, b) => (a.c.priority - b.c.priority) || (b.sortKey - a.sortKey))
      .map((x) => x.c);

    console.info(`[GATEWAY][渠道选择][${trace_id}] 候选顺序: ${sorted.map((c) => `${c.name}(p${c.priority}/w${c.weight})`).join(' → ')}`);
    return sorted;
  } catch (err: any) {
    console.error(`[GATEWAY][渠道选择][${trace_id}] 异常:`, err.message);
    return [];
  }
}

/**
 * D.2: 给渠道记一次熔断——60秒内不再把请求派给它
 */
async function tripChannelBreaker(channelId: number, channelName: string, trace_id: string, reason: string) {
  try {
    await redis.set(`gateway:channel:cooldown:${channelId}`, reason, 'EX', 60);
    console.warn(`[GATEWAY][渠道熔断][${trace_id}] ${channelName}(id=${channelId}) 已熔断60秒,原因: ${reason}`);
  } catch (err: any) {
    console.error(`[GATEWAY][渠道熔断][${trace_id}] 写入熔断标记失败:`, err.message);
  }
}

// ============ F.1.6 模型分组(对外菜单)辅助函数 ============
// 核心思想:"我叫什么名字我自己知道,别人知道的是我告诉他的名字喵。"
// user 发来的 model 是"对外菜单名"(如 deepseek3.2),proxy 把它翻译成
// (真实渠道 + 真实模型名)候选集,并做分组级授权安检。

const MODEL_GROUPS_CACHE_KEY = 'gateway:cache:model_groups:all';

// 组内一条"菜单名→渠道"的映射(一个菜单名可挂多条渠道做负载均衡,各自真名可不同)
interface ModelGroupChannelLink {
  channel_id: number;
  real_model_name: string; // 这条渠道在本分组下转发用的真名(同组不同渠道可不一样喵)
  weight: number;          // 组内加权(覆盖渠道自身 weight)
}

interface ModelGroupInfo {
  id: number;
  name: string;                          // 对外菜单名(UNIQUE)
  prompt_price: number;                  // ⚠️ 每 1M tokens、×10万存(和老 ModelRates 的每 1K 不同!)
  completion_price: number;
  access_mode: 'PUBLIC' | 'WHITELIST';
  status: 'ENABLE' | 'DISABLE';
  channels: ModelGroupChannelLink[];     // 组内 status=ENABLE 的渠道映射
  grants: number[];                      // WHITELIST 模式下被授权的 user_id 列表(PUBLIC 留空)
}

/**
 * F.1.6: 加载所有分组(套路同渠道/规则缓存):
 * - 先读 Redis 缓存(TTL 60s,admin 任何分组/映射/授权变动后会主动 DEL 它)
 * - miss → 回源 MySQL:ModelGroups 主表 + (逐组) ModelGroupChannels(只取 ENABLE)
 *   + WHITELIST 组额外查 ModelGroupGrants 授权名单,拼好整体写回缓存
 * - 任何异常 → 返回空数组(fail-soft,由调用方决定回退)
 * 注意:缓存形状由 proxy 这边定义、proxy 负责回源填充;admin 只负责 DEL,不写这个 key。
 */
async function loadModelGroups(trace_id: string): Promise<ModelGroupInfo[]> {
  try {
    const json = await redis.get(MODEL_GROUPS_CACHE_KEY);
    if (json !== null) {
      try { return JSON.parse(json); } catch { return []; }
    }

    // Cache Miss → 回源 MySQL
    const [groupRows]: any = await pool.query(
      "SELECT id, name, prompt_price, completion_price, access_mode, status FROM ModelGroups"
    );

    const groups: ModelGroupInfo[] = [];
    for (const g of groupRows) {
      // 组内 ENABLE 的渠道映射
      const [linkRows]: any = await pool.query(
        "SELECT channel_id, real_model_name, weight FROM ModelGroupChannels WHERE group_id = ? AND status = 'ENABLE'",
        [g.id]
      );
      // 仅 WHITELIST 组才需要授权名单;PUBLIC 留空省一次查询
      let grants: number[] = [];
      if (g.access_mode === 'WHITELIST') {
        const [grantRows]: any = await pool.query(
          "SELECT user_id FROM ModelGroupGrants WHERE group_id = ?",
          [g.id]
        );
        grants = grantRows.map((r: any) => Number(r.user_id));
      }
      groups.push({
        id: g.id,
        name: g.name,
        prompt_price: Number(g.prompt_price) || 0,
        completion_price: Number(g.completion_price) || 0,
        access_mode: g.access_mode,
        status: g.status,
        channels: linkRows.map((r: any) => ({
          channel_id: Number(r.channel_id),
          real_model_name: r.real_model_name,
          weight: Number(r.weight) || 1,
        })),
        grants,
      });
    }

    await redis.set(MODEL_GROUPS_CACHE_KEY, JSON.stringify(groups), 'EX', 60);
    console.info(`[GATEWAY][分组缓存][${trace_id}] Cache Miss,回源 MySQL 加载 ${groups.length} 个分组`);
    return groups;
  } catch (err: any) {
    console.error(`[GATEWAY][分组加载][${trace_id}] 异常:`, err.message);
    return [];
  }
}

// 分组解析的三种结局:
//   NOT_GROUP —— 这个名字根本不是任何分组 → 交给过渡期回退(老 Channels.models 真名匹配)
//   UNUSABLE  —— 是分组但此刻对该 user 不可用(停用/未授权/空分组/全熔断)→ 方案B 模糊报错(404)
//   OK        —— 可用,candidates 已加权排序、每个都带 real_model_name,并附分组价
type GroupResolution =
  | { kind: 'NOT_GROUP' }
  | { kind: 'UNUSABLE' }
  | { kind: 'OK'; group: ModelGroupInfo; candidates: ChannelInfo[] };

/**
 * F.1.6: 把"对外菜单名"解析成可用的候选渠道集(带真名),并做授权安检。
 * 方案B(防分组存在性泄露):不存在 / 未授权 / 停用 / 空分组 一律返回 UNUSABLE,
 *   调用方对外回完全一样的 404,客人无从区分"没这个分组"还是"有但你没权限"喵。
 */
async function resolveModelGroup(
  model: string,
  userId: string | number | undefined,
  trace_id: string
): Promise<GroupResolution> {
  try {
    const groups = await loadModelGroups(trace_id);
    const group = groups.find((g) => g.name === model);

    // 名字不是任何分组 → 过渡期回退
    if (!group) {
      return { kind: 'NOT_GROUP' };
    }

    // 整组停用 → 对外不可见(方案B)
    if (group.status !== 'ENABLE') {
      console.info(`[GATEWAY][分组解析][${trace_id}] 分组「${group.name}」已停用,模糊报错`);
      return { kind: 'UNUSABLE' };
    }

    // 授权安检:WHITELIST 才查名单;PUBLIC 人人可见
    if (group.access_mode === 'WHITELIST') {
      const uid = Number(userId);
      if (!Number.isFinite(uid) || !group.grants.includes(uid)) {
        console.info(`[GATEWAY][分组解析][${trace_id}] user ${userId} 未被授权分组「${group.name}」,模糊报错`);
        return { kind: 'UNUSABLE' };
      }
    }

    // 组内无任何 ENABLE 映射 → 空分组,对外不可见
    if (group.channels.length === 0) {
      console.info(`[GATEWAY][分组解析][${trace_id}] 分组「${group.name}」组内无渠道映射,模糊报错`);
      return { kind: 'UNUSABLE' };
    }

    // 把组内映射对到真实渠道:渠道池只装 ENABLE,所以对应 Channel 若 DISABLE/不存在会自动落空
    const channelPool = await loadAllChannels(trace_id);
    const poolById = new Map<number, ChannelInfo>();
    for (const c of channelPool) poolById.set(c.id, c);

    let candidates: ChannelInfo[] = [];
    for (const link of group.channels) {
      const ch = poolById.get(link.channel_id);
      if (!ch) continue; // 对应渠道已 DISABLE 或不存在 → 跳过
      candidates.push({
        ...ch,
        real_model_name: link.real_model_name, // 本组下这条渠道转发用的真名
        weight: link.weight,                   // 组内加权覆盖渠道自身 weight
      });
    }
    if (candidates.length === 0) {
      console.info(`[GATEWAY][分组解析][${trace_id}] 分组「${group.name}」组内渠道全部不可用(DISABLE),模糊报错`);
      return { kind: 'UNUSABLE' };
    }

    // 剔除熔断冷却中的渠道
    const aliveFlags = await Promise.all(
      candidates.map((c) => redis.exists(`gateway:channel:cooldown:${c.id}`))
    );
    const cooled = candidates.filter((_, i) => aliveFlags[i] === 1).map((c) => c.name);
    candidates = candidates.filter((_, i) => aliveFlags[i] === 0);
    if (cooled.length > 0) {
      console.warn(`[GATEWAY][分组解析][${trace_id}] 熔断冷却中,跳过: ${cooled.join(', ')}`);
    }
    if (candidates.length === 0) {
      // 组里确有渠道但此刻全在熔断 → 仍算"不可用"。这里选择模糊报错而非漏到 .env 兜底,
      // 避免拿菜单名去请求不相干的兜底上游(决策:分组命中后不再退到 .env)。
      console.warn(`[GATEWAY][分组解析][${trace_id}] 分组「${group.name}」渠道全在熔断中,模糊报错`);
      return { kind: 'UNUSABLE' };
    }

    // 组内加权随机排序(组内一律平级,没有 priority 概念,只按 weight 跑 Efraimidis-Spirakis)
    const sorted = candidates
      .map((c) => ({ c, sortKey: Math.pow(Math.random(), 1 / (c.weight || 1)) }))
      .sort((a, b) => (b.sortKey - a.sortKey))
      .map((x) => x.c);

    console.info(`[GATEWAY][分组解析][${trace_id}] 命中分组「${group.name}」候选: ${sorted.map((c) => `${c.name}→${c.real_model_name}(w${c.weight})`).join(' → ')}`);
    return { kind: 'OK', group, candidates: sorted };
  } catch (err: any) {
    console.error(`[GATEWAY][分组解析][${trace_id}] 异常:`, err.message);
    // 分组系统自己生病 → 当作 NOT_GROUP 回退老逻辑,别连累正常客人(fail-soft)
    return { kind: 'NOT_GROUP' };
  }
}

// ============ E.1 风控规则(安检手册)辅助函数 ============

interface RuleInfo {
  id: number;
  name: string;
  rule_type: 'BLACKLIST' | 'SHADOW' | 'DRYRUN';
  match_conditions: {
    models?: string[];    // 匹配哪些模型(精确匹配模型名)
    keywords?: string[];  // 匹配消息内容里的关键词(包含即命中)
  } | null;
}

const RULES_CACHE_KEY = 'gateway:cache:rules:all';

// E.2: 影子流量队列——命中 SHADOW 规则的请求,克隆体丢进这条 Redis Stream,worker 批量搬进 ClickHouse
const SHADOW_STREAM_KEY = 'gateway:stream:shadow';
// E.2: 克隆体单字段最大长度(字符),防止超长对话把内存和队列撑爆喵
const SHADOW_BODY_MAX_LEN = 200000;

/**
 * E.1: 加载所有"生效中"的风控规则(套路同渠道缓存喵)
 * - 先读 Redis 缓存(TTL 60秒,admin.ts 增删改规则时会主动清掉它)
 * - 缓存 miss → 回源 MySQL Rules 表,只取 status='ENABLE' 的,写回缓存
 * - 任何异常 → 返回空数组(fail-open:安检系统自己生病了,不能连累正常客人喵)
 * 注意:空数组"[]"也是合法缓存(代表确实没规则),所以用 rulesJson 是否存在判断 miss,
 *      而不是用数组长度判断——不然没配规则时每个请求都会去敲一次 MySQL 的门喵。
 */
async function loadActiveRules(trace_id: string): Promise<RuleInfo[]> {
  try {
    const rulesJson = await redis.get(RULES_CACHE_KEY);
    let rules: RuleInfo[] = [];

    if (rulesJson !== null) {
      try { rules = JSON.parse(rulesJson); } catch { rules = []; }
      return rules;
    }

    // Cache Miss → 回源 MySQL
    const [rows]: any = await pool.query(
      "SELECT id, name, rule_type, match_conditions FROM Rules WHERE status = 'ENABLE' ORDER BY id ASC"
    );
    rules = rows.map((r: any) => {
      // JSON 列 mysql2 可能已自动解析成对象,也可能是字符串,两种都兼容喵
      let conditions = null;
      if (r.match_conditions) {
        if (typeof r.match_conditions === 'string') {
          try { conditions = JSON.parse(r.match_conditions); } catch { conditions = null; }
        } else {
          conditions = r.match_conditions;
        }
      }
      return { id: r.id, name: r.name, rule_type: r.rule_type, match_conditions: conditions };
    });

    await redis.set(RULES_CACHE_KEY, JSON.stringify(rules), 'EX', 60);
    console.info(`[GATEWAY][规则缓存][${trace_id}] Cache Miss,回源 MySQL 加载 ${rules.length} 条生效规则`);
    return rules;
  } catch (err: any) {
    console.error(`[GATEWAY][规则加载][${trace_id}] 异常:`, err.message);
    return [];
  }
}

/**
 * E.1: 判断一条规则是否命中本次请求
 * - models 条件:请求的模型名出现在列表里 → 命中
 * - keywords 条件:消息正文里包含任意一个关键词 → 命中
 * - 两类条件是"或"的关系,任一满足即命中
 * - 没写任何条件的规则视为不命中(防止一条空规则误伤所有客人喵)
 */
function matchRule(rule: RuleInfo, model: string, messagesText: string): boolean {
  const cond = rule.match_conditions;
  if (!cond) return false;

  if (Array.isArray(cond.models) && cond.models.length > 0) {
    if (cond.models.includes(model)) return true;
  }
  if (Array.isArray(cond.keywords) && cond.keywords.length > 0) {
    for (const kw of cond.keywords) {
      if (kw && messagesText.includes(kw)) return true;
    }
  }
  return false;
}

/**
 * E.1: 把请求里所有消息的文字内容拼成一大段,供关键词匹配
 * 兼容两种 content 形态:纯字符串 / 数组(多模态,只取其中 type=text 的部分)
 */
function collectMessagesText(body: any): string {
  let text = '';
  if (Array.isArray(body?.messages)) {
    for (const m of body.messages) {
      if (typeof m?.content === 'string') {
        text += m.content + '\n';
      } else if (Array.isArray(m?.content)) {
        for (const part of m.content) {
          if (part?.type === 'text' && typeof part.text === 'string') {
            text += part.text + '\n';
          }
        }
      }
    }
  }
  return text;
}

// ============ E.3 Dry-Run 挂起术(吧台安检区)辅助 ============

// 挂起请求的上下文暂存区(审批台展示用),TTL 到期自动销毁
const DRYRUN_TRACE_PREFIX = 'gateway:dryrun:trace:';
// 店长裁决信箱:审批接口(或测试时的 redis-cli)往这里写裁决,挂起的请求每秒来看一眼
const DRYRUN_VERDICT_PREFIX = 'gateway:dryrun:verdict:';
// 最长挂起秒数(默认300秒=5分钟;测试超时时可在 .env 临时调小)
const DRYRUN_TIMEOUT_S = parseInt(process.env.DRYRUN_TIMEOUT_S || '300', 10);
const DRYRUN_POLL_MS = 1000;        // 裁决轮询间隔
const DRYRUN_HEARTBEAT_MS = 15000;  // SSE 心跳间隔

interface DryRunVerdict {
  action: 'approve' | 'reject' | 'timeout' | 'client_gone';
  override_body?: any;     // 店长"加点糖"后的新请求体(可选)
  sseStarted: boolean;     // 挂起期间是否已用 SSE 身份开了头(决定后续怎么回话)
}

/**
 * E.3.2 核心:无感挂起一个命中 DRYRUN 规则的请求,等店长裁决喵
 * 1. 把请求上下文存进 Redis(带TTL),供审批台展示
 * 2. 流式请求:立刻表明 SSE 身份并每15秒发一句 ": keep-alive" 注释行——
 *    各家 SDK 都会无视注释行,客户端就安安静静吊着不超时、不报错、无感知
 *    (非流式请求发不了心跳,只能让客户端自己干等,这是已拍板的取舍喵)
 * 3. 每秒轮询裁决信箱,等到 approve/reject 或超时
 * 4. 客人中途自己挂断 → 立刻停止等待,免得白白占着店长的注意力
 */
async function suspendForDryRun(
  req: FastifyRequest,
  reply: FastifyReply,
  trace_id: string,
  model: string,
  body: any,
  rule: RuleInfo
): Promise<DryRunVerdict> {
  // ① 上下文进暂存区
  const context = {
    trace_id,
    user_id: req.user?.id || 'unknown',
    client_ip: req.ip,
    model,
    rule_id: rule.id,
    rule_name: rule.name,
    request_body: body,
    status: 'PENDING',
    created_at: new Date().toISOString(),
    expire_at: new Date(Date.now() + DRYRUN_TIMEOUT_S * 1000).toISOString(),
  };
  await redis.set(DRYRUN_TRACE_PREFIX + trace_id, JSON.stringify(context), 'EX', DRYRUN_TIMEOUT_S);
  console.warn(`[GATEWAY][安检挂起][${trace_id}] 命中DRYRUN规则「${rule.name}」(id=${rule.id}),订单已端到店长面前,最长等待 ${DRYRUN_TIMEOUT_S} 秒喵`);
  // E.3.4: 叮铃~通过店长专线实时通知在线的店长(没人在线也无妨,订单还在暂存区等着)
  broadcastToAdmins('DRY_RUN_PENDING', {
    trace_id,
    trigger_rule: rule.name,
    rule_id: rule.id,
    user_id: context.user_id,
    client_ip: req.ip,
    request_detail: { model, body },
    expire_at: context.expire_at,
  });

  // ② 流式请求:开 SSE 身份 + 心跳保活
  const isStream = body?.stream === true;
  let heartbeat: NodeJS.Timeout | null = null;
  if (isStream) {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    reply.raw.write(': keep-alive\n\n');
    heartbeat = setInterval(() => {
      try { reply.raw.write(': keep-alive\n\n'); } catch { /* 连接没了就算了 */ }
    }, DRYRUN_HEARTBEAT_MS);
  }

  // ③ 盯着裁决信箱轮询(同时留意客人有没有自己挂断)
  let clientGone = false;
  req.raw.on('close', () => { clientGone = true; });

  let verdict: DryRunVerdict = { action: 'timeout', sseStarted: isStream };
  const deadline = Date.now() + DRYRUN_TIMEOUT_S * 1000;

  while (Date.now() < deadline) {
    if (clientGone) {
      verdict = { action: 'client_gone', sseStarted: isStream };
      break;
    }
    const raw = await redis.get(DRYRUN_VERDICT_PREFIX + trace_id);
    if (raw !== null) {
      // 裁决格式兼容两种:纯文本 "approve"/"reject"(方便 redis-cli 手动测试),
      // 或 JSON {"action":"approve","override_body":{...}}(审批接口用,支持改配方)
      if (raw === 'approve') {
        verdict = { action: 'approve', sseStarted: isStream };
      } else if (raw === 'reject') {
        verdict = { action: 'reject', sseStarted: isStream };
      } else {
        try {
          const parsed = JSON.parse(raw);
          verdict = {
            action: parsed.action === 'approve' ? 'approve' : 'reject',
            override_body: parsed.override_body,
            sseStarted: isStream,
          };
        } catch {
          // 看不懂的裁决一律按拒绝处理,安全第一喵
          verdict = { action: 'reject', sseStarted: isStream };
        }
      }
      await redis.del(DRYRUN_VERDICT_PREFIX + trace_id);
      break;
    }
    await new Promise((r) => setTimeout(r, DRYRUN_POLL_MS));
  }

  // ④ 收尾:停心跳、清暂存区(裁决信箱上面已删)
  if (heartbeat) clearInterval(heartbeat);
  await redis.del(DRYRUN_TRACE_PREFIX + trace_id);
  return verdict;
}

// ============ 代理插件主体 ============

export default async function proxyPlugin(fastify: FastifyInstance) {
  fastify.post('/v1/chat/completions', async (req: FastifyRequest, reply: FastifyReply) => {
    // 阶段1 - 生成 trace_id + 起点计时(F.5: 算 latency 用)
    const trace_id = crypto.randomUUID();
    const proxyStartMs = Date.now();
    
    // 阶段2 - 解析模型(E.3: 改成 let,因为店长"加点糖"放行时可能换掉整个配方喵)
    let body = req.body as any;
    let model = body?.model || 'unknown';
    console.info(`[GATEWAY][路由匹配][${trace_id}] 请求模型: ${model}`);

    // 阶段2.5 (E.1/E.3) - 安检:逐条核对风控规则手册
    // 命中 BLACKLIST → 当场拒绝 403;命中 SHADOW → 记进 shadowHits 名单、照常放行;
    // 命中 DRYRUN → 无感挂起,端到店长面前等裁决喵
    const shadowHits: RuleInfo[] = [];
    let dryrunHit: RuleInfo | null = null;
    const rules = await loadActiveRules(trace_id);
    if (rules.length > 0) {
      const messagesText = collectMessagesText(body);
      for (const rule of rules) {
        if (matchRule(rule, model, messagesText)) {
          if (rule.rule_type === 'BLACKLIST') {
            console.warn(`[GATEWAY][安检拦截][${trace_id}] 命中黑名单规则「${rule.name}」(id=${rule.id}),拒绝端上桌`);
            return reply.status(403).send({ error: 'Forbidden', message: '配方危险,女仆猫拒绝端上桌喵' });
          }
          if (rule.rule_type === 'SHADOW') {
            // SHADOW: 不 return 也不 break——记下这一笔后继续查后面的规则,
            // 万一后面还有 BLACKLIST 命中,仍然要拦下来喵
            console.info(`[GATEWAY][安检影随][${trace_id}] 命中观察规则「${rule.name}」(id=${rule.id}),放行但已被女仆猫盯上喵`);
            shadowHits.push(rule);
          }
          if (rule.rule_type === 'DRYRUN' && !dryrunHit) {
            // DRYRUN: 先记下第一条命中的,等整本手册查完(确认没有黑名单)再挂起喵
            dryrunHit = rule;
          }
        }
      }
    }

    // 阶段2.6 (E.3.2) - 挂起与裁决:把可疑订单端到店长面前
    let dryrunSseStarted = false;
    if (dryrunHit) {
      const verdict = await suspendForDryRun(req, reply, trace_id, model, body, dryrunHit);
      dryrunSseStarted = verdict.sseStarted;

      if (verdict.action === 'client_gone') {
        console.warn(`[GATEWAY][安检裁决][${trace_id}] 客人等不及自己走了,撤掉这单喵`);
        try { reply.raw.end(); } catch { /* 连接已死,随它去 */ }
        return;
      }
      if (verdict.action === 'reject') {
        console.warn(`[GATEWAY][安检裁决][${trace_id}] 店长检查后拒绝,配方倒掉喵`);
        if (dryrunSseStarted) {
          // SSE 已开头,状态码改不了了,用一条 data 事件告知后优雅收流
          reply.raw.write(`data: ${JSON.stringify({ error: 'Forbidden', message: '店长检查后拒绝端上桌喵' })}\n\n`);
          reply.raw.end();
        } else {
          reply.status(403).send({ error: 'Forbidden', message: '店长检查后拒绝端上桌喵' });
        }
        return;
      }
      if (verdict.action === 'timeout') {
        console.warn(`[GATEWAY][安检裁决][${trace_id}] 店长 ${DRYRUN_TIMEOUT_S} 秒内没来检查,这单超时退回喵`);
        if (dryrunSseStarted) {
          reply.raw.write(`data: ${JSON.stringify({ error: 'Request Timeout', message: '店长太忙没来得及检查,这单先退回喵' })}\n\n`);
          reply.raw.end();
        } else {
          reply.status(408).send({ error: 'Request Timeout', message: '店长太忙没来得及检查,这单先退回喵' });
        }
        return;
      }
      // approve: 店长放行(可能附带修改后的配方)
      if (verdict.override_body && typeof verdict.override_body === 'object') {
        const wasStream = body?.stream === true;
        body = verdict.override_body;
        body.stream = wasStream; // 流式与否必须保持客人原来的口味,不许改喵
        model = body?.model || model;
        console.info(`[GATEWAY][安检裁决][${trace_id}] 店长加糖放行:按修改后的配方上桌喵`);
      } else {
        console.info(`[GATEWAY][安检裁决][${trace_id}] 店长放行,照原配方端上桌喵`);
      }
    }

    // 阶段3 (F.1.6) - 解析"对外菜单名":先查分组,查不到再回退老的真模型名匹配(过渡期兼容)
    let candidates: ChannelInfo[] = [];
    let groupPricing: { prompt_price: number; completion_price: number } | null = null;

    const groupRes = await resolveModelGroup(model, req.user?.id, trace_id);
    if (groupRes.kind === 'OK') {
      // 命中分组:用组内候选(已带 real_model_name、已加权排序),计费走分组价
      candidates = groupRes.candidates;
      groupPricing = {
        prompt_price: groupRes.group.prompt_price,
        completion_price: groupRes.group.completion_price,
      };
      console.info(`[GATEWAY][路由匹配][${trace_id}] 命中分组「${groupRes.group.name}」,组内 ${candidates.length} 个候选渠道`);
    } else if (groupRes.kind === 'NOT_GROUP') {
      // 过渡期回退:按老的 Channels.models 真模型名匹配(真·客人直接发真名时仍可用)
      candidates = await selectChannelCandidates(model, trace_id);
    }
    // groupRes.kind === 'UNUSABLE' 时 candidates 保持空,落到下面统一模糊报错

    // 方向A(2026-06-14 小昙拍板):无可用候选 → 一律同款 404 模糊报错,不再漏给 .env 兜底。
    //   收口"方案B"(客人无法区分以下三种情形,对外表现完全一致):
    //     ① 分组存在但不可用(停用 / 未授权 / 空分组 / 全熔断)—— resolveModelGroup 返回 UNUSABLE
    //     ② 名字根本不是分组、真名也匹配不到任何渠道
    //     ③ 真名匹配到渠道但全在熔断
    //   原 .env 兜底(UPSTREAM_DEFAULT_*)就此退役——决策#7 被本次推翻,记入 v8 交接书喵。
    if (candidates.length === 0) {
      console.warn(`[GATEWAY][路由匹配][${trace_id}] 无可用渠道,模糊报错(404)`);
      const payload = { error: 'Not Found', message: `模型 ${model} 不存在或不可用喵` };
      if (dryrunSseStarted) {
        // 挂起期间已开 SSE 头,状态码改不了 → 用 data 事件告知后优雅收流
        reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        reply.raw.end();
      } else {
        reply.status(404).send(payload);
      }
      return;
    }

    // 阶段4 - 强制注入计费参数
    // F5.2 修复(范围外): stream_options 是 OpenAI/SiliconFlow 协议中仅在 stream:true 时合法的字段,
    //   stream:false 时上游会报 20015 错(value error). 加 body.stream === true 守门,避免非流式请求被上游拒绝.
    if (body && body.stream === true) {
      if (!body.stream_options) {
        body.stream_options = {};
      }
      body.stream_options.include_usage = true;
      console.info(`[GATEWAY][注入计费参数][${trace_id}]`);
    }

    // 阶段5 (D.2) - 带故障转移的转发循环
    // 规则:连接失败 / 上游返回 5xx 或 429 → 熔断该渠道60秒,滑到下一个候选;
    //      全部候选都失败 → 502。
    // ⚠️ 关键边界:一旦拿到可用响应并开始向客户端转发,就不能再换渠道了
    //   (流已经发出一半,换路会产生缝合怪响应),所以转移只发生在拿到响应头之前。
    const abortController = new AbortController();
    req.raw.on('close', () => {
      abortController.abort();
    });

    try {
      let upstream: { statusCode: number; headers: any; body: any } | null = null;
      let activeChannel: ChannelInfo | null = null;
      let upstreamStartMs = 0; // F.5: 算 latency_upstream_ms 用, for 循环每次尝试时重置, 最终成功那次的值就是最终值

      for (let i = 0; i < candidates.length; i++) {
        const ch = candidates[i];
        const isLast = i === candidates.length - 1;
        const targetUrl = `${ch.base_url.replace(/\/+$/, '')}/chat/completions`;
        // F.1.6 翻译:走分组的渠道按"它在本组下的真名"转发;逐渠道翻译,故障转移到下一个
        // 候选时会按那个候选的真名重写,所以放在循环内(不能只在循环外翻译一次)。
        // 老路/兜底渠道没有 real_model_name → 保持客人原本的 model 不动(?? model)。
        body.model = ch.real_model_name ?? model;
        console.info(`[GATEWAY][转发开始][${trace_id}] 渠道: ${ch.name}, 真名: ${body.model}, 目标: ${targetUrl}`);

        try {
          upstreamStartMs = Date.now(); // F.5: 重置为本次尝试起点(故障转移会被覆盖, 最终成功那次的值生效)
          const res = await undiciRequest(targetUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${ch.api_key}`,
              'Accept': 'text/event-stream'
            },
            body: JSON.stringify(body),
            signal: abortController.signal
          });

          // 上游软故障(服务端错误/限流)→ 熔断,还有候选就换路
          const isUpstreamFailure = res.statusCode >= 500 || res.statusCode === 429;
          if (isUpstreamFailure) {
            await tripChannelBreaker(ch.id, ch.name, trace_id, `HTTP ${res.statusCode}`);
            if (!isLast) {
              res.body.dump().catch(() => {}); // 丢弃响应体,释放连接
              console.warn(`[GATEWAY][故障转移][${trace_id}] ${ch.name} 返回 ${res.statusCode},切换下一渠道`);
              continue;
            }
            // 已是最后一个候选:把这个错误响应原样透传给客户端
          }

          upstream = res;
          activeChannel = ch;
          break;
        } catch (connErr: any) {
          if (connErr.name === 'AbortError') throw connErr; // 客户端主动断开,交给外层处理
          // 连接级失败(域名不存在/拒绝连接/超时)→ 熔断,还有候选就换路
          await tripChannelBreaker(ch.id, ch.name, trace_id, `连接失败: ${connErr.message}`);
          if (!isLast) {
            console.warn(`[GATEWAY][故障转移][${trace_id}] ${ch.name} 连接失败,切换下一渠道`);
            continue;
          }
          throw connErr; // 全军覆没 → 外层 catch 返回 502
        }
      }

      // 循环保证此处 upstream/activeChannel 必有值,这里是给 TS 的保险
      if (!upstream || !activeChannel) {
        throw new Error('所有候选渠道均不可用');
      }

      const { statusCode, headers, body: responseBody } = upstream;

      reply.status(statusCode);
      
      const contentType = headers['content-type'];
      if (contentType) {
        reply.header('Content-Type', contentType);
      }
      
      const isStream = contentType?.includes('text/event-stream');

      let promptTokens = 0;
      let completionTokens = 0;
      // F5.3: 缓存命中 tokens。null = 上游未回传(与 0 = 明确零命中严格分家)。
      // 两种方言都认: OpenAI 系 usage.prompt_tokens_details.cached_tokens
      //             DeepSeek 系 usage.prompt_cache_hit_tokens
      let cachedTokens: number | null = null;
      const readCachedTokens = (usage: any): number | null => {
        const v = usage?.prompt_tokens_details?.cached_tokens;
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        const d = usage?.prompt_cache_hit_tokens;
        if (typeof d === 'number' && Number.isFinite(d)) return d;
        return null;
      };
      let cachedResponseBody = ''; // F.5: 收集响应原文准备入诊断货架(流式累加 chunk / 非流式直接赋 data)

      // E.2: 命中 SHADOW 时,顺手把 AI 的回答内容攒下来,响应结束后随克隆体一起入队
      const shadowActive = shadowHits.length > 0;
      let shadowContent = '';

      // 阶段6 - 响应流处理与计费数据提取
      if (isStream && responseBody) {
        // ---- C+.3 修复 H2: 用 buffer 累积流数据,按完整 SSE 事件解析 ----
        // 为什么这么做:
        //   上游的 SSE 数据是一块块(chunk)流过来的,但"一个完整事件"不保证
        //   刚好落在一个 chunk 里。带 usage 的那段如果被网络切成两半,直接
        //   JSON.parse 半截会失败 → usage 丢失 → 这次请求漏算费。
        //   解决办法:把流数据累加进 buffer,SSE 事件之间以空行(\n\n)分隔,
        //   每次只取出 buffer 里"已经完整"的事件来解析,没收完的残段留在
        //   buffer 里等下一块补齐,这样绝不会解析到半截事件。
        let buffer = '';

        /**
         * 从一段完整的 SSE 事件文本里尝试提取 usage(用量)。
         * 提取到就更新外层的 promptTokens / completionTokens。
         * 注意:这里只更新变量、不打日志,日志统一在流结束后打一次,避免刷屏。
         */
        const extractUsage = (eventText: string) => {
          // 一个事件可能有多行,逐行找以 'data: ' 开头的那行
          const lines = eventText.split('\n');
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('data: ') && trimmed !== 'data: [DONE]') {
              try {
                const data = JSON.parse(trimmed.slice(6));
                if (data.usage) {
                  // 取最终 usage:上游通常在最后一个事件给出累计用量,
                  // 后到的会覆盖先到的,所以流结束时拿到的就是最终值。
                  promptTokens = data.usage.prompt_tokens || 0;
                  completionTokens = data.usage.completion_tokens || 0;
                  cachedTokens = readCachedTokens(data.usage);  // F5.3
                }
                // E.2: 影子模式下,把每个事件里的增量文字拼回完整回答(超过上限就不再攒了)
                if (shadowActive && data.choices?.[0]?.delta?.content) {
                  if (shadowContent.length < SHADOW_BODY_MAX_LEN) {
                    shadowContent += data.choices[0].delta.content;
                  }
                }
              } catch {
                // 单个事件解析失败不影响透传,忽略即可
              }
            }
          }
        };

        for await (const chunk of responseBody) {
          // ① 原样透传给客户端,保证流式体验丝滑(这一步和原来一样)
          reply.raw.write(chunk);

          // ② 把这一块累加进 buffer,然后按 \n\n 切出"已完整的事件"
          const chunkStr = chunk.toString();
          cachedResponseBody += chunkStr; // F.5: 顺手攒一份完整 SSE 原文,响应结束后入诊断货架
          buffer += chunkStr;
          let sepIndex: number;
          while ((sepIndex = buffer.indexOf('\n\n')) !== -1) {
            const completeEvent = buffer.slice(0, sepIndex); // 一个完整事件
            buffer = buffer.slice(sepIndex + 2);             // 残段留着等下一块
            extractUsage(completeEvent);
          }
        }

        // ③ 流结束:buffer 里可能还剩最后一个没带 \n\n 结尾的事件,补解析一次
        if (buffer.trim().length > 0) {
          extractUsage(buffer);
        }

        reply.raw.end();

        // ④ usage 只在流结束后打一行日志,彻底消除原来的 [计费提取] 刷屏
        console.info(`[GATEWAY][计费提取][${trace_id}] prompt_tokens: ${promptTokens}, completion_tokens: ${completionTokens}`);
      } else {
        // Non-stream handling
        const data = await responseBody.text();
        cachedResponseBody = String(data); // F.5: 留一份原文准备入诊断货架
        if (dryrunSseStarted) {
          // E.3.2 护栏:挂起期间已用 SSE 身份开了头(客人要的是流式),
          // 但上游回了非流式内容(罕见,如错误JSON)——只能以流的方式把它送完喵
          reply.raw.write(`data: ${data}\n\n`);
          reply.raw.end();
        } else {
          reply.send(data);
        }

        // E.2: 非流式响应直接克隆原始文本(本身就是一段可读 JSON,留档够用喵)
        if (shadowActive) {
          shadowContent = String(data).slice(0, SHADOW_BODY_MAX_LEN);
        }
        
        try {
          const parsed = JSON.parse(data);
          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens || 0;
            completionTokens = parsed.usage.completion_tokens || 0;
            cachedTokens = readCachedTokens(parsed.usage);  // F5.3
            console.info(`[GATEWAY][计费提取][${trace_id}] prompt_tokens: ${promptTokens}, completion_tokens: ${completionTokens}`);
          }
        } catch (err) {
          // Ignore json parse error
        }
      }

      // F.5: 算 upstream / proxy 各自耗时(给 Logs 表两个 latency 字段; statusCode 直接用上面解构出的同名变量)
      //   latency_upstream_ms: 纯上游耗时(undiciRequest 起 → 响应流结束)
      //   latency_proxy_ms:    proxy 内部开销 = 总耗时 - upstream 耗时(鉴权/分组/SSE 透传等的总和)
      const latencyUpstreamMs = Date.now() - upstreamStartMs;
      const latencyProxyMs = (Date.now() - proxyStartMs) - latencyUpstreamMs;

      // 阶段7 - 异步扣费
      const user = req.user;
      if (user && (promptTokens > 0 || completionTokens > 0)) {
        setTimeout(async () => {
          try {
            // F.1.6 计费分流:
            //   命中分组 → 用分组价(ModelGroups 主表,每 1M tokens、×10万存)→ 除 1_000_000
            //   未命中(过渡期/老路)→ 原 ModelRates 三级回退(每 1K tokens)→ 除 1_000
            // ⚠️ 两条路除数差 1000 倍,千万别混用,不然分组路径会贵 1000 倍喵!
            // channelId 在两条计价路之外也要用(下面 Lua 入队记 channel_id),所以提到这里声明
            const channelId = activeChannel?.id || 0;

            let cost: number;
            if (groupPricing) {
              const promptPrice = groupPricing.prompt_price;
              const completionPrice = groupPricing.completion_price;
              cost = Math.ceil((promptTokens * promptPrice + completionTokens * completionPrice) / 1000000);
              console.info(`[GATEWAY][分组计价][${trace_id}] 每百万定价 p=${promptPrice}/c=${completionPrice}, cost=${cost}`);
            } else {
              // 费率查找(三级回退):
              //   ① 先按精确 channelId 找该渠道的专属费率;
              //   ② 找不到,回退查 channel_id=0 的"通用定价"(对所有渠道生效,见 db-init.sql 约定);
              //   ③ Redis 全 miss → 回源 MySQL ModelRates;还没有才用代码兜底价(prompt=1 / completion=2)。
              // 之前的 bug:只查精确 channelId,渠道 id=1 但费率设在 0,导致永远兜底成 1/2。
              let rates = await redis.hgetall(`gateway:rates:model:${channelId}:${model}`);

              // ① 没命中专属费率 → 回退查通用定价(channel_id=0)
              if (!rates.prompt_price && channelId !== 0) {
                rates = await redis.hgetall(`gateway:rates:model:0:${model}`);
                if (rates.prompt_price) {
                  console.info(`[GATEWAY][费率回退][${trace_id}] 渠道 ${channelId} 无专属费率,改用通用定价(channel_id=0)`);
                }
              }

              // ② Redis 全 miss → 回源 MySQL ModelRates(C+.x: Redis 重启丢数据后自愈)
              //    一条 SQL 同时找"专属费率"和"通用定价(0)",优先专属;查到写回 Redis,下次就走缓存
              if (!rates.prompt_price) {
                const [rateRows]: any = await pool.query(
                  `SELECT channel_id, prompt_price, completion_price FROM ModelRates
                   WHERE model_name = ? AND channel_id IN (?, 0)
                   ORDER BY channel_id DESC LIMIT 1`,
                  [model, channelId]
                );
                if (rateRows.length > 0) {
                  const r = rateRows[0];
                  rates = {
                    prompt_price: String(r.prompt_price),
                    completion_price: String(r.completion_price),
                  };
                  await redis.hset(`gateway:rates:model:${r.channel_id}:${model}`, rates);
                  console.info(`[GATEWAY][费率回源][${trace_id}] 从 MySQL 恢复费率并写回 Redis (channel ${r.channel_id})`);
                }
              }

              // ③ MySQL 也没有 → 代码兜底价,并告警提示该补费率
              if (!rates.prompt_price) {
                console.warn(`[GATEWAY][费率兜底][${trace_id}] 模型 ${model} 未配置费率,使用兜底价 1/2`);
              }

              const promptPrice = rates.prompt_price ? parseInt(rates.prompt_price, 10) : 1;
              const completionPrice = rates.completion_price ? parseInt(rates.completion_price, 10) : 2;
              cost = Math.ceil((promptTokens * promptPrice + completionTokens * completionPrice) / 1000);
            }
            
const balanceKey = `gateway:user:balance:${user.id}`;
            const usedKey = `gateway:user:used:${user.id}`;
            const streamKey = 'gateway:stream:billing';

            // 扣费 + 入队 合并进同一个 Lua 脚本,保证原子性
            // (要么"扣费和入队"同时成功,要么都不发生,杜绝"扣了钱没记账")
            const luaScript = `
local balance_key = KEYS[1]
local used_key = KEYS[2]
local stream_key = KEYS[3]
local cost = tonumber(ARGV[1])
local user_id = ARGV[2]
local trace_id = ARGV[3]
local model = ARGV[4]
local channel_id = ARGV[5]
local prompt_tokens = ARGV[6]
local completion_tokens = ARGV[7]
local token_id = ARGV[8]
local status_code = ARGV[9]
local latency_upstream_ms = ARGV[10]
local latency_proxy_ms = ARGV[11]
local is_stream = ARGV[12]
local cached_tokens = ARGV[13]

local current = redis.call('DECRBY', balance_key, cost)
redis.call('INCRBY', used_key, cost)

redis.call('XADD', stream_key, '*',
  'trace_id', trace_id,
  'user_id', user_id,
  'model', model,
  'cost', tostring(cost),
  'channel_id', channel_id,
  'prompt_tokens', prompt_tokens,
  'completion_tokens', completion_tokens,
  'token_id', token_id,
  'status_code', status_code,
  'latency_upstream_ms', latency_upstream_ms,
  'latency_proxy_ms', latency_proxy_ms,
  'is_stream', is_stream,
  'cached_tokens', cached_tokens
)

if current <= 0 then
  redis.call('RPUSH', 'gateway:events:arrears', user_id)
  -- 【收尾窗·方案B】封顶 1000 条防孤儿队列无限增长(曾无消费者只进不出);
  -- 保留队列本身 = 给将来"欠费风控报警/异步摘挂 ARREARS"留钩子喵
  redis.call('LTRIM', 'gateway:events:arrears', -1000, -1)
end

return current
            `;

            const remaining = await redis.eval(
              luaScript,
              3,
              balanceKey, usedKey, streamKey,
              cost.toString(), user.id, trace_id, model, channelId.toString(),
              promptTokens.toString(), completionTokens.toString(),
              user.token_id || '',  // M3: 老缓存无token_id时传空串,worker侧会跳过
              String(statusCode),                  // F.5: 真实上游 status_code(配合 B2 worker 改成不再硬编码 200)
              String(latencyUpstreamMs),           // F.5: upstream 上游耗时
              String(latencyProxyMs),              // F.5: proxy 内部开销
              String(isStream ? 1 : 0),            // F5.2: 流式响应标志(从响应 Content-Type 推断, 用 L761 isStream)
              cachedTokens === null ? '' : String(cachedTokens)  // F5.3: 空串=上游未回传 → worker 落 NULL(不用哨兵值, quota 的教训喵)
            );
            console.info(`[GATEWAY][扣费+入队完成][${trace_id}] 扣除: ${cost}, 剩余: ${remaining}`);

          } catch (err: any) {
            console.error(`[GATEWAY][扣费异常][${trace_id}]`, err.stack || err.message);
          }
        }, 0);
      }

      // 阶段7.6 (F.5) - 诊断货架三条件守门 + 异步入架
      //   ①(零开销): admin 总闸 isDebugCacheEnabled() 读进程内 cache
      //   ②(一次 SELECT): user.debug_mode_enabled + user.debug_mode_expires_at 两字段, 命中诊断模式窗口期才入架
      //   ③(委托 debugCache 内部): writeToShelf 自己 XTRIM 控容量, 单条超 MB 上限自动拒
      // 异步 .catch 吞错: 缓存写入失败绝不影响主响应(诊断功能可降级, 主代理不能挂)
      const userIdForCache = req.user?.id;
      if (userIdForCache && cachedResponseBody && isDebugCacheEnabled()) {
        setTimeout(async () => {
          try {
            const [debugRows]: any = await pool.query(
              'SELECT debug_mode_enabled, debug_mode_expires_at FROM Users WHERE id = ?',
              [userIdForCache]
            );
            if (debugRows.length === 0) return;
            const u = debugRows[0];
            if (!u.debug_mode_enabled) return;
            if (!u.debug_mode_expires_at) return;
            const userExpiresAtMs = new Date(u.debug_mode_expires_at).getTime();
            if (userExpiresAtMs < Date.now()) return; // 诊断模式窗口期已过, 不再入架

            // 三条件齐 → 写货架(整窗口期内所有 entry 共享同一个 expires_at, 窗口期结束统一被 purgeExpired 清掉)
            await writeToShelf(Number(userIdForCache), trace_id, cachedResponseBody, userExpiresAtMs);
            console.info(`[GATEWAY][F.5货架][${trace_id}] 已入架 ${(Buffer.byteLength(cachedResponseBody, 'utf8') / 1024).toFixed(1)}KB`);
          } catch (err: any) {
            console.error(`[GATEWAY][F.5货架][${trace_id}] 写入失败(已吞, 不影响主响应):`, err.message);
          }
        }, 0);
      }

      // 阶段7.5 (E.2) - 影子流量复制:把请求/回答的克隆体悄悄塞进队列,worker 会批量搬进 ClickHouse
      // 和扣费一样走异步(setTimeout),绝不拖慢客人收到回答的速度;失败也只记日志,不影响正常服务喵
      if (shadowHits.length > 0) {
        const requestBodyClone = JSON.stringify(body ?? {}).slice(0, SHADOW_BODY_MAX_LEN);
        const responseBodyClone = shadowContent;
        const shadowUserId = req.user?.id || 'unknown';
        setTimeout(async () => {
          try {
            // 命中几条 SHADOW 规则就留几份档(各自记着是哪条规则盯上的)
            for (const hit of shadowHits) {
              await redis.xadd(
                SHADOW_STREAM_KEY, '*',
                'trace_id', trace_id,
                'user_id', shadowUserId,
                'rule_id', String(hit.id),
                'rule_name', hit.name,
                'model', model,
                'request_body', requestBodyClone,
                'response_body', responseBodyClone
              );
            }
            console.info(`[GATEWAY][影子复制][${trace_id}] 克隆体已入队 ${SHADOW_STREAM_KEY},命中规则数: ${shadowHits.length}`);
          } catch (err: any) {
            console.error(`[GATEWAY][影子复制][${trace_id}] 入队失败:`, err.message);
          }
        }, 0);
      }

    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.warn(`[GATEWAY][连接断开][${trace_id}] 客户端主动断开`);
      } else {
        console.error(`[GATEWAY][转发错误][${trace_id}]`, err.stack || err.message);
        if (!reply.sent) {
          reply.status(502).send({ error: 'Bad Gateway', message: err.message });
        }
      }
    }
  });

  // ============ F.1.6 Step 3d: GET /v1/models —— 对外菜单列表 ============
  // 给下游客户端(SillyTavern 等)用的"我能点哪些菜"接口。鉴权同 chat/completions
  // (authMiddleware 已挂 req.user)。只返回该令牌主人能看到的【菜单名】,绝不暴露真实模型名喵。
  fastify.get('/v1/models', async (req: FastifyRequest, reply: FastifyReply) => {
    const trace_id = crypto.randomUUID();
    const userId = req.user?.id;
    try {
      const groups = await loadModelGroups(trace_id);
      const uid = Number(userId);

      // 可见性规则:① 整组 ENABLE ② 组内至少有一条 ENABLE 渠道映射(空菜单不上架,免得点了 404)
      //            ③ PUBLIC 人人可见 / WHITELIST 仅在授权名单里的 user 可见
      const visible = groups.filter((g) =>
        g.status === 'ENABLE' &&
        g.channels.length > 0 &&
        (g.access_mode === 'PUBLIC' || (Number.isFinite(uid) && g.grants.includes(uid)))
      );

      const created = Math.floor(Date.now() / 1000);
      const data = visible.map((g) => ({
        id: g.name,            // ⭐ 只暴露菜单名,真实模型名是店长内部账
        object: 'model',
        created,
        owned_by: 'meow-cafe',
      }));

      console.info(`[GATEWAY][菜单列表][${trace_id}] user ${userId} 可见 ${data.length} 个菜单: ${data.map((d) => d.id).join(', ') || '(空)'}`);
      return reply.send({ object: 'list', data });
    } catch (err: any) {
      console.error(`[GATEWAY][菜单列表][${trace_id}] 异常:`, err.stack || err.message);
      return reply.status(500).send({ error: 'Internal Server Error', message: '菜单暂时拿不出来喵' });
    }
  });
}
