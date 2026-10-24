# AI 组件与 PhotoCraft/LightCraft 编辑器集成设计文档

## 1. 现状分析

### 1.1 编辑器技术架构

| 编辑器 | 技术栈 | 图片暴露方式 | 集成难度 |
|--------|--------|--------------|----------|
| PhotoCraft | Rust → WASM | `window.wasmBindings` | 高 |
| LightCraft | Rust → WASM | `globalThis.lightcraft = { command }` | 中 |

### 1.2 当前问题

**AI 组件独立运行**：
- 有自己的图片上传功能（📷 按钮）
- 需要先上传图片到服务器
- 处理结果需要手动下载

**编辑器独立运行**：
- 有自己的图片处理逻辑
- 没有和 AI 组件集成的接口

**用户体验问题**：
1. 需要在编辑器和 AI 组件之间手动传递图片
2. 处理完结果需要重新导入编辑器
3. 工作流不流畅，效率低

### 1.3 当前 AI 组件功能

```
┌─────────────────────────────────────┐
│          AI 修图组件                 │
├─────────────────────────────────────┤
│  📷 上传图片                         │
│  🎨 调色 / 🖼️ 修图                  │
│  💬 输入指令                         │
│  📤 上传到服务器                     │
│  🔄 等待处理                         │
│  📥 下载结果                         │
└─────────────────────────────────────┘
```

**限制**：
- 输入框默认禁用，必须先上传图片
- 图片独立存储在服务器
- 没有和编辑器通信

---

## 2. 集成方案设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                     浏览器页面                                │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐              ┌─────────────────┐      │
│  │  PhotoCraft/    │              │  AI Widget      │      │
│  │  LightCraft     │ ◄──────────► │  (悬浮组件)      │      │
│  │  编辑器         │  集成接口     │                 │      │
│  └─────────────────┘              └─────────────────┘      │
│           │                               │                  │
│           │                               │                  │
└───────────┼───────────────────────────────┼──────────────────┘
            │                               │
            ▼                               ▼
┌─────────────────────────────────────────────────────────────┐
│                    服务器 (Cloudflare Tunnel)                 │
├─────────────────────────────────────────────────────────────┤
│  AI Agent Server                                             │
│  - /api/upload   (图片上传)                                  │
│  - /api/chat     (聊天指令)                                  │
│  - /ws           (WebSocket)                                │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 集成接口设计

#### 2.2.1 编辑器暴露的 API

```javascript
// PhotoCraft 编辑器暴露的 API
window.photocraft = {
  // 获取当前图片 (Base64)
  getImage: () => string | null,
  
  // 获取当前图片 (Blob)
  getImageBlob: () => Blob | null,
  
  // 设置图片 (Base64 或 URL)
  setImage: (data: string) => void,
  
  // 获取图片文件名
  getFileName: () => string | null,
  
  // 监听图片变化
  onImageChanged: (callback) => void,
  
  // 检查是否有图片
  hasImage: () => boolean
}

// LightCraft 编辑器暴露的 API
window.lightcraft = {
  // 通过 command API 获取/设置图片
  getImage: () => string | null,
  setImage: (data: string) => void,
  hasImage: () => boolean
}
```

#### 2.2.2 AI 组件调用流程

```
用户操作流程（自动应用方案）：
1. 在编辑器打开图片
2. 点击 AI 组件 → 自动检测编辑器类型
3. AI 组件自动获取编辑器图片并上传到服务器
4. 用户输入指令
5. AI 组件发送指令 + 图片
6. 服务器处理并返回结果
7. AI 组件自动将结果应用回编辑器（实时替换）
8. 编辑器显示处理后的图片（无需手动操作）
```

**自动应用优势**：
- 符合实时编辑器的用户体验
- 减少操作步骤
- 即时反馈处理结果
- 支持撤销（编辑器本身的撤销功能）

### 2.3 通信协议

#### 2.3.1 消息格式

```javascript
// AI 组件 → 编辑器 (获取图片)
{
  type: 'GET_IMAGE',
  id: 'unique-request-id',
  timestamp: 1234567890
}

// 编辑器 → AI 组件 (返回图片)
{
  type: 'IMAGE_DATA',
  id: 'unique-request-id',
  data: {
    base64: '...',
    fileName: 'photo.jpg',
    width: 1920,
    height: 1080
  }
}

// AI 组件 → 编辑器 (设置图片)
{
  type: 'SET_IMAGE',
  id: 'unique-request-id',
  data: {
    url: 'https://...',  // 或 base64
    fileName: 'result.jpg'
  }
}
```

#### 2.3.2 事件监听

