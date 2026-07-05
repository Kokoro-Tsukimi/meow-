-- ============================================================
-- migration_S1_blacklist.sql · S1+ 第二层底线安全(BLACKLIST 状态 + RPM 限制)
-- 创建时间: 2026-06-23
-- 适用对象: F.5 之后建库的本地实例 + G 阶段开源后按旧 db-init.sql 建库的部署者
--
-- 本次改动:
--   1. Users.status ENUM 加 BLACKLIST 第四态(语义见下)
--   2. SystemSettings 加两条配置:
--      - global_rpm_limit:     全站每用户每分钟请求上限(默认 5)
--      - blacklist_rpm_limit:  拉黑账号每用户每分钟请求上限(默认 2)
--
-- 状态机语义(本次新增的 BLACKLIST 与既有四态对照):
--   ACTIVE     正常会员 · 允许登录 / 允许 API / 允许福利
--   ARREARS    欠费会员 · 允许登录 / 数据面靠余额=0 拦 / 允许福利(欠费提示后续走 user 端)
--   BLACKLIST  拉黑账号 · 允许登录 / 允许 API 但 RPM 降为 blacklist_rpm_limit / 拒福利
--   BANNED     违规账号 · 拒登录 / 拒 API / 拒福利
--
-- 设计要点:
--   BLACKLIST 是"能用但不能滥用"的中间态——拉黑账号贩子的拒收成本极高,
--   既能阻断薅羊毛,又避免直接封号导致的"换号继续"猫鼠游戏。
--
-- 幂等性提示:
--   - ALTER ENUM 改 column 可重复执行,MySQL 不会报错(同 schema 无操作)
--   - INSERT IGNORE 已存在的 key 不会覆盖,管理员手动改过的值保留
-- ============================================================

-- 1. Users.status 加 BLACKLIST 第四态
ALTER TABLE Users
  MODIFY COLUMN status ENUM('ACTIVE','BANNED','ARREARS','BLACKLIST') NOT NULL DEFAULT 'ACTIVE';

-- 2. SystemSettings 加两条 RPM 配置(已存在的 key 不覆盖,保护管理员手动调过的值)
INSERT IGNORE INTO SystemSettings (`key`, `value`) VALUES
  ('global_rpm_limit',    '5'),
  ('blacklist_rpm_limit', '2');
