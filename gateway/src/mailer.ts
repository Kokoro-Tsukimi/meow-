import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { Resolver } from 'dns/promises';
import { pool } from './db';

// ============ 自带卫星导航 (v2) ============
// 背景:本机的代理软件会往某些进程的系统DNS查询里塞假地址(198.18.x.x 网段),
// 导致发信连到一个不存在的服务器超时。对策:不走系统查号通道,
// 直接用UDP连公共DNS(腾讯DNSPod/阿里DNS)问真地址,代理钩子够不着喵。
const directResolver = new Resolver();
directResolver.setServers(['119.29.29.29', '223.5.5.5']);

// Fake-IP 保留网段:解析结果落在这里面=被代理软件骗了,弃用
function isFakeIp(ip: string): boolean {
  return ip.startsWith('198.18.') || ip.startsWith('198.19.');
}

async function resolveReal(host: string): Promise<string> {
  try {
    const addrs = await directResolver.resolve4(host);
    const real = addrs.find((a) => !isFakeIp(a));
    if (real) {
      console.info(`[MAILER][导航] ${host} -> ${real} (公共DNS直查)`);
      return real;
    }
    console.warn(`[MAILER][导航] ${host} 公共DNS也全是假地址?回退系统解析喵`);
  } catch (err: any) {
    console.warn(`[MAILER][导航] 公共DNS查询失败(${err.message}),回退系统解析喵`);
  }
  return host; // 兜底:照旧用域名走系统解析
}

// ============ F.3.a 送信小猫的窝 · 多渠道版 (P1.5) ============
// P1 (2026-06-18):库里多渠道加权选信 + .env 兜底,一次只挑一条,失败即抛。
// P1.5 (2026-06-19):升级为"按权排候选队列 + 错误分类 + 无缝换渠道重试",
// 我方邮箱失效时自动滑下一条 ACTIVE 继续送,用户 60s 冷却体验不变。
// sendVerifyCode 对外签名一字不改,routes/auth.ts 完全无感喵。
//
// F.1.8 (2026-06-19):抽出私有 sendMailWithChannelQueue 作为统一调度器,
// 上层暴露 sendVerifyCode(注册) 和 sendPasswordResetCode(找回密码) 两个薄壳,
// 模板各自独立,核心队列+重试+错误分类逻辑全在一个地方喵。

// 一条送信渠道的运行期配置(来源:MailChannels 表的 ACTIVE 行,或 .env 兜底)
interface MailChannelConfig {
  id: number | null; // 数据库渠道 id;null = .env 兜底单例
  name: string; // 显示名,只用来打日志
  host: string;
  port: number;
  user: string; // 登录账号兼发信人
  pass: string;
  weight: number; // 加权选信用
}

// F.1.8 新增:邮件场景化内容载荷,由上层 sendVerifyCode / sendPasswordResetCode 组装,
// 内部 sendMailWithChannelQueue 拿到后只负责"按队列送出去 + 失败换渠道",
// 不关心是注册还是改密 —— 模板分化全在上层,核心逻辑只此一份喵。
interface MailContent {
  subject: string;
  text: string;
  html: string;
}

// transporter 池:按渠道缓存,建过的不重复建(每条渠道的 host 各走一遍卫星导航)。
// key = 渠道 id 的字符串;.env 兜底用固定 key 'ENV'。
const transporterPool = new Map<string, Transporter>();

function poolKey(cfg: MailChannelConfig): string {
  return cfg.id === null ? 'ENV' : String(cfg.id);
}

// 第③步(admin CRUD)会用到:渠道被改/删/停用后,清掉它的旧 transporter,
// 下次发信重新按新凭证建。传 id 清单条,不传清全部喵。
export function invalidateMailTransporter(channelId?: number): void {
  if (channelId === undefined) {
    transporterPool.clear();
    console.info('[MAILER][池] 已清空全部 transporter 缓存');
  } else {
    transporterPool.delete(String(channelId));
    console.info(`[MAILER][池] 已清掉渠道 id=${channelId} 的 transporter 缓存`);
  }
}