```javascript
// 编辑器监听
window.addEventListener('ai-widget-get-image', (e) => {
  const image = window.photocraft.getImage();
  window.postMessage({
    type: 'ai-widget-image-data',
    data: { base64: image, fileName: '...' }
  }, '*');
});

// AI 组件监听
window.addEventListener('message', (e) => {
  if (e.data.type === 'ai-widget-image-data') {
    // 处理获取到的图片
  }
});
```

### 2.4 实现步骤

#### 步骤 1：编辑器添加集成接口

**PhotoCraft** (`photocraft/index.html`)：
```javascript
// 暴露 WASM bindings
window.wasmBindings = bindings;
window.wasm = wasm;

// PhotoCraft 集成 API（基于 Canvas）
window.photocraft = {
  hasImage: () => {
    const canvas = document.getElementById('photocraft_canvas');
    if (!canvas) return false;
    try { canvas.toDataURL(); return true; } catch (e) { return false; }
  },

  getImage: () => {
    const canvas = document.getElementById('photocraft_canvas');
    if (!canvas) return null;
    try { return canvas.toDataURL('image/png'); } catch (e) { return null; }
  },

  getImageBlob: () => {
    return new Promise((resolve) => {
      const canvas = document.getElementById('photocraft_canvas');
      if (!canvas) { resolve(null); return; }
      canvas.toBlob(resolve, 'image/png');
    });
  },

  setImage: (dataUrl) => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.getElementById('photocraft_canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        resolve(true);
      };
      img.onerror = (e) => reject(e);
      img.src = dataUrl;
    });
  },

  getInfo: () => ({
    type: 'photocraft',
    hasImage: window.photocraft.hasImage(),
    canvasSize: {
      width: document.getElementById('photocraft_canvas')?.width || 0,
      height: document.getElementById('photocraft_canvas')?.height || 0
    }
  })
};
```

**LightCraft** (`lightcraft/index.html`)：
```javascript
// LightCraft 集成 API（同 PhotoCraft，基于 Canvas）
window.lightcraft = {
  command,  // 原有的 command API
  hasImage: () => { /* 同 PhotoCraft */ },
  getImage: () => { /* 同 PhotoCraft */ },
  getImageBlob: () => { /* 同 PhotoCraft */ },
  setImage: (dataUrl) => { /* 同 PhotoCraft */ },
  getInfo: () => { /* 同 PhotoCraft */ }
};
```

#### 步骤 2：AI 组件添加集成逻辑

**ai-widget.js** 关键功能：

```javascript
// 1. 编辑器检测
function detectEditor() {
  if (window.photocraft?.hasImage) return 'PhotoCraft';
  if (window.lightcraft?.hasImage) return 'LightCraft';
  return null;
}

// 2. 自动获取编辑器图片
async function autoLoadEditorImage() {
  const dataUrl = await getEditorImage();
  if (!dataUrl) {
    addMsg('system', '⚠️ 无法获取图片，请手动上传');
    return;
  }
  addMsg('system', '📷 已从 ' + editorType + ' 获取图片...');
  
  // 转换为 Blob 并上传
  const blob = await (await fetch(dataUrl)).blob();
  const file = new File([blob], 'editor_image.png', { type: 'image/png' });
  await uploadFile(file);
}

// 3. 自动应用结果到编辑器
async function sendResultToEditor(resultUrl) {
  const res = await fetch(resultUrl);
  const blob = await res.blob();
  const reader = new FileReader();
  
  return new Promise((resolve) => {
    reader.onload = async () => {
      const dataUrl = reader.result;
      if (editorType === 'photocraft') {
        await window.photocraft.setImage(dataUrl);
      } else if (editorType === 'lightcraft') {
        await window.lightcraft.setImage(dataUrl);
      }
      resolve(true);
    };
    reader.readAsDataURL(blob);
  });
}

// 4. 处理完成时自动应用
async function showResult(url, commands) {
  let html = '<div>✅ 处理完成</div><img src="' + fullUrl + '">';
  
  if (editorType) {
    html += '<div>📥 正在自动应用到编辑器...</div>';
  }
  
  addMsg('bot', html);
  
  // 自动应用
  if (editorType) {
    const success = await sendResultToEditor(fullUrl);
    addMsg('system', success ? '✅ 已自动应用' : '❌ 应用失败');
  }
}

// 5. 打开面板时自动加载
btn.addEventListener('click', async () => {
  panelOpen = !panelOpen;
  
  if (panelOpen) {
    connectWS();
    const editorName = detectEditor();
    if (editorName) {
      addMsg('system', '🔗 已连接 ' + editorName);
      toolPhoto.disabled = true;  // 锁定工具选择
      toolLight.disabled = true;
      await autoLoadEditorImage();  // 自动加载
    }
    msgInput.focus();
  }
});
```

