-- ============================================================
-- migration_F7_announcements.sql · F7 公告栏(Announcements 表)
-- 创建时间: 2026-06-25
-- 适用对象: F6 之后建库的本地实例 + G 阶段开源后按旧 db-init.sql 建库的部署者
--
-- 本次改动:
--   新建 Announcements 表(店长发布、客人只读的公告)
--
-- 设计要点:
--   - content 用 TEXT(公告可能较长, 非 VARCHAR)
--   - status ENABLE/DISABLE: 下架不删, 保留历史(同 Channels/Rules 的上下架语义)
--   - created_at / updated_at: updated_at 带 ON UPDATE 自动刷新, 前端展示发布/更新时间
--   - 纯文本存储: 后端原样存, 前端只做"换行 + URL 自动链接"渲染, 不解析 Markdown(防 XSS)
--
-- 幂等性提示:
--   - CREATE TABLE IF NOT EXISTS 可重复执行
-- ============================================================

CREATE TABLE IF NOT EXISTS Announcements (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  content TEXT NOT NULL,
  status ENUM('ENABLE','DISABLE') NOT NULL DEFAULT 'ENABLE',   -- 上架/下架(下架不删, 保留历史)喵
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
