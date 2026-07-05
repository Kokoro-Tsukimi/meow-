-- ============================================================
-- F.1.6 模型分组化 + F.1.9 昵称头像 数据库迁移
-- 创建时间:2026-06-13 周六
-- 适用版本:F.1 系列完结(v6 交接书存档点)后的现有数据库
-- ============================================================
-- 执行前提醒喵:
--   1. 强烈建议先备份:
--      docker exec meow-gateway-mysql-1 mysqldump -uroot -p<密码> meow_gateway > backup_before_F1.6.sql
--   2. 本脚本只新增表/列,不删除任何现有数据
--   3. CREATE TABLE 用了 IF NOT EXISTS,重复执行无害;但 ALTER TABLE 那两行
--      重复执行会报"Duplicate column"错误——可手动跳过那两行,或者先用
--      DESCRIBE Users; 看一下两个新列是否已经存在
-- ============================================================


-- ============ F.1.6 第一张:分组主表 ============
-- name:对外菜单名(user 在 SillyTavern 里填的 model 字段),全店唯一
-- prompt_price/completion_price:每 1M tokens 的价格,放大 10 万倍存为整数
--   例:主人填"10豆/百万 tokens" → 存 10*100000 = 1000000
-- access_mode:
--   PUBLIC    = 所有 user 都能看到(含新注册的),proxy 走动态查询,不写授权记录
--   WHITELIST = 只对在 ModelGroupGrants 里有授权记录的 user 可见
-- status:整个分组的开关(DISABLE 时所有 user 看不到、调不到)
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


-- ============ F.1.6 第二张:分组↔渠道映射(含真模型名) ============
-- 一条渠道可入多个分组(允许),但每个(group_id, channel_id, real_model_name)组合唯一
-- real_model_name:该渠道在该分组下转发给上游时使用的真实模型名
--   例:同一条硅基渠道
--       - 在 'deepseek3.2' 分组下挂 'deepseek-ai/DeepSeek-V3.2'
--       - 在 'qwen3'      分组下挂 'Qwen/Qwen3-30B'
--   两者严格隔离 —— user 调 deepseek3.2 永远只能拿到 deepseek 真模型,不能跨分组借道
-- weight:组内加权抽样权重(复用 D.1 的 Efraimidis-Spirakis 算法)
-- status:组内单条渠道的开关(DISABLE 时此条不参与抽样,不影响该渠道在其他分组里的状态)
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


-- ============ F.1.6 第三张:分组↔user 授权(仅 WHITELIST 模式生效) ============
-- PUBLIC 模式的分组不需要在此表登记,proxy 直接通过(动态查询)
-- 复合主键 + idx_user_id 加速"某 user 能看到哪些分组"的查询
CREATE TABLE IF NOT EXISTS ModelGroupGrants (
  group_id BIGINT NOT NULL,
  user_id BIGINT NOT NULL,
  granted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (group_id, user_id),
  INDEX idx_user_id (user_id)
);


-- ============ F.1.9 顺手给 Users 加两列(为下一阶段昵称头像准备) ============
-- display_name 为 NULL → 前端显示 "猫猫{id}"(SQL 用 COALESCE 兜底)
-- avatar_path 为 NULL → 前端显示默认猫猫图(静态资源,不查盘)
-- 两个字段都允许 NULL,既有 user 不需要回填,新 user 注册时也不强制填
ALTER TABLE Users 
  ADD COLUMN display_name VARCHAR(50) NULL DEFAULT NULL;       -- user 自定义昵称喵

ALTER TABLE Users 
  ADD COLUMN avatar_path VARCHAR(255) NULL DEFAULT NULL;       -- 头像文件相对路径


-- ============================================================
-- 执行完成后请验证喵:
--
--   SHOW TABLES LIKE 'ModelGroup%';
--   → 应该看到 ModelGroupChannels / ModelGroupGrants / ModelGroups 三行
--
--   DESCRIBE Users;
--   → 最下面应该多出 display_name 和 avatar_path 两行
--
--   DESCRIBE ModelGroups;
--   → 应该看到 8 列:id, name, description, prompt_price, completion_price,
--                   access_mode, status, created_at
-- ============================================================