// 懒加载思想保留:第一次真要用某条渠道时才建 transporter,确保 .env 已被 index.ts 加载完毕喵
async function getTransporterFor(cfg: MailChannelConfig): Promise<Transporter> {
  const key = poolKey(cfg);
  const cached = transporterPool.get(key);
  if (cached) return cached;

  const target = await resolveReal(cfg.host);
  const t = nodemailer.createTransport({
    host: target,
    port: cfg.port,
    secure: cfg.port === 465, // 465 走 SSL,587 走 STARTTLS,自动判断喵
    auth: {
      user: cfg.user,
      pass: cfg.pass,
    },
    tls: {
      // 用IP直连时,TLS证书上写的是域名,必须报上原名才能通过安检喵
      servername: cfg.host,
    },
  });
  transporterPool.set(key, t);
  console.info(`[MAILER][初始化] 信使猫已就位: [${cfg.name}] ${cfg.host}(${target}):${cfg.port}, 发信人: ${cfg.user}`);
  return t;
}

// .env 兜底渠道(库里一条 ACTIVE 都没有时用,等价于旧版单例行为)
function envFallbackConfig(): MailChannelConfig {
  return {
    id: null,
    name: '.env兜底',
    host: process.env.SMTP_HOST || 'smtp.qq.com',
    port: parseInt(process.env.SMTP_PORT || '465', 10),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    weight: 1,
  };
}

// Efraimidis-Spirakis 加权随机"全排序"(与 proxy.ts 渠道选择同款数学,扩展版):
// 给每条候选算 key = random^(1/weight),按 key 降序排列得到一个候选队列。
// 数学性质:第 1 位就是 P1 时代 pickWeighted 的结果(等价于"取最大");
// 整条队列的每一位都符合"权重越大、越靠前"的概率分布——
// 故障转移按这个顺序滑下一条,既保持了加权随机的公平性,又有了重试余地喵。
function sortByWeightedKey(candidates: MailChannelConfig[]): MailChannelConfig[] {
  return candidates
    .map((cfg) => ({
      cfg,
      key: Math.pow(Math.random(), 1 / (cfg.weight > 0 ? cfg.weight : 1)),
    }))
    .sort((a, b) => b.key - a.key)
    .map((x) => x.cfg);
}

// 选送信渠道候选队列:库里有 ACTIVE 就按权全排序返回;一条都没有则回退 .env 兜底单条队列。
// 注意.env 兜底永远只有一条:这是有意为之(决策 1A,P1.5 不让 .env 参与故障转移重试,
// 保留 P1 语义"零库底配置才用 .env",避免 .env 在"零库底"和"终极兜底"两种身份间混淆)。
async function selectMailChannelQueue(): Promise<MailChannelConfig[]> {
  try {
    const [rows]: any = await pool.query(
      "SELECT id, name, host, port, `user`, pass, weight FROM MailChannels WHERE status = 'ACTIVE'"
    );
    if (rows && rows.length > 0) {
      const candidates: MailChannelConfig[] = rows.map((r: any) => ({
        id: r.id,
        name: r.name,
        host: r.host,
        port: Number(r.port),
        user: r.user,
        pass: r.pass,
        weight: Number(r.weight) || 1,
      }));
      const queue = sortByWeightedKey(candidates);
      const order = queue.map((c) => `[${c.name}]`).join(' → ');
      console.info(`[MAILER][选信] 库中 ${candidates.length} 条 ACTIVE 渠道,按权排候选队列: ${order}`);
      return queue;
    }
    console.info('[MAILER][选信] 库中无 ACTIVE 渠道,回退 .env 兜底单条喵');
  } catch (err: any) {
    // 查库失败(比如表还没建/连接抖动)也别让发信瘫掉,回退兜底喵
    console.warn(`[MAILER][选信] 查询 MailChannels 失败(${err.message}),回退 .env 兜底喵`);
  }
  return [envFallbackConfig()];
}

