# 设计：视觉定位支持（画笔 / 套索 / 蒙版）

> 状态：**设计稿，未实现**。本文回答「需要像素坐标的命令能不能用」，并给出可执行方案。

## 一、结论先行

| 问题 | 答案 |
|---|---|
| 引擎支持画笔/套索吗？ | **支持**。`paint.stroke`、`select.lasso`、`select.magneticLasso` 都在 920 命令里，参数要 `points: [[x,y],…]` 像素坐标 |
| 引擎支持蒙版吗？ | **支持 33 个**，分「不需要坐标」和「需要坐标」两类 |
| 当前发送给 agent 的请求带图片吗？ | **不带**。`callHarnessAgent(task)` 只接收文本 |
| 带上图片能解决定位吗？ | **能，但当前 dsh headless CLI 没有图片入口**，需要服务端预处理 |
| sensenova 支持视觉吗？ | **支持**（已实测，见第五节） |

一句话：**命令层面早就支持，卡在「agent 看不到图」这一环。**

## 二、引擎实测能力

### 2.1 画笔 / 套索（需要像素坐标）

```jsonc
// paint.stroke — 任意笔触
{"points": [[x, y, pressure?, tiltX?, tiltY?, rotation?, timeMs?, wheel?], ...],
 "brush": { /* BrushSettings */ }}

// select.lasso — 套索路径
{"points": [[x,y], ...], "mode": "replace|add|subtract|intersect", "antiAlias": true, "feather": 0}

// select.magneticLasso — 磁性套索
{"points": [[x,y], ...],   // ≥3 个锚点，按顺序
 "width": 10,              // 跟随带宽 px
 "trace": ...}
```

### 2.2 选区（部分可自动，部分需坐标）

`select.rect`、`select.quick`（快速选择）、`select.object`（对象选择）、
`select.saveSelection` / `loadSelection`、`select.float` / `drop`、`path.toSelection`。

### 2.3 蒙版（33 个，分两级）

**不需要坐标（只需图层 id）— 现在就能接：**

| 命令 | 作用 |
|---|---|
| `layer.layerMask.revealAll` / `hideAll` | 显示全部 / 隐藏全部蒙版 |
| `layer.layerMask.delete` | 删除蒙版 |
| `layer.vectorMask.add` / `fromPath` / `edit` / `delete` / `revealAll` / `hideAll` | 矢量蒙版整套 |
| `layer.createClippingMask` / `releaseClippingMask` | 剪贴蒙版 |
| `layer.rasterize.vectorMask` | 栅格化矢量蒙版 |

**需要先有选区（间接需要坐标）：**

`layer.layerMask.revealSelection` / `hideSelection` —— 依赖当前选区，
而选区来自 `select.lasso` / `select.rect` 等。

## 三、当前链路的三处缺口

```
前端 ai-widget.js
  ├─ /api/parse  {message, tool}          ← 无图片（注释写明 "no image upload needed"）
  └─ /api/chat   {message, imageFilename} ← 有图片，服务端 uploads/ 有原图
        ↓
  ai-agent-server
    callHarnessAgent(task)                ← task 是纯文本，不含图片
        ↓
  dsh headless --json "<task>"            ← CLI 只接受文本位置参数
```

1. **parse 链路前端不传图**：悬浮球只做参数预览，设计上不含图。
2. **chat 链路有图但不给 agent**：`imageFilename` 只用于执行阶段 `doc.open`。
3. **dsh headless 无图片入口**：`--json`/positional task 都是字符串；
   虽然 `assistant/message.content` 是 block 数组（可含图片 block），
   但 CLI 没有把图片塞进任务消息的参数。

## 四、方案对比

| 方案 | 做法 | 可行性 | 评价 |
|---|---|---|---|
| A. 给 headless 加图片参数 | 改 dsh 上游，`--image <path>` | 需改 dsh 源码 | 收益最大但要维护 fork |
| B. **服务端 vision 预处理** | 先用 sensenova 看图，产出结构化文字摘要，拼进 task | **立即可做** | 推荐；不依赖 dsh 改造 |
| C. 前端 parse 也传图 | 前端上传当前画布截图 | 可行但要动前端 | 可作为 B 的补充 |

**推荐 B**：把「看图」这一步从 agent 手里拿到服务端，用一次 vision 调用换一份
「图里有什么、在哪个百分比区域」的文字摘要，再交给 agent 生成命令。

## 五、方案 B 详细设计

### 5.1 视觉摘要（新增 `src/core/vision-context.ts`）

