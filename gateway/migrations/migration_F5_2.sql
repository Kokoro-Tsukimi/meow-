-- ============================================================
-- F5.2 · Logs 表 is_stream 字段补全
-- 日期: 2026-06-22
--
-- 背景:
--   架构现状.md §3 Logs 表注明 "F.5 ALTER 漏了 is_stream 字段", 本文件补全.
--   字段语义: 从响应 Content-Type 是否包含 'text/event-stream' 推断,
--   反映"实际响应模式"而非"用户期望"(更准确的诊断信号).
--
-- 写入路径:
--   proxy.ts L761 const isStream = contentType?.includes('text/event-stream')
--   → Lua 脚本 ARGV[12] → XADD 入流
--   → worker.ts 消费 → INSERT Logs.is_stream
--   → user.ts /bills/:id/details SELECT l.is_stream → 前端 Bills.tsx 段 ③ 渲染
--
-- 默认值 FALSE:
--   非流式请求是绝大多数(单次问答场景), 默认 FALSE 与 MySQL BOOLEAN 默认行为一致.
-- ============================================================

ALTER TABLE Logs
  ADD COLUMN is_stream BOOLEAN DEFAULT FALSE COMMENT '流式响应标志(从响应 Content-Type 推断, 1=text/event-stream)';
