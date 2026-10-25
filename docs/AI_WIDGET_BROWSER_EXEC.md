# 方案 B：浏览器执行 AI 命令 — 调研结果与实现

## 1. 调研结果

### 1.1 三个编辑器的实际 API

| 编辑器 | 路径 | 技术栈 | 命令 API | 图片 API |
|--------|------|--------|----------|----------|
| **Studio** | `studio.html/js` | 自定义 WebGL | ✅ `window.Studio.setValue(key, value)` | ❌ 仅内部 |
| **PhotoCraft** | `photocraft/` | Rust→WASM (Trunk) | ❌ 无 | ✅ `window.photocraft.getImage()/setImage()` |
| **LightCraft** | `lightcraft/` | Rust→WASM | ⚠️ `command(id, params)` 747 条 | ✅ `getImage()/setImage()` |

### 1.2 PhotoCraft WASM API 调研结论

**结论：PhotoCraft WASM 不支持命令式接口。**

PhotoCraft 是 Rust + Trunk (React 框架) 编译的 WASM 应用，
`window.photocraft` 只暴露 4 个方法：

```javascript
window.photocraft = {
  hasImage: () => boolean,        // 检查是否有图片
  getImage: () => string | null,  // 获取 Base64
  getImageBlob: () => Promise<Blob | null>,
  setImage: (dataUrl) => Promise<boolean>,
  getInfo: () => object,          // 获取编辑器信息
}
```

**没有命令执行接口**，图片处理通过内部 Canvas 渲染完成。
要修改图片只能通过 `setImage()` 替换整张图（需先下载修改再上传）。

### 1.3 LightCraft WASM API 调研结论

LightCraft 有 `command(id, params)` 通用命令接口，
但从 WASM 二进制提取的命令**与图片编辑无关**，主要覆盖：

| 命名空间 | 命令数 | 说明 |
|----------|--------|------|
| `library.*` | ~20 | 图库管理（导入、浏览、筛选） |
| `item.*` | ~30 | 单张照片操作 |
| `album.*` | ~15 | 相册管理 |
| `curve.*` | 6 | 色调曲线 |
| `mask.*` | ~10 | 蒙版 |
| `export.*` | ~10 | 导出 |
| `brush.*` | 4 | 画笔工具 |
| `face.*` | ~10 | 人脸检测 |
| `segment.*` | ~5 | 物体分割 |
| `denoise.*` | ~8 | 降噪模型 |
| `filter.*` | 4 | 滤镜 |
| `print.*` | ~5 | 打印 |
| `photo.*` | ~6 | 照片管理 |
| `keyword.*` | ~8 | 关键字 |
| `preset.*` | ~6 | 预设 |
| 其他 | ~600 | UI、工具栏、语言、设置等 |

**LightCraft 是照片图库/RAW 开发工具，不是调色工具。**
其命令系统用于管理照片库、处理 RAW 文件、导出等，
不支持"调亮""加暖色调"这类实时调色命令。

### 1.4 Studio 编辑器 — 实际可用的 API

`studio.js` 是自定义 WebGL 编辑器，暴露了最完整的调整接口：

```javascript
window.Studio = {
  values: { uExposure: 0, uContrast: 0, ... },  // 当前所有参数值
  ADJUSTMENTS: [...],                               // 参数定义数组
  setValue(key, value): void,                       // 设置单个参数
  resetAll(): void,                                // 重置全部
  openFile(file): void,                            // 打开文件
  image: Image | null,                             // 当前图片
  // 蒙版相关
  mask: object,
  paint(points, opts): boolean,
  paintRect(x0, y0, x1, y1): void,
  setUseMask(on): void,
  // 面板控制
  showPage(page): void,
}
```

**支持 60+ 个调整参数**（详见 studio-prompts.ts），覆盖：
- 基础：曝光、对比度、高光、阴影、色温、白/黑点、清晰度、色调、饱和度
- 曲线：阴影/中间调/高光曲线、褪色
- HSL：全局色相/饱和/明度 + 8 种颜色分色调整
- 画质：去噪（亮度/色彩）、锐化遮罩、锐化强度
- 效果：暗角、颗粒、颗粒粗细
- 分级：8 种颜色分级 + 混合/平衡

### 1.5 关键结论

| 问题 | 答案 |
|------|------|
| PhotoCraft 支持命令 API 吗？ | ❌ 不支持，只能 setImage() |
| LightCraft 有调色命令吗？ | ❌ 没有，它是图库/RAW 工具 |
| 哪个编辑器支持浏览器执行？ | ✅ Studio（`setValue()`） |
| CLI 命令映射到编辑器吗？ | ❌ 不匹配，CLI 是自造的 |
| 需要补充多少命令？ | Studio 已支持 60+ 参数，无需补充 |

---

## 2. 方案 B 实现

### 2.1 架构

```
用户输入 → AI Widget → POST /api/parse → LLM 解析 → 返回 {key, value}[]
                ↓
        浏览器端执行：
        Studio:   window.Studio.setValue(key, value)
        PhotoCraft/LightCraft: Canvas 2D fallback
```

### 2.2 服务器端变更

新增 `POST /api/parse` 端点：
- **输入**：`{ message: string, tool: string }`
- **输出**：`{ commands: [{key, value}], explanation: string }`
- **LLM Prompt**：使用 Studio 的实际调整参数名（`uExposure`, `uContrast` 等）
- **验证**：过滤未知 key，值限制在 -1~1

文件：`apps/ai-agent-server/src/api/parse.ts`

### 2.3 前端变更

`ai-widget.js` 重写为 Plan B 模式：
1. 检测 Studio 编辑器（`window.Studio.setValue`）
2. 调用 `/api/parse`（不再上传图片）
3. 通过 `window.Studio.setValue()` 直接执行
4. Canvas 2D fallback 用于 PhotoCraft/LightCraft

### 2.4 命令映射

LLM 输出的参数直接映射到 Studio 的 `setValue()`：

```
"调亮一点" → { key: "uExposure", value: 0.15 }
"加暖色调" → { key: "uTemp", value: 0.1 }
"黑白"     → { key: "uSaturation", value: -1 }
"加清晰度" → { key: "uClarity", value: 0.3 }
```

---

## 3. 文件变更清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/core/studio-prompts.ts` | 新增 | Studio 调整参数定义 + LLM Prompt |
| `src/api/parse.ts` | 新增 | `/api/parse` 端点（仅解析，不处理图片） |
| `src/index.ts` | 修改 | 注册 parse 路由 |
| `ai-widget.js` | 重写 | Plan B 浏览器执行引擎 |

---

## 4. 下一步

1. [ ] 部署到服务器并测试
2. [ ] 优化 LLM Prompt 提高解析准确率
3. [ ] 扩展 Canvas 2D fallback 支持更多参数
4. [ ] 考虑 PhotoCraft WASM 层面的修改（需 Rust 源码）
