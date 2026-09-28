description: "通过 Agent Gateway 执行受控事故调查的长驻 Runtime profile。"
kind: "package-bundle"

# `@deepseek-ai/dsh-warning-agent`

[English](README.md) | 中文

## 概述

使用 `dsh --profile warning-agent` 启动预警中枢使用的受控 Runtime。该 profile 保留 Agent 与 workflow 核心，启动内部 Runtime 接入，并禁用 shell、filesystem、Web、动态 skill 和开放式 subagent 能力。Runtime 接入要求 Agent Gateway 提供 HMAC 签名，进程不持有生产数据源凭据。

## Runtime 配置

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `WARNING_AGENT_HOST` | `0.0.0.0` | 内部监听地址 |
| `WARNING_AGENT_PORT` | `8090` | 内部监听端口 |
| `WARNING_AGENT_SHARED_SECRET` | 空 | HMAC 密钥；为空时拒绝所有投递 |
| `WARNING_AGENT_CALLBACK_TIMEOUT_MS` | `3000` | 回调客户端超时预算 |
| `WARNING_AGENT_CALLBACK_RETRY_ATTEMPTS` | `3` | 网络错误、429、5xx 时的最大回调次数 |
| `WARNING_AGENT_CALLBACK_RETRY_BACKOFF_MS` | `250` | 回调指数退避初始毫秒数 |
| `WARNING_AGENT_GATEWAY_CALLBACK_URL` | Gateway 服务地址 | 固定的进度/结果回调地址 |
| `WARNING_AGENT_SESSION_DIR` | `/var/lib/warning-agent/sessions` | JSONL 任务投影目录 |
| `WARNING_AGENT_MAX_CONCURRENT_TASKS` | `4` | 接纳任务并发上限 |
| `WARNING_AGENT_TASK_TIMEOUT_MS` | `600000` | 单次执行总超时 |
| `WARNING_AGENT_RETENTION_MS` | `604800000` | 终态 JSONL 保留时间 |

Runtime 提供 `/health`、`/ready`、`POST /internal/warning-agent/v1/deliveries` 和任务取消接口。投递按 `taskId + revision + attempt` 去重；同一 revision 的 attempt 共享确定性 Session ID，并使用不同的 workflow ID。执行生命周期以 JSONL 追加写入挂载卷，进度和结果只回调到固定配置的 Gateway 地址。

当前 MVP 暂不包含领域查询和 POPO 插件，待 Gateway/Runtime 协议与部署基线联调完成后再开发。

## 限制

该 profile 是内部服务 Runtime，不是通用 coding agent。它不执行系统变更，也不直接访问数据源。Warning Center 是任务和最终结果的持久化事实源；Runtime JSONL 只是可恢复的本地执行投影，Gateway 保持无状态。
