---
name: photocraft-commands
description: 查询 PhotoCraft 引擎的真实命令清单与参数规格。需要把修图需求转成 PhotoCraft 命令、或不确定某操作对应哪个命令 id 时使用。
---

# PhotoCraft 命令查询

PhotoCraft 引擎支持 920 个命令，每个命令都有严格的 id 和参数规格。
**不要凭记忆发明命令 id**，必须用下面的方式查询真实清单。

## 查询全部命令

```bash
photocraft-cli commands --json
```

返回 JSON 数组，每项字段：

- `id` — 命令 id（如 `image.adjustments.hueSaturation`）
- `label` — 人类可读名称
- `menu` — 菜单路径
- `params` — 参数规格字符串（含范围和默认值）
- `needsDocument` — 是否需要已打开文档

## 按关键词过滤

```bash
photocraft-cli commands --json --filter rotate
photocraft-cli commands --json --filter adjust
photocraft-cli commands --json --filter filter
```

## 使用规则

1. 用户需求涉及的每个操作，都要在查询结果里找到对应 `id`。
2. `params` 必须按返回的规格填写（范围、默认值、嵌套结构）。
3. 查不到对应命令时，如实说明该操作无法表达，不要编造 id。
4. 最终只输出 JSON，格式见任务说明。
