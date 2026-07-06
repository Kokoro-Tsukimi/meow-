CREATE TABLE IF NOT EXISTS Users (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  balance DECIMAL(20,5) NOT NULL DEFAULT 0,
  status ENUM('ACTIVE','BANNED','ARREARS','BLACKLIST') NOT NULL DEFAULT 'ACTIVE',
  group_id INT NOT NULL DEFAULT 1,
  remark VARCHAR(255) NULL DEFAULT NULL,  -- 店长的小本本备注,用户自己看不到喵
  display_name VARCHAR(50) NULL DEFAULT NULL,             -- F1.9 用户自定义昵称;NULL=前端显示"猫猫{id}"喵
  avatar_path VARCHAR(255) NULL DEFAULT NULL,             -- F1.9 头像文件相对路径;NULL=默认猫猫图
  debug_mode_enabled BOOLEAN NOT NULL DEFAULT FALSE,           -- F.5 诊断模式开关(用户级), proxy 三条件守门第二条喵
  debug_mode_ttl_minutes INT NOT NULL DEFAULT 30,              -- F.5 缓存时长(分钟), 后端校验 10-120 范围
  debug_mode_expires_at DATETIME NULL DEFAULT NULL,            -- F.5 诊断窗口到期时刻
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Bills (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  type ENUM('CONSUME','TOPUP','REFUND') NOT NULL,
  amount DECIMAL(20,5) NOT NULL,
  balance_after DECIMAL(20,5),
  reference_id VARCHAR(255),
  model VARCHAR(255),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_reference (reference_id)
);

CREATE TABLE IF NOT EXISTS RedeemCodes (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(255) NOT NULL UNIQUE,
  amount DECIMAL(20,5) NOT NULL,
  status ENUM('UNUSED','USED') NOT NULL DEFAULT 'UNUSED',
  used_by BIGINT,
  used_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Tokens (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  name VARCHAR(255),
  token VARCHAR(255) NOT NULL UNIQUE,
  quota DECIMAL(20,5) NOT NULL DEFAULT -1,
  used_quota DECIMAL(20,5) NOT NULL DEFAULT 0,
  status ENUM('ENABLE','DISABLE','EXPIRED') NOT NULL DEFAULT 'ENABLE',
  ip_whitelist JSON,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS Channels (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  base_url VARCHAR(500) NOT NULL,
  api_key_encrypted VARCHAR(1000) NOT NULL,
  models JSON,
  weight INT NOT NULL DEFAULT 1,
  priority INT NOT NULL DEFAULT 1,
  owner_user_id BIGINT NULL DEFAULT NULL,  -- NULL=公共渠道;填user_id=该用户的专属书架喵
  status ENUM('ENABLE','DISABLE','ERROR') NOT NULL DEFAULT 'ENABLE',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ============ F.1.6 模型分组三张表 ============
-- ModelGroups: 分组主表 —— name=对外菜单名(客人调 API 时填的 model 字段,全店唯一)
--   价格为每 1M tokens 单价,放大 10 万倍存整数(例:10豆/百万 → 1000000)
--   access_mode: PUBLIC=全员可见(动态放行,不写授权记录) / WHITELIST=仅授权用户可见
CREATE TABLE IF NOT EXISTS ModelGroups (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL UNIQUE,
  description VARCHAR(255) NULL DEFAULT NULL,
  prompt_price BIGINT NOT NULL DEFAULT 0,         -- 每 1M tokens 入价(放大10万倍)
  completion_price BIGINT NOT NULL DEFAULT 0,     -- 每 1M tokens 出价(放大10万倍)
  access_mode ENUM('PUBLIC','WHITELIST') NOT NULL DEFAULT 'WHITELIST',
  status ENUM('ENABLE','DISABLE') NOT NULL DEFAULT 'ENABLE',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_status_mode (status, access_mode)
);

-- ModelGroupChannels: 分组↔渠道映射 —— real_model_name=该渠道在该分组下转发给上游的真模型名
--   同一渠道可入多个分组,分组间严格隔离喵;weight=组内加权抽样权重(Efraimidis-Spirakis)
CREATE TABLE IF NOT EXISTS ModelGroupChannels (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  group_id BIGINT NOT NULL,
  channel_id BIGINT NOT NULL,
  real_model_name VARCHAR(100) NOT NULL,          -- 该渠道在该分组下的真模型名
  weight INT NOT NULL DEFAULT 1,
  status ENUM('ENABLE','DISABLE') NOT NULL DEFAULT 'ENABLE',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_group_channel_model (group_id, channel_id, real_model_name),
  INDEX idx_group_id (group_id),
  INDEX idx_channel_id (channel_id)
);

-- ModelGroupGrants: 分组↔用户授权(仅 WHITELIST 模式需要登记)
CREATE TABLE IF NOT EXISTS ModelGroupGrants (
  group_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, user_id),
  INDEX idx_user_id (user_id)
);

CREATE TABLE IF NOT EXISTS Logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  trace_id VARCHAR(255) NOT NULL UNIQUE,
  user_id BIGINT NOT NULL,
  channel_id BIGINT,
  model VARCHAR(255),
  prompt_tokens INT DEFAULT 0,
  cached_tokens INT NULL DEFAULT NULL,                   -- F5.3: 缓存命中tokens; NULL=上游未回传(与 0=明确零命中 严格分家)
  completion_tokens INT DEFAULT 0,
  cost DECIMAL(20,5) DEFAULT 0,
  status_code INT DEFAULT 200,
  latency_upstream_ms INT DEFAULT 0,                     -- F.5: 上游推理耗时(ms)
  latency_proxy_ms INT DEFAULT 0,                        -- F.5: 网关内部开销(ms, 鉴权/分组/SSE 透传等)
  is_stream BOOLEAN DEFAULT FALSE,                       -- F5.2: 流式响应标志(从响应 Content-Type 推断)
  is_estimated BOOLEAN NOT NULL DEFAULT FALSE,           -- F5.4: 估算账单标记(TRUE=客人断连、按已发字符估 tokens; FALSE=拿到真实 usage)
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ModelRates (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  model_name VARCHAR(255) NOT NULL,
  channel_id BIGINT NOT NULL DEFAULT 0,        -- 0 表示通用定价(对所有渠道生效)
  prompt_price BIGINT NOT NULL DEFAULT 0,      -- 输入单价/1k tokens (放大10万倍的整数)
  completion_price BIGINT NOT NULL DEFAULT 0,  -- 输出单价/1k tokens (放大10万倍的整数)
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_model_channel (model_name, channel_id)
);

CREATE TABLE IF NOT EXISTS Rules (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  rule_type ENUM('BLACKLIST','SHADOW','DRYRUN') NOT NULL,  -- 黑名单=拒之门外 / 影子=偷偷记小本本 / DRYRUN=端到店长面前等裁决喵
  match_conditions JSON,
  status ENUM('ENABLE','DISABLE') NOT NULL DEFAULT 'ENABLE',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS MailChannels (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,                                                          -- 渠道显示名(如"QQ小号主力")喵
  host VARCHAR(255) NOT NULL,                                                          -- SMTP主机(如smtp.qq.com)
  port INT NOT NULL DEFAULT 465,                                                       -- 465=SSL / 587=STARTTLS,与mailer.ts的secure判断一致
  `user` VARCHAR(255) NOT NULL,                                                        -- 登录账号兼发信人(user是MySQL保留词,故加反引号)喵
  pass VARCHAR(255) NOT NULL,                                                          -- 授权码/密码(前端遮罩;当前明文同api_key,开源前一起加密)
  status ENUM('UNVERIFIED','INACTIVE','ACTIVE','ERROR') NOT NULL DEFAULT 'UNVERIFIED', -- 仅ACTIVE参与加权选信;验证成功落INACTIVE等店长激活喵
  weight INT NOT NULL DEFAULT 1,                                                       -- P1加权随机权重(Efraimidis-Spirakis,复用proxy算法)
  priority INT NOT NULL DEFAULT 1,                                                     -- 预留(与Channels对称,P1暂不参与选信)
  group_name VARCHAR(255) NULL DEFAULT NULL,                                           -- 预留:P2双层抽样分组,P1留空
  last_verified_at DATETIME NULL DEFAULT NULL,                                         -- 最近一次验证成功时间
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS CheckIns (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  check_date DATE NOT NULL,                              -- F6 签到日期(店铺时区 +08:00)喵
  reward_amount DECIMAL(20,5) NOT NULL,                  -- F6 当日实发咖啡豆数(快照当时的 checkin_reward_amount)
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_date (user_id, check_date)          -- F6 一天一签, 防重复签到喵
);

CREATE TABLE IF NOT EXISTS Announcements (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,                                       -- F7 公告正文(纯文本)
  status ENUM('ENABLE','DISABLE') NOT NULL DEFAULT 'ENABLE',   -- F7 上架/下架(下架不删)喵
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- F.5: 系统级 key-value 配置(admin 端可调)
CREATE TABLE IF NOT EXISTS SystemSettings (
  `key`        VARCHAR(64)  NOT NULL PRIMARY KEY,
  `value`      VARCHAR(255) NOT NULL,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统级 key-value 配置(管理员可调)';

-- F.5: SystemSettings 初始两条配置(已存在的不覆盖, 保护管理员手动改过的值)
INSERT IGNORE INTO SystemSettings (`key`, `value`) VALUES
  ('debug_cache_enabled',         'true'),
  ('debug_cache_per_user_max_mb', '20'),
  ('global_rpm_limit',            '5'),
  ('blacklist_rpm_limit',         '2'),
  ('checkin_enabled',             'true'),
  ('checkin_reward_amount',       '100');