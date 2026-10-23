# AI Agent Server 设计文档

## 系统架构

```
┌─────────────────────────────────────────────────────────────┐
│                    muyaya.world (前端)                         │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ 聊天界面 │  │ 图片预览 │  │ 历史记录 │                  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                  │
│       └──────────────┼──────────────┘                        │
│                      │                                       │
│              ┌───────▼───────┐                                │
│              │  WebSocket   │                                │
│              │   Client     │                                │
│              └───────┬───────┘                                │
└──────────────────────┼────────────────────────────────────────┘
                       │
                       │ WebSocket / HTTP
                       │
┌──────────────────────▼────────────────────────────────────────┐
│                    Nginx 反向代理                               │
│                    :80 → :3000                                 │
└──────────────────────┬────────────────────────────────────────┘
                       │
┌──────────────────────▼────────────────────────────────────────┐
│              AI Agent Server (Node.js :3000)                    │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    API Layer                              │ │
│  │                                                           │ │
│  │  POST /api/chat     - 接收用户指令                         │ │
│  │  POST /api/upload   - 上传图片                             │ │
│  │  GET  /api/images   - 图片列表                             │ │
│  │  GET  /api/health   - 健康检查                             │ │
│  │  WS   /ws           - WebSocket 实时反馈                   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │                    Core Layer                             │ │
│  │                                                           │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐               │ │
│  │  │ LLM      │  │ CLI      │  │ File     │               │ │
│  │  │ Parser   │  │ Executor │  │ Manager  │               │ │
│  │  │          │  │          │  │          │               │ │
│  │  │ SenseNova│  │PhotoCraft│  │上传/存储  │               │ │
│  │  │ API调用   │  │CLI调用   │  │/预览     │               │ │
│  │  └──────────┘  └──────────┘  └──────────┘               │ │
│  └─────────────────────────────────────────────────────────┘ │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              PhotoCraft CLI (本地二进制)                   │ │
│  └─────────────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────────────┘
                       │
                       │ HTTP API
┌──────────────────────▼────────────────────────────────────────┐
│              SenseNova LLM API                                 │
│              https://token.sensenova.cn/v1                     │
│              model: sensenova-6.8-flash-lite                   │
└───────────────────────────────────────────────────────────────┘
```

## 核心模块设计

### 1. API 层（API Layer）

#### RESTful API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/chat | 接收用户指令，返回 taskId |
| POST | /api/upload | 上传图片（multipart/form-data） |
| GET | /api/images | 图片列表 |
| GET | /api/images/:id | 获取图片 |
| GET | /api/health | 健康检查 |
| WS | /ws | WebSocket 实时反馈 |

#### 认证中间件

```typescript
// API Key 鉴权
function authMiddleware(req, res, next) {
  const key = req.headers['x-api-key'];
  if (key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}
```

### 2. LLM 解析器（LLM Parser）

调用 SenseNova API，将自然语言指令解析为 PhotoCraft CLI 命令序列。

```typescript
const SYSTEM_PROMPT = `你是照片编辑助手。将用户指令转换为 PhotoCraft CLI 命令。

可用命令：
- color.temperature {value: -100~100}
- color.saturation {value: 0~200}
- color.brightness {value: -100~100}
- color.contrast {value: -100~100}
- filter.warm / filter.cool / filter.blackwhite
- sharpen {strength: 0~100}
- denoise {strength: 0~100}
- blur {radius: 1~50}
- resize {width, height}
- crop {x, y, width, height}

返回 JSON：{"commands": [{"cmd": "...", "params": {...}}], "explanation": "..."}`;
```

### 3. CLI 执行器（CLI Executor）

```typescript
async function executeCommands(commands, imagePath) {
  for (let i = 0; i < commands.length; i++) {
    const cmd = commands[i];
    await sendProgress({ step: i + 1, total: commands.length, message: `执行 ${cmd.cmd}` });
    
    const cliArgs = buildCLIArgs(cmd, imagePath);
    const result = await runWithTimeout(cliArgs, 60000);
    
    await sendLog({ level: 'info', message: result.stdout });
  }
}
```

### 4. 文件管理器（File Manager）

```
/opt/ai-agent-server/
├── uploads/          # 上传的图片
├── processed/        # 处理后的图片
├── thumbnails/       # 缩略图
├── logs/             # 日志
└── temp/             # 临时文件
```

命名规则：`{timestamp}_{randomId}.{ext}`

清理策略：每 24 小时清理 7 天前的文件。

### 5. WebSocket 管理

```typescript
type ClientMessage =
  | { type: 'chat'; message: string; imageId?: string }
  | { type: 'cancel'; taskId: string }
  | { type: 'ping' };

type ServerMessage =
  | { type: 'ack'; taskId: string }
  | { type: 'thinking'; thought: string }
  | { type: 'command'; command: string; params: object }
  | { type: 'progress'; step: number; total: number; message: string }
  | { type: 'log'; level: string; message: string }
  | { type: 'done'; resultUrl: string; commands: string[] }
  | { type: 'error'; code: string; message: string }
  | { type: 'pong' };
```

## 安全设计

### 1. API Key 鉴权
- 所有 /api/* 端点需要 X-API-Key 头
- 密钥通过环境变量注入

### 2. 文件验证
- 仅允许图片格式：jpg, jpeg, png, webp, tiff, heic
- 检查 MIME 类型和文件扩展名

### 3. 命令注入防护
- 命令白名单（仅允许已知命令）
- 参数类型验证（数值范围检查）
- 禁止危险字符（; | & $ ` \n \r）

### 4. 速率限制（可选）
- 单 IP 每分钟 100 次请求

## 项目结构

```
apps/ai-agent-server/
├── src/
│   ├── index.ts              # 入口
│   ├── config.ts             # 配置
│   ├── auth.ts               # API Key 鉴权
│   ├── api/
│   │   ├── chat.ts           # 聊天接口
│   │   ├── upload.ts         # 上传接口
│   │   └── images.ts         # 图片接口
│   ├── core/
│   │   ├── llm-parser.ts     # LLM 解析器
│   │   └── cli-executor.ts   # CLI 执行器
│   ├── websocket/
│   │   └── manager.ts        # WebSocket 管理
│   └── utils/
│       ├── logger.ts         # 日志
│       └── file-manager.ts   # 文件管理
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## CI/CD 流程

```
GitHub Push (main)
  → GitHub Actions
  → SSH 部署到 120.48.86.101
  → pm2 restart
  → 健康检查
```

### 环境变量

```env
# 服务配置
PORT=3000
NODE_ENV=production

# API 认证
API_KEY=your-secret-key-here

# LLM 配置
LLM_API_URL=https://token.sensenova.cn/v1
LLM_API_KEY=sk-xxx
LLM_MODEL=sensenova-6.8-flash-lite

# 文件存储
UPLOAD_DIR=/opt/ai-agent-server/uploads
PROCESSED_DIR=/opt/ai-agent-server/processed

# CLI 配置
PHOTOCRAFT_CLI=/usr/local/bin/photocraft-cli
TASK_TIMEOUT=60000
```

## 部署配置

### 服务器

```
百度云服务器 120.48.86.101
├── OS: Debian 10
├── CPU: 2 核
├── 内存: 4 GB
├── 磁盘: 80 GB SSD
├── 带宽: 6 Mbps
```

### pm2 配置

```javascript
module.exports = {
  apps: [{
    name: 'ai-agent-server',
    script: './dist/index.js',
    cwd: '/opt/ai-agent-server',
    instances: 1,
    autorestart: true,
    max_memory_restart: '400M',
    env: {
      NODE_ENV: 'production',
    }
  }]
}
```
