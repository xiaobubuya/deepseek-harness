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

---

# L2 区域级编辑：详细实现方案

> 本章是 5.4 中 L2 的落地设计，所有关键结论均已实测（见「实测记录」）。

## L2.1 图片怎么给模型：base64（URL 不可行）

**结论：只能用 base64 data URL，不能传 http URL。**

实测（同一模型 `sensenova-6.8-flash-lite`）：

| 传法 | 结果 |
|---|---|
| `data:image/png;base64,...` | **HTTP 200**，正确识别内容 |
| `https://picsum.photos/...`（公网 URL） | **HTTP 400** `inference request is invalid` |
| 大图 base64（1.69MB 原图 → 2.25MB base64） | **HTTP 200**，`prompt_tokens=471` |

所以「图片存起来给 URL」这条路走不通——网关不替我们拉取外部 URL。

### 为什么不用 URL（即使我们服务器已暴露静态目录）

`/uploads` 确实通过 `express.static` 暴露（`GET /uploads/x.png → 200`），
服务器也监听 `*:3000`。但模型侧不接受 URL，这个能力用不上。
**保留 URL 的价值仅在于前端预览，不用于 vision 输入。**

### base64 的体积控制

原图最大已见 1.69MB → base64 2.25MB，网关能接受，但每轮传输偏重。
做法：**先用 sharp 缩到长边 1024 再 base64**（实测 sharp v8.15.3 可用），
典型 100KB~300KB，`prompt_tokens` 仍是数百量级。

```ts
import sharp from 'sharp'

async function toVisionDataUrl(file: string, maxEdge = 1024): Promise<string> {
  const buf = await sharp(file)
    .resize({ width: maxEdge, height: maxEdge, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer()
  return `data:image/png;base64,${buf.toString('base64')}`
}
```

## L2.2 vision 调用要点（实测踩坑）

1. **`max_tokens` 必须给足**：该模型会把推理写进 `reasoning`；给 300 时
   `finish_reason=length` 且 `content` 为空。给 1500 时 `finish_reason=stop`，
   `content` 是干净 JSON。
2. **取 `message.content`**；为空时再从 `message.reasoning` 里提取 JSON（兜底）。
3. 要求「只输出 JSON」，实测返回：
   ```json
   {"subject":{"name":"pig","point":[0.5,0.5],"bbox":[0.03,0.03,0.97,0.97]}}
   ```

## L2.3 数据流

```
POST /api/chat {message, imageFilename}
  ↓
1) 取原图绝对路径（uploads/）
2) sharp 缩图 → base64 data URL
3) vision 调用 → VisionSummary {size, subject{point,bbox}, regions[]}
4) 相对坐标 × 尺寸 → 像素坐标
5) 拼进 task（图片摘要段）→ callHarnessAgent
6) agent 生成命令：
     select.object {point:[px,py]}     ← 首选：引擎自动找对象边界
     select.rect {x,y,width,height}    ← 保底
     + 后续命令（调色 / 蒙版 / 删除填充）
7) 走现有 cli-executor 执行并保存
```

## L2.4 命令选择策略

| 场景 | 首选 | 理由 |
|---|---|---|
| 主体明确（一个人/一只动物/一个物体） | `select.object {point}` | 实测 `point:[50,50]` 返回 `bounds:[31,46,38,28]`，精准命中对象 |
| 区域/背景（天空、地面） | `select.rect {x,y,width,height}` | 对象选择器不认「区域」概念 |
| 多对象 | 多次 `select.object` + `mode:"add"` | 参数支持 add/subtract/intersect |

**`select.object` 的实测结果（关键依据）**：

```bash
photocraft-cli run uploads/x.png --cmd select.object --params '{"point":[50,50]}'
# → {"bounds":[31,46,38,28],"changed":true,"selected":true}

# 接蒙版：
photocraft-cli run uploads/x.png \
  --cmd select.object --params '{"point":[50,50]}' \
  --cmd layer.layerMask.revealSelection \
  --out /tmp/obj-mask.png
# → 输出图层 bounds 同步为 [31,46,38,28]，文件 8090B → 1467B
```

注意：PNG 保存会压平图层与蒙版（`warning: 1 layer(s) flattened`），
**视觉结果正确**；需要保留图层结构时输出 `.pcraft`/`.psd`。