```ts
export interface VisionSummary {
  size: { w: number; h: number }              // 像素尺寸（由 photocraft-cli info 拿）
  subject: { name: string; bbox: [number, number, number, number] }  // 0..1 百分比
  regions: Array<{ name: string; bbox: [number, number, number, number] }>
  palette: string[]                           // 主要颜色
  notes: string                               // 一句整体描述
}

export async function analyzeImage(imagePath: string): Promise<VisionSummary | null>
```

调用方式（实测可用，注意响应在 `message.reasoning`）：

```jsonc
POST {LLM_API_URL}/chat/completions
{"model": "...", "messages": [{"role":"user","content":[
  {"type":"text","text":"<结构化提问，要求只输出 JSON>"},
  {"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}
]}]}
```

要点：
- 要求模型**只输出 JSON**（`size/subject/regions/palette`），便于解析。
- 若 `finish_reason=length`（reasoning 吃满 token），需提高 `max_tokens` 并重试。
- 尺寸以 `photocraft-cli info` 为准，vision 只负责百分比位置。

### 5.2 注入 task

在 `callHarnessAgent` 增加可选参数：

```ts
callHarnessAgent(message, { imagePath?: string })
// 内部：
//   若 imagePath 存在 → analyzeImage() → 渲染成一段文字
//   追加到 task：
//   ## 图片信息（视觉分析结果）
//   - 尺寸: 100x100
//   - 主体: 卡通小猪头，区域 x 10%..90%, y 10%..90%
//   - 区域: 天空 x 0%..100%, y 0%..40% ...
//   - 请把百分比换算成像素坐标（x = 百分比 * 宽）
```

### 5.3 坐标换算与命令生成

agent 拿到百分比后需要转像素：

```
px = round(pct * width),  py = round(pct * height)
```

为避免 agent 算错，可在 task 里直接给出**换算好的关键点**（如主体中心像素坐标），
agent 只需在此基础上做偏移。

### 5.4 分级支持（先易后难）

| 级别 | 内容 | 依赖 |
|---|---|---|
| L1 | 图层/蒙版基础操作（revealAll/hideAll/delete/clippingMask） | 只需图层 id（`layer.list` 或 `photocraft-cli info`） |
| L2 | 区域级操作（选中某区域后调色/涂抹） | 视觉摘要给 bbox → `select.rect` 或 `select.object` |
| L3 | 精细路径（套索描边、画笔笔触） | 视觉摘要给轮廓 → 采样成 points（精度有限，需人工微调） |

**建议上线顺序：L1 → L2 → L3。** L1 不依赖视觉，可立即接；
L3 的坐标精度受 vision 限制，应明确告知用户「可能需手动微调」。

### 5.5 失败兜底

- vision 调用失败 → 不注入图片摘要，退化为纯文字解析（当前行为）。
- 摘要里 bbox 缺失/非法 → 丢弃该区域，只用 subject。
- 生成的 `points` 超出画布 → 裁剪到 `[0, w-1]`。

## 六、实测记录（sensenova 视觉）

```bash
# 用真实图片测试，模型正确识别「卡通小猪头」并给出百分比坐标
# 响应结构注意：内容在 message.reasoning（不是 message.content）
{"choices":[{"message":{"role":"assistant","reasoning":"...这是一张卡通风格小猪头..."},
  "finish_reason":"length"}],
 "usage":{"prompt_tokens":255,"completion_tokens":300}}
```

`prompt_tokens: 255` 说明图片被接受；`finish_reason: length` 是 `max_tokens=300`
被 reasoning 吃满，实现时需放宽到 800~1500。

## 七、风险

1. **坐标幻觉**：vision 给的 bbox 是粗略估计，L3 精细路径会偏。需在 UI 提示「可微调」。
2. **成本与延迟**：每次 chat 多一次 vision 调用（约 +3~8s、几千 tokens）。
   可缓存：同一 `imageFilename` + 相同尺寸只分析一次。
3. **无法自验证**：生成命令后是否真的选中了目标区域，需要回读结果图；
   建议加「执行后截图 + 二次 vision 校验」作为后续增强。
4. **parse 链路仍无图**：悬浮球预览只能生成不依赖坐标的命令；
   需要定位的需求应引导走 chat 链路，或前端补传画布截图。

## 八、验证方法

1. 单测：`analyzeImage()` 对样例图返回合法 `VisionSummary`。
2. 集成：`chat` 传「把小猪的鼻子涂红」→ 断言生成 `paint.stroke` 且 points 落在鼻子的 bbox 内。
3. 端到端：执行后用 `photocraft-cli info` + 截图确认改动区域命中。
4. 回归：无图片的纯文字需求（黑白/旋转）行为不变。

## 九、待决策

- 是否给 `/api/parse` 也加图片（需前端配合截图上传）。
- L3 精细路径是否值得做，还是只做到 L2（区域级）+ 提示用户手动精修。
- 是否缓存视觉摘要（按图片 hash）。
