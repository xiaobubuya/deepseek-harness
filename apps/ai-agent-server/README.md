# AI Agent Server

AI Agent Server 用于 PhotoCraft - 通过自然语言对话驱动 PhotoCraft CLI 进行照片编辑。

## 功能特性

- **自然语言理解**：用户输入中文/英文指令，自动解析为 PhotoCraft CLI 命令
- **实时反馈**：WebSocket 推送操作进度、日志和结果
- **多步骤操作**：支持"先降噪，再锐化，最后调对比度"等复合指令
- **图片管理**：上传、存储、预览处理结果
- **安全鉴权**：API Key 认证
- **自动部署**：GitHub Actions CI/CD

## 技术栈

| 组件 | 技术 |
|------|------|
| 后端 | Node.js 20+ / TypeScript |
| Web 框架 | Express 5 |
| WebSocket | ws |
| LLM | SenseNova (OpenAI 兼容) |
| 进程管理 | pm2 |
| CI/CD | GitHub Actions |

## 快速开始

### 1. 安装依赖

```bash
cd apps/ai-agent-server
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
# 编辑 .env 填写 API Key 和 LLM 配置
```

### 3. 本地开发

```bash
npm run dev
```

### 4. 构建

```bash
npm run build
```

### 5. 生产运行

```bash
npm start
```

## API 接口

### 健康检查

```bash
GET /api/health
```

### 上传图片

```bash
POST /api/upload
Content-Type: multipart/form-data
Header: X-API-Key: ***

FormData: image=@photo.jpg
```

### 发送指令

```bash
POST /api/chat
Content-Type: application/json
Header: X-API-Key: ***

{
  "message": "把天空调蓝",
  "imageFilename": "abc123.jpg"
}
```

### WebSocket 连接

```javascript
const ws = new WebSocket('ws://localhost:3000/ws?key=YOUR_API_KEY');

ws.onopen = () => {
  ws.send(JSON.stringify({
    type: 'chat',
    message: '给照片加暖色调',
    imageFilename: 'abc123.jpg'
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log(data);
};
```

## 部署到服务器

### 手动部署

```bash
# 1. 安装 Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 2. 上传代码
scp -r apps/ai-agent-server root@120.48.86.101:/opt/

# 3. 安装依赖并构建
ssh root@120.48.86.101
cd /opt/ai-agent-server
npm install
npm run build

# 4. 安装 pm2
npm install -g pm2

# 5. 启动服务
pm2 start ecosystem.config.js
pm2 save
```

### GitHub Actions 自动部署

配置 Secrets:
- `SERVER_HOST`: 120.48.86.101
- `SERVER_USER`: root
- `SERVER_PASSWORD`: your-password
- `API_KEY`: your-api-key
- `LLM_API_KEY`: your-llm-api-key

## 项目结构

```
apps/ai-agent-server/
├── src/
│   ├── index.ts              # 入口
│   ├── config.ts             # 配置
│   ├── auth.ts               # API Key 鉴权
│   ├── api/
│   │   ├── chat.ts           # 聊天接口
│   │   └── upload.ts         # 上传接口
│   ├── core/
│   │   ├── llm-parser.ts     # LLM 解析器
│   │   └── cli-executor.ts   # CLI 执行器
│   ├── websocket/
│   │   └── manager.ts        # WebSocket 管理
│   └── utils/
│       ├── logger.ts         # 日志
│       ├── file-manager.ts   # 文件管理
│       └── health.ts         # 健康检查
├── package.json
├── tsconfig.json
├── .env.example
├── ecosystem.config.js       # pm2 配置
└── README.md
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| PORT | 3000 | 服务端口 |
| NODE_ENV | development | 运行环境 |
| API_KEY | (空) | API Key 鉴权 |
| LLM_API_URL | https://token.sensenova.cn/v1 | LLM API 地址 |
| LLM_API_KEY | (空) | LLM API Key |
| LLM_MODEL | sensenova-6.8-flash-lite | LLM 模型 |
| UPLOAD_DIR | ./uploads | 上传目录 |
| PROCESSED_DIR | ./processed | 处理结果目录 |
| PHOTOCRAFT_CLI | /usr/local/bin/photocraft-cli | CLI 路径 |
| TASK_TIMEOUT | 60000 | 任务超时 (ms) |

## 可用命令

PhotoCraft CLI 支持的命令：

- `color.temperature` - 调整色温
- `color.saturation` - 调整饱和度
- `color.brightness` - 调整亮度
- `color.contrast` - 调整对比度
- `filter.warm` - 暖色调滤镜
- `filter.cool` - 冷色调滤镜
- `filter.blackwhite` - 黑白滤镜
- `sharpen` - 锐化
- `denoise` - 降噪
- `blur` - 模糊
- `resize` - 调整大小
- `crop` - 裁剪
- `rotate` - 旋转

## 许可证

MIT