## L2.5 代码骨架

```ts
// src/core/vision-context.ts
export interface VisionSummary {
  size: { w: number; h: number }
  subject: { name: string; point: [number, number]; bbox: [number, number, number, number] }
  regions: Array<{ name: string; bbox: [number, number, number, number] }>
}

export async function analyzeImage(imagePath: string): Promise<VisionSummary | null>
// 内部：sharp 缩图 → base64 → chat.completions（content 优先，reasoning 兜底）
//      → JSON.parse → 校验（point 在 0..1、bbox 合法）；任何一步失败返回 null
```

```ts
// src/core/harness-agent.ts —— 增加可选入参
callHarnessAgent(message, { imagePath?: string })
// 若 imagePath 且 analyzeImage 成功：
//   task 追加：
//   ## 图片信息（视觉分析）
//   - 尺寸: 1024x768
//   - 主体: pig，中心像素 (512,384)，范围 x 30..994, y 23..745
//   - 提示：需要选区时优先用 select.object {point:[512,384]}
//          需要矩形区域时用 select.rect {x,y,width,height}
```

**注意**：不要直接把相对坐标丢给 agent 让它自己乘——实测模型换算容易错，
在服务端换算好后以「像素坐标」形式给出。

## L2.6 缓存与成本

- 按图片 `sha256` 缓存摘要（内存 LRU，TTL 24h）：同一张图多次对话只分析一次。
- 单次成本实测：`prompt_tokens≈470`、`completion_tokens≈180`（缩图后更低）。
- 延迟：一次 vision 调用约 3~8s，叠加在现有 harness 解析（~15s）之上。

## L2.7 链路限制（重要）

| 链路 | 有无图片 | 能否 L2 |
|---|---|---|
| `/api/chat` | 有（`imageFilename`，服务端有原图） | **可以** |
| `/api/parse` | **无**（前端只传 `{message, tool}`） | **不可以** |

所以 L2 只对 chat 生效。悬浮球（parse）里的定位类需求，
要么引导用户走 chat，要么前端补一张画布截图（另议）。

## L2.8 失败兜底

| 失败点 | 兜底 |
|---|---|
| sharp 缩图失败 | 直接用原图 base64 |
| vision HTTP 错误 | 不注入摘要，退化为纯文本解析（当前行为） |
| 返回非 JSON | 从 `reasoning` 提取 JSON；仍失败则丢弃摘要 |
| point/bbox 越界 | 裁剪到 `[0, w-1]` / 合法比例 |
| agent 生成的 command 参数非法 | 现有 `sanitizeCommands` 兜底 |

## L2.9 验证清单（实现后跑）

1. `analyzeImage()` 对样例图返回合法 `VisionSummary`（含 size/subject）。
2. chat：「把主体调成黑白」→ 断言先 `select.object` 再 `image.adjustments.blackWhite`。
3. chat：「把天空调蓝」→ 断言 `select.rect` 覆盖上半部。
4. 端到端：执行后 `photocraft-cli info` 确认图层 bounds ≈ 目标区域、文件大小变化合理。
5. 回归：无图片的纯文字需求行为不变；vision 失败时仍能出旧结果。

## L2.10 实测记录汇总

| 验证项 | 结果 |
|---|---|
| base64 data URL | ✅ 200，正确识图 |
| http URL | ❌ 400 `inference request is invalid` |
| 大图 base64（2.25MB） | ✅ 200，`prompt_tokens=471` |
| `max_tokens=300` | ❌ `finish_reason=length`，`content` 空 |
| `max_tokens=1500` | ✅ `finish_reason=stop`，`content` 为干净 JSON |
| `select.object {point:[50,50]}` | ✅ `bounds:[31,46,38,28]` |
| `select.object` + `revealSelection` | ✅ 输出 bounds 同步，8090B → 1467B |
| sharp 可用性 | ✅ v8.15.3 |

---

# 前端取图：直接用当前工作区画布

> 决定：对话与解析都用**当前工作区的画布**作为视觉输入，用户无需额外上传或截图。

## F.1 可行性（已确认）

`ai-widget.js` 已经在直接访问画布像素：

