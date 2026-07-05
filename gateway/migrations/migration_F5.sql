-- ============================================================
-- F5 · 可视化账单升级 · 数据库迁移
-- 日期: 2026-06-21
-- 内容:
--   1) 新建 SystemSettings 表 + 初始两条配置 (admin 总闸 / 货架 MB)
--   2) Users 表加诊断模式三字段 (开关 / TTL / 到期时刻)
-- ============================================================

-- 1. SystemSettings: admin 端可调的系统级 key-value 配置
CREATE TABLE IF NOT EXISTS SystemSettings (
  `key`        VARCHAR(64)  NOT NULL PRIMARY KEY,
  `value`      VARCHAR(255) NOT NULL,
  `updated_at` DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='系统级 key-value 配置(管理员可调)';

-- 2. SystemSettings 初始两条数据 (INSERT IGNORE: 已存在的 key 不覆盖,保护管理员手动改过的值)
INSERT IGNORE INTO SystemSettings (`key`, `value`) VALUES
  ('debug_cache_enabled',         'true'),
  ('debug_cache_per_user_max_mb', '20');

-- 3. Users 表加诊断模式三字段 (一条 ALTER 合并三 ADD,原子性)
ALTER TABLE Users
  ADD COLUMN debug_mode_enabled     BOOLEAN  NOT NULL DEFAULT FALSE COMMENT '诊断模式开关',
  ADD COLUMN debug_mode_ttl_minutes INT      NOT NULL DEFAULT 30    COMMENT '缓存时长(分钟),10-120 范围在后端校验',
  ADD COLUMN debug_mode_expires_at  DATETIME NULL     DEFAULT NULL  COMMENT '诊断模式到期时间(开启时刻 + ttl_minutes)';