// P1.5 错误分类:nodemailer 抛出的错误归到"该不该换我方渠道"两类。
// PERMANENT = 收件人侧/邮件本身问题,换我方渠道也救不回,立刻终止队列(让 routes/auth.ts 撤冷却,
//             用户改邮箱重发)。
// TRANSIENT = 我方侧问题(连接/认证/限流/未知),换条渠道有救,滑下一条。
// 分类规则:
//   - code === 'EENVELOPE'  → PERMANENT(nodemailer 已判定信封问题,典型 550 收件人不存在)
//   - code === 'EMESSAGE'   → PERMANENT(邮件内容/格式问题,跟我方渠道无关)
//   - 其他全部              → TRANSIENT(包括 EAUTH/ECONNECTION/ETIMEDOUT/ESOCKET/ENOTFOUND/
//                                       responseCode=535、4xx,以及任何未知错误——保守滑下一条)
type MailErrorClass = 'PERMANENT' | 'TRANSIENT';

function classifyMailError(err: any): MailErrorClass {
  if (!err) return 'TRANSIENT';
  const code = err.code as string | undefined;
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return 'PERMANENT';
  return 'TRANSIENT';
}

// 错误概要,统一日志格式:[渠道名] code=xxx responseCode=yyy message
function summarizeMailError(channelName: string, err: any): string {
  const code = err?.code ? `code=${err.code}` : '';
  const rc = err?.responseCode ? `responseCode=${err.responseCode}` : '';
  const msg = err?.message || String(err);
  return `[${channelName}] ${[code, rc].filter(Boolean).join(' ')} ${msg}`.trim();
}

/**
 * F.1.8 新增 · 私有调度器:按候选队列发一封信,失败按错误分类决定换/终止。
 * 这是 P1.5 核心循环的纯抽象版本——不关心场景(注册/找回密码),只管"把这封内容送出去"。
 * 上层 sendVerifyCode / sendPasswordResetCode 都是它的薄壳,只负责组装 content。
 *
 *   - 成功立即返回
 *   - PERMANENT 错误(EENVELOPE/EMESSAGE)→ 原样抛出,不再尝试下一条
 *   - TRANSIENT 错误 → 滑到下一候选继续送
 *   - 队列耗尽全失败 → 抛 ALL_CHANNELS_FAILED 综合错,allErrors 字段含每条失败明细
 *
 * @param to 收件人邮箱
 * @param content 邮件内容(subject/text/html),由调用方组装
 * @param purposeLabel 场景标签,只用于日志(如"验证码"/"找回密码验证码"),便于运维区分流量
 */
async function sendMailWithChannelQueue(to: string, content: MailContent, purposeLabel: string): Promise<void> {
  const queue = await selectMailChannelQueue();
  if (queue.length === 0) {
    // 理论不可达(selectMailChannelQueue 库空时也会返回 .env 兜底单条);保险起见显式抛错喵
    throw new Error('[MAILER] 没有可用送信渠道(队列为空)');
  }

  const errors: Array<{ channel: string; err: any }> = [];

  for (let i = 0; i < queue.length; i++) {
    const cfg = queue[i];
    const from = cfg.user;
    try {
      const t = await getTransporterFor(cfg);
      await t.sendMail({
        from: `"喵咖魔法书店" <${from}>`,
        to,
        subject: content.subject,
        text: content.text,
        html: content.html,
      });
      console.info(`[MAILER][发信] ${purposeLabel}已寄往 ${to} (经 [${cfg.name}],候选位次 ${i + 1}/${queue.length})`);
      return; // 成功立即返回喵
    } catch (err: any) {
      const kind = classifyMailError(err);
      errors.push({ channel: cfg.name, err });

      if (kind === 'PERMANENT') {
        // 收件人侧问题,换我方渠道也救不回,立刻终止队列让 routes/auth.ts 撤冷却
        console.warn(`[MAILER][发信] 永久失败(收件人侧),不再换渠道: ${summarizeMailError(cfg.name, err)}`);
        throw err; // 原样上抛,保留原错误码/堆栈给调用方
      }

      // TRANSIENT:我方侧问题,滑到下一候选继续送
      console.warn(
        `[MAILER][发信] 临时失败,滑到下一候选(位次 ${i + 1}/${queue.length}): ${summarizeMailError(cfg.name, err)}`
      );
      // 继续 for 循环
    }
  }

  // 队列耗尽全失败:把所有错误拼成一个综合错抛出
  const summary = errors.map((e) => summarizeMailError(e.channel, e.err)).join(' | ');
  console.error(`[MAILER][发信] 全军覆没(${errors.length} 条渠道全失败): ${summary}`);
  const finalErr: any = new Error(`所有送信渠道均失败喵: ${summary}`);
  finalErr.code = 'ALL_CHANNELS_FAILED';
  finalErr.allErrors = errors;
  throw finalErr;
}

