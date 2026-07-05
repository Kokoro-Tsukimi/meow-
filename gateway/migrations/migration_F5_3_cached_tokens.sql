-- ==========================================================
-- F5.3: Logs 表新增"缓存命中 tokens"列
-- ==========================================================
-- 语义铁律:
--   NULL = 上游未回传(奇怪渠道 / 不支持的响应形态) —— "不知道"
--   0    = 上游明确回传了零命中                    —— "知道是零"
--   两者严格分家, 图表与账单详情据此区别展示, 绝不造数喵
--
-- 老数据: 全部保持 NULL(F5.3 之前从未采集过, 诚实标注"未知")
--
-- 执行方式(powershell 根终端):
--   docker exec -i meow-gateway-mysql-1 mysql -uroot -p<密码> meow_gateway < gateway\migrations\migration_F5_3_cached_tokens.sql
--   (容器名/库名以 docker ps 与 .env 实际为准)
-- ==========================================================

ALTER TABLE Logs
  ADD COLUMN cached_tokens INT NULL DEFAULT NULL
  COMMENT 'F5.3 缓存命中tokens; NULL=上游未回传'
  AFTER prompt_tokens;
