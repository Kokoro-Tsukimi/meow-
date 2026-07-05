-- ============================================================
-- F.3.a 送信小猫的窝 · MailChannels 建表 migration
-- 用途:在现有 meow_gateway 库里增量建 MailChannels 表(多 SMTP 渠道管理)
-- 幂等:CREATE TABLE IF NOT EXISTS,重复跑无害;空表时 mailer 自动兜底回 .env 单例喵
-- ============================================================

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