/**
 * 发送注册验证码邮件(猫猫风模板)
 * 失败会抛异常,由调用方决定怎么善后喵(现有 send-verify-code 会撤冷却让用户重试)
 * P1.5:对外签名与旧版完全一致;内部已升级为多渠道按权排候选队列 + 错误分类 + 故障转移重试。
 * F.1.8:核心循环抽到 sendMailWithChannelQueue,本函数只负责组装注册场景的邮件内容。
 */
export async function sendVerifyCode(to: string, code: string): Promise<void> {
  await sendMailWithChannelQueue(
    to,
    {
      subject: `【喵咖魔法书店】您的借阅证验证码:${code}`,
      text: `您的验证码是 ${code},10分钟内有效。如果不是您本人操作,请忽略这封信喵~`,
      html: `
      <div style="max-width:480px;margin:0 auto;padding:32px;background:#FAF7F0;border-radius:24px;font-family:sans-serif;color:#5C3D2E;">
        <div style="text-align:center;font-size:40px;">🐾</div>
        <h2 style="text-align:center;color:#5C3D2E;margin:8px 0;">喵咖魔法书店</h2>
        <p style="text-align:center;opacity:0.8;">欢迎光临~这是您办理借阅证的验证码喵:</p>
        <div style="text-align:center;margin:24px 0;">
          <span style="display:inline-block;padding:12px 32px;background:#fff;border:2px dashed #5C3D2E;border-radius:16px;font-size:28px;font-weight:bold;letter-spacing:8px;">${code}</span>
        </div>
        <p style="text-align:center;font-size:13px;opacity:0.7;">验证码 10 分钟内有效,请勿告诉任何人(包括自称店长的猫)喵~</p>
        <p style="text-align:center;font-size:12px;opacity:0.5;">如果这不是您本人的操作,把这封信当作一只路过的猫,忽略即可。</p>
      </div>
    `,
    },
    '验证码'
  );
}

/**
 * F.1.8 新增 · 发送密码找回验证码邮件(猫猫风模板 + 安全提示)
 * 与 sendVerifyCode 完全并列,共用 sendMailWithChannelQueue 队列+重试+错误分类逻辑。
 * 与注册场景的差异:
 *   - subject 改成"密码找回验证码",避免与"办借阅证"文案混淆
 *   - 正文加一段"如果这不是您本人操作,可能有人在尝试盗号"的安全提示
 *   - 失败语义不变:PERMANENT 上抛让 routes/auth.ts 撤冷却,TRANSIENT 滑下一条
 */
