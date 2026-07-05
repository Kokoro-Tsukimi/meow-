-- ============================================================
-- F.5 · Logs 表 latency 字段重构 · 补归档迁移
-- 实际执行日期: 2026-06-21 (F.5 后端阶段, 当时直接手动 ALTER 数据库, 未归档脚本)
-- 归档补建日期: 2026-06-22 (F5.2 推进期间小诗审计发现归档缺失)
--
-- 背景:
--   F.5 可视化账单升级时, worker.ts (L82) 改用 latency_upstream_ms / latency_proxy_ms
--   两列写入, 但当时的 migration_F5.sql 只归档了 Users 三字段和 SystemSettings 表,
--   遗漏了 Logs 表的 latency 字段重构. 本文件为补归档.
--
-- 与本项目其他 migration 的关系:
--   - 早于 migration_F5.sql 执行(逻辑顺序), 实际执行日相同
--   - 与 migration_F5_2.sql 串联使用(本文件先, F5.2 后)
--
-- 幂等性注意:
--   MySQL 8 的 ALTER TABLE 不原生支持 IF EXISTS / IF NOT EXISTS 修饰 COLUMN,
--   如果本机已经执行过这次 ALTER(F.5 当时手动跑过), 重复执行会报错;
--   报错时直接跳过即可, 不影响最终 schema 状态.
--   (db-init.sql 已同步至最终 schema, 全新建库不需要跑此 migration)
-- ============================================================

ALTER TABLE Logs
  DROP COLUMN latency_ms,
  ADD COLUMN latency_upstream_ms INT DEFAULT 0 COMMENT '上游推理耗时(ms)',
  ADD COLUMN latency_proxy_ms    INT DEFAULT 0 COMMENT '网关内部开销(ms)';