### 2.5 技术难点

| 难点 | 说明 | 解决方案 |
|------|------|----------|
| WASM API 限制 | PhotoCraft 是 Rust WASM，API 可能有限制 | 需要查看源码或文档 |
| Canvas 获取图片 | 跨域 canvas 可能无法 toDataURL | 设置 `crossOrigin` |
| 图片格式转换 | 编辑器可能使用特定格式 | 统一转换为 Base64 |
| 大图片处理 | 高清图片可能很大 | 压缩或分块传输 |
| 性能问题 | 实时获取图片可能影响性能 | 缓存或懒加载 |

### 2.6 备选方案

#### 方案 A：Canvas 截图法（简单）
```javascript
// AI 组件直接获取页面 canvas
function captureEditorCanvas() {
  const canvas = document.querySelector('canvas');
  return canvas ? canvas.toDataURL() : null;
}
```

**优点**：不需要修改编辑器代码
**缺点**：可能获取到不完整的内容

#### 方案 B：编辑器扩展接口（推荐）
```javascript
// 编辑器主动暴露 API
window.photocraft = {
  getImage: () => {...},
  setImage: () => {...}
};
```

**优点**：功能完整，控制精确
**缺点**：需要修改编辑器代码

#### 方案 C：独立模式（当前）
```javascript
// AI 组件独立上传/下载
```

**优点**：不依赖编辑器
**缺点**：用户体验差

---

## 3. 实施计划

### 阶段 1：基础集成（1-2 天）
- [ ] 编辑器暴露 `getImage()` API
- [ ] AI 组件调用 `getImage()` 获取图片
- [ ] 实现图片上传到服务器
- [ ] 测试基本流程

### 阶段 2：结果回传（1 天）
- [ ] 编辑器暴露 `setImage()` API
- [ ] AI 组件处理完成后调用 `setImage()`
- [ ] 编辑器显示处理后的图片
- [ ] 测试完整流程

### 阶段 3：优化体验（1-2 天）
- [ ] 自动检测编辑器类型
- [ ] 图片缓存机制
- [ ] 错误处理和提示
- [ ] 性能优化

### 阶段 4：完善功能（2-3 天）
- [ ] 支持多张图片
- [ ] 处理历史记录
- [ ] 批量处理
- [ ] 撤销/重做支持

---

## 4. 文件修改清单

| 文件 | 修改内容 | 优先级 |
|------|----------|--------|
| `photocraft/index.html` | 添加 `window.photocraft` API | 高 |
| `lightcraft/index.html` | 添加/完善 `window.lightcraft` API | 高 |
| `ai-widget.js` | 添加集成逻辑 | 高 |
| `DEPLOY.md` | 更新文档 | 中 |

---

## 5. 测试用例

### 5.1 PhotoCraft 集成测试
1. 打开 PhotoCraft 编辑器
2. 导入一张图片
3. 点击 AI 组件按钮
4. 验证图片已自动获取
5. 输入指令（如"调亮"）
6. 验证处理结果
7. 验证编辑器显示结果图片

### 5.2 LightCraft 集成测试
1. 打开 LightCraft 编辑器
2. 导入一张图片
3. 点击 AI 组件按钮
4. 验证图片已自动获取
5. 输入指令（如"磨皮"）
6. 验证处理结果
7. 验证编辑器显示结果图片

### 5.3 错误处理测试
1. 编辑器没有图片 → AI 组件提示先上传图片
2. 图片获取失败 → AI 组件提示错误
3. 处理失败 → AI 组件提示错误
4. 网络断开 → AI 组件提示重连

---

## 6. 风险与应对

| 风险 | 影响 | 概率 | 应对 |
|------|------|------|------|
| WASM API 限制 | 无法获取/设置图片 | 中 | 使用 Canvas 截图法 |
| 跨域问题 | 无法读取 canvas | 低 | 设置 `crossOrigin` |
| 性能问题 | 图片太大影响速度 | 中 | 压缩图片 |
| 兼容性 | 不同编辑器行为不同 | 中 | 统一接口抽象 |

---

## 7. 总结

**当前状态**：AI 组件和编辑器独立运行，需要手动传递图片

**目标状态**：AI 组件和编辑器无缝集成，一键处理

**推荐方案**：方案 B（编辑器扩展接口）

**预计时间**：3-5 天

**下一步**：
1. 查看 PhotoCraft WASM API 文档
2. 实现 `getImage()` 和 `setImage()` 接口
3. 修改 AI 组件调用编辑器 API
4. 测试完整流程