export async function sendPasswordResetCode(to: string, code: string): Promise<void> {
  await sendMailWithChannelQueue(
    to,
    {
      subject: `【喵咖魔法书店】您的密码找回验证码:${code}`,
      text: `您的密码找回验证码是 ${code},10分钟内有效。如果这不是您本人操作,可能有人在尝试盗号,请尽快检查账号安全喵~`,
      html: `
      <div style="max-width:480px;margin:0 auto;padding:32px;background:#FAF7F0;border-radius:24px;font-family:sans-serif;color:#5C3D2E;">
        <div style="text-align:center;font-size:40px;">🔑🐾</div>
        <h2 style="text-align:center;color:#5C3D2E;margin:8px 0;">找回您的借阅证密码</h2>
        <p style="text-align:center;opacity:0.8;">这是您找回密码的验证码喵:</p>
        <div style="text-align:center;margin:24px 0;">
          <span style="display:inline-block;padding:12px 32px;background:#fff;border:2px dashed #5C3D2E;border-radius:16px;font-size:28px;font-weight:bold;letter-spacing:8px;">${code}</span>
        </div>
        <p style="text-align:center;font-size:13px;opacity:0.7;">验证码 10 分钟内有效,请勿告诉任何人(包括自称店长的猫)喵~</p>
        <div style="margin:20px 0;padding:14px 18px;background:#FFF4E0;border-left:4px solid #E8B86D;border-radius:8px;">
          <p style="font-size:12px;color:#7A5C2E;margin:0;line-height:1.6;">
            ⚠️ <strong>安全提醒</strong>:如果这不是您本人发起的找回密码请求,可能有人在尝试盗号——
            请<strong>不要</strong>把验证码告诉任何人,并尽快登录账号检查是否安全喵。
          </p>
        </div>
        <p style="text-align:center;font-size:12px;opacity:0.5;">如果您没有申请过找回密码,把这封信当作一只路过的猫,忽略即可。</p>
      </div>
    `,
    },
    '找回密码验证码'
  );
}

/**
 * 第③步验证用:拿指定渠道配置当场发一封巡检测试信,验证连通性 + 凭证有效。
 * 用全新 transporter(不走池,避免拿到改凭证前的旧缓存),用完即关防泄漏;
 * 失败抛异常,由 admin 决定标 ERROR。toOverride 为空则把测试信发给渠道账号自己喵。
 */
export async function sendTestMail(
  cfg: { name: string; host: string; port: number; user: string; pass: string },
  toOverride?: string
): Promise<void> {
  const to = toOverride && toOverride.trim() ? toOverride.trim() : cfg.user;
  const target = await resolveReal(cfg.host);
  const t = nodemailer.createTransport({
    host: target,
    port: cfg.port,
    secure: cfg.port === 465,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: { servername: cfg.host },
  });
  try {
    await t.sendMail({
      from: `"喵咖魔法书店·信使巡检" <${cfg.user}>`,
      to,
      subject: `【喵咖魔法书店】送信小猫巡检 · ${cfg.name}`,
      text: `这是一封巡检测试信喵~如果你收到了,说明渠道「${cfg.name}」工作正常,可以放心激活啦。`,
      html: `
      <div style="max-width:480px;margin:0 auto;padding:32px;background:#FAF7F0;border-radius:24px;font-family:sans-serif;color:#5C3D2E;">
        <div style="text-align:center;font-size:40px;">📮🐾</div>
        <h2 style="text-align:center;color:#5C3D2E;margin:8px 0;">送信小猫巡检</h2>
        <p style="text-align:center;opacity:0.8;">渠道「${cfg.name}」的连通性测试喵:</p>
        <div style="text-align:center;margin:24px 0;">
          <span style="display:inline-block;padding:12px 32px;background:#fff;border:2px dashed #5C3D2E;border-radius:16px;font-size:18px;font-weight:bold;">✅ 这只送信小猫工作正常</span>
        </div>
        <p style="text-align:center;font-size:13px;opacity:0.7;">收到这封信就说明授权码有效、网络通畅,回后台激活它就能上岗送信啦喵~</p>
      </div>
    `,
    });
    console.info(`[MAILER][巡检] 渠道 [${cfg.name}] 测试信已发往 ${to}`);
  } finally {
    t.close(); // 巡检用的临时 transporter,用完关掉防止连接泄漏喵
  }
}