```js
const canvas = editorType === 'photocraft'
  ? document.getElementById('photocraft_canvas')
  : document.getElementById('lightcraft_canvas');
const ctx = canvas.getContext('2d');
const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);  // 已被使用
```

既然能 `getImageData`，就能 `toDataURL`。**不需要引擎导出命令**——
`layer.quickExportAsPng` / `layer.exportAs` 都要求 `path` 文件路径，
浏览器 wasm 环境没有文件系统，反而绕远。

## F.2 取图实现（前端）

```js
function grabWorkCanvas(maxEdge = 1024) {
  const canvas = editorType === 'photocraft'
    ? document.getElementById('photocraft_canvas')
    : document.getElementById('lightcraft_canvas');
  if (!canvas || !canvas.width || !canvas.height) return null;

  // 缩放，避免几 MB 的 base64
  const scale = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * scale));
  const h = Math.max(1, Math.round(canvas.height * scale));

  const tmp = document.createElement('canvas');
  tmp.width = w; tmp.height = h;
  try {
    tmp.getContext('2d').drawImage(canvas, 0, 0, w, h);
    return { dataUrl: tmp.toDataURL('image/png'), width: w, height: h, scale };
  } catch (e) {
    // canvas tainted（跨域图片）：退回原始上传文件
    console.warn('[AI Widget] 画布被跨域污染，改用原始文件:', e.message);
    return null;
  }
}
```

**taint 兜底**：`getImageData`/`toDataURL` 对跨域图片会抛 `SecurityError`。
本地文件加载的图片不受影响；若真被污染，退回用户上传的原始文件 byte。

## F.3 接口变更

### `/api/parse` 新增可选字段

```jsonc
POST /api/parse
{
  "message": "把主体调成黑白",
  "tool": "photocraft",
  "imageBase64": "data:image/png;base64,..."   // 新增，可选
}
```

- 有 `imageBase64` → 做 vision 摘要 → 注入 task（L2 可用）
- 无 → 走现有纯文本路径（行为不变，向后兼容）

### `/api/chat` 同样支持

`chat` 目前传 `imageFilename`（服务端 uploads 有原图）。新增可选 `imageBase64`：

| 传了 | vision 用哪张 |
|---|---|
| `imageBase64` | 优先用它（当前画布状态） |
| 仅 `imageFilename` | 服务端读 uploads 原图 |
| 都没传 | 不做 vision（现状） |

## F.4 后端处理

```ts
// /api/parse 与 /api/chat 共用
const vision = req.body.imageBase64
  ? await analyzeImageBase64(req.body.imageBase64)   // 新增：直接从 base64 分析
  : req.body.imageFilename
    ? await analyzeImage(getImagePath(req.body.imageFilename))  // 读磁盘
    : null
```

`analyzeImageBase64()` 与 `analyzeImage()` 共用同一段 vision 调用，
区别只在「先 sharp 缩图」这一步（base64 已由前端缩放，可跳过）。

## F.5 体积与限制

| 项 | 值 |
|---|---|
| express json limit | 已是 **50mb**（`express.json({ limit: '50mb' })`） |
| 前端缩放上限 | 长边 1024（约 100~300KB base64） |
| 传输方式 | JSON body 内 base64（不落盘） |

## F.6 坐标换算要对齐画布与文档尺寸

画布可能被显示缩放，**不能直接拿 canvas.width 当文档尺寸**：

- 视觉摘要给的是相对坐标（0..1），与像素尺寸无关——**天然对齐**。
- 换算成像素时用**文档真实尺寸**（`photocraft-cli info` 或前端引擎查询），
  不是 `canvas.width`。

前端若已知文档尺寸，可一并上报：

```jsonc
{ "imageBase64": "...", "docSize": { "w": 1024, "h": 768 } }
```

后端优先用 `docSize`；缺失时再查引擎。

## F.7 验证方法（前端部分）

1. 打开一张本地图片 → 调用 `grabWorkCanvas()` → 断言返回 dataUrl 且长度合理。
2. 打开一张跨域图片 → 断言不抛未捕获异常，退回 null。
3. 发 `/api/parse` 带 `imageBase64` → 断言返回的命令含 `select.object` 或 `select.rect`。
4. 不带 `imageBase64` → 断言行为与现状完全一致。
