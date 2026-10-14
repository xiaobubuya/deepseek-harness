# `@deepseek-ai/dsh-warning-doris-adapter`

预警中枢的 Doris 受控适配器。它调用现有 `vcloud-lps-admin-server` 接口，不直接连接 Doris：

- `query` -> `POST /doris-skill/execute`；
- `tables` -> `GET /doris-skill/tables`；
- `tableSchema` -> `GET /doris-skill/tables/{tableName}`。

适配器通过请求头传递 Agent API Key、任务 ID 和请求 ID。SQL 只允许单条 `SELECT`，拒绝 CTE、注释和写操作，并要求包含配置的时间字段范围条件。适配器不维护本地表白名单；表发现通过 `tables`/`tableSchema` 接口完成，认证、库表权限、SQL 安全、限流、并发、超时和返回规模由 admin-server 负责。

适配器应注册到 `WarningDataCore`，通过结构化适配器边界调用。不能把 Doris 数据库账号传入 Harness，也不能让模型构造无限制 SQL。
