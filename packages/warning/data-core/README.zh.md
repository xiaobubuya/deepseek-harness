# `@deepseek-ai/dsh-warning-data-core`

预警中枢的数据访问边界模块。不包含数据库驱动，也不包含 CLI。LPS、Doris、NTSDB、POPO 通过实现 `WarningDataAdapter` 并注册到 `WarningDataCore` 接入。

Core 统一负责：

- task、租户、操作者、trace、截止时间和 action grant 上下文；
- 数据源和操作白名单；
- 默认只读，显式读写权限和租户要求；
- 超时及取消信号传播；
- 最大返回规模和截断标记；
- 稳定的 `v1` 结果协议和安全错误归一化。
- 对缺失来源、失败来源、部分结果和缺少数据水位的跨源完整性评估。

Harness 插件应直接调用 `WarningDataCore.execute()`，不能启动 Shell 进程或解析 CLI 输出。传输细节由各数据源适配器负责，因此同一套 Core 可以复用真实服务客户端和测试替身。

POPO 写操作应使用带 `requiredGrant: 'popoTeam'` 的独立策略，在审批、幂等和审计能力完成前保持关闭。
