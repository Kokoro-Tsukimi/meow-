-- ============================================================
-- migration_F6_checkin.sql · F6 每日签到系统(CheckIns 表 + 两条配置)
-- 创建时间: 2026-06-24
-- 适用对象: S1+ 之后建库的本地实例 + G 阶段开源后按旧 db-init.sql 建库的部署者
--
-- 本次改动:
--   1. 新建 CheckIns 表(每日签到记录, UNIQUE(user_id, check_date) 防一天多签)
--   2. SystemSettings 加两条配置:
--      - checkin_enabled:        签到系统总开关(默认 true)
--      - checkin_reward_amount:  每日签到奖励咖啡豆数(默认 100, admin 可调)
--
-- 设计要点:
--   - check_date 用 DATE(店铺时区 +08:00), UNIQUE(user_id, check_date) 天然防重复签到
--   - reward_amount 快照当日实发豆数:admin 日后调整奖励额, 历史记录金额不被追溯篡改
--   - 进账走 Bills(type=TOPUP, reference_id=checkin_{uid}_{date}), 与 CDK 注册同款
--     "所有进账都留流水"的纪律; reference_id 的 UNIQUE 约束兼当签到幂等第二道闸
--   - BLACKLIST / BANNED 拒签由后端 user.ts 守门(复用 S1+ 状态机), 不在 DB 层
--
-- 幂等性提示:
--   - CREATE TABLE IF NOT EXISTS 可重复执行
--   - INSERT IGNORE 已存在的 key 不覆盖, 保护管理员手动调过的值
-- ============================================================

-- 1. 新建 CheckIns 表(每日签到记录)
CREATE TABLE IF NOT EXISTS CheckIns (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  check_date DATE NOT NULL,                              -- 签到日期(店铺时区 +08:00)
  reward_amount DECIMAL(20,5) NOT NULL,                  -- 当日实发咖啡豆数(快照当时的 checkin_reward_amount)
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_user_date (user_id, check_date)          -- 一天一签, 防重复签到喵
);

-- 2. SystemSettings 加两条签到配置(已存在的 key 不覆盖)
INSERT IGNORE INTO SystemSettings (`key`, `value`) VALUES
  ('checkin_enabled',       'true'),
  ('checkin_reward_amount', '100');
