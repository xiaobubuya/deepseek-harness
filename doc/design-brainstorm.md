# AI Agent Server 设计文档（脑暴版）

## 1. 系统架构

### 1.1 整体架构图

```
┌─────────────────────────────────────────────────────────────┐
│                     muyaya.world (前端)                        │
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ 图片上传 │  │ 聊天界面 │  │ 实时反馈 │  │ 结果预览 │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │              │              │              │         │
│       └──────────────┴──────┬───────┴──────────────┘         │
│                             │                                 │
└─────────────────────────────┼─────────────────────────────────┘
                              │ HTTP / WebSocket
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    AI Agent Server                            │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    API Layer                             │ │
│  │  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐      │ │
│  │  │Upload  │  │  Chat  │  │Health  │  │Images  │      │ │
│  │  │API     │  │  API   │  │  API   │  │  API   │      │ │
│  │  └────────┘  └────────┘  └────────┘  └────────┘      │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    Core Layer                            │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │ │
│  │  │LLM Parser   │  │CLI Executor │  │File Manager │    │ │
│  │  │             │  │             │  │             │    │ │
│  │  │通义千问      │  │PhotoCraft   │  │上传/存储    │    │ │
│  │  │指令解析      │  │CLI 执行     │  │/清理/预览   │    │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘    │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    WebSocket Layer                       │ │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐    │ │
│  │  │Connection   │  │  Message    │  │  Heartbeat  │    │ │
│  │  │  Manager    │  │   Queue     │  │    Check    │    │ │
│  │  └─────────────┘  └─────────────┘  └─────────────┘    │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │                    Infrastructure Layer                  │ │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐ │ │
│  │  │  Auth   │  │  Logger │  │ Config  │  │  Error  │ │ │
│  │  │ API Key │  │  System │  │  Mgr    │  │  Handle │ │ │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    External Services                           │
│                                                              │
│  ┌─────────────────┐  ┌─────────────────┐                  │
│  │  通义千问 API    │  │  PhotoCraft CLI  │                  │
│  │  LLM 服务       │  │  本地执行        │                  │
│  └─────────────────┘  └─────────────────┘                  │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 模块职责

| 模块 | 职责 | 依赖 |
|------|------|------|
| API Layer | 处理 HTTP 请求，路由分发 | Express, Multer |
| LLM Parser | 调用 LLM API，解析指令 | OpenAI SDK, 通义千问 |
| CLI Executor | 执行 PhotoCraft CLI | child_process |
| File Manager | 图片上传、存储、清理 | fs, sharp |
| WebSocket Layer | 实时通信管理 | ws |
| Auth | API Key 鉴权 | - |
| Logger | 日志记录 | fs |
| Config | 配置管理 | dotenv |

---

## 2. 核心流程设计

### 2.1 图片上传流程

```
客户端                          服务器
  │                              │
  │  POST /api/upload           │
  │  (multipart/form-data)       │
  │─────────────────────────────>│
  │                              │
  │                    ┌─────────┴─────────┐
  │                    │ 1. 验证文件类型     │
  │                    │ 2. 生成文件 ID     │
  │                    │ 3. 保存到 uploads  │
  │                    │ 4. 返回文件信息    │
  │                    └─────────┬─────────┘
  │                              │
  │  { filename, size, ... }     │
  │<─────────────────────────────│
```

### 2.2 聊天编辑流程

```
客户端                          服务器                         LLM              CLI
  │                              │                              │              │
  │  POST /api/chat             │                              │              │
  │  { message, imageId }       │                              │              │
  │─────────────────────────────>│                              │              │
  │                              │                              │              │
  │                              │  1. 解析指令                  │              │
  │                              │─────────────────────────────>│              │
  │                              │                              │              │
  │                              │  2. 返回命令序列              │              │
  │                              │<─────────────────────────────│              │
  │                              │                              │              │
  │  WS: { type: "thinking" }   │                              │              │
  │<─────────────────────────────│                              │              │
  │                              │                              │              │
  │                              │  3. 执行命令                  │              │
  │                              │──────────────────────────────────────────>│
  │                              │                              │              │
  │  WS: { type: "progress" }   │                              │              │
  │<─────────────────────────────│                              │              │
  │                              │                              │              │
  │                              │  4. 执行完成                  │              │
  │                              │<──────────────────────────────────────────│
  │                              │                              │              │
  │  WS: { type: "done" }       │                              │              │
  │<─────────────────────────────│                              │              │
```

### 2.3 文件清理流程

```
┌─────────────────────────────────────────────────────────────┐
│                    定时清理任务                                 │
│                                                              │
│  每 24 小时触发一次                                            │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  1. 遍历 uploads/ processed/ temp/ 目录                  │ │
│  │  2. 检查文件修改时间                                     │ │
│  │  3. 删除超过 7 天的文件                                 │ │
│  │  4. 记录清理日志                                       │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 数据库设计（脑暴）

### 3.1 是否需要数据库？

| 方案 | 优点 | 缺点 | 适用场景 |
|------|------|------|----------|
| 无数据库 | 简单、快 | 数据不持久 | MVP 阶段 |
| SQLite | 轻量、本地 | 并发差 | 小规模 |
| MongoDB | 文档型、灵活 | 需要额外服务 | 中规模 |
| PostgreSQL | 关系型、稳定 | 配置复杂 | 大规模 |

**当前选择**：无数据库（文件系统 + JSON 文件记录）

### 3.2 未来数据库表结构

```sql
-- 用户表（未来）
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 图片表
CREATE TABLE images (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  filename VARCHAR(255),
  original_name VARCHAR(255),
  size INTEGER,
  status VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 编辑任务表
CREATE TABLE edit_tasks (
  id SERIAL PRIMARY KEY,
  image_id INTEGER REFERENCES images(id),
  message TEXT,
  commands JSONB,
  status VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);
```

---

## 4. 安全设计（脑暴）

### 4.1 认证方案对比

| 方案 | 优点 | 缺点 | 复杂度 |
|------|------|------|--------|
| API Key | 简单、够用 | 无法区分用户 | ⭐ |
| JWT | 标准、灵活 | 需要用户系统 | ⭐⭐⭐ |
| OAuth 2.0 | 安全、标准 | 复杂 | ⭐⭐⭐⭐⭐ |
| Session | 传统 | 需要存储 | ⭐⭐ |

**当前选择**：API Key（简单、够用）

### 4.2 安全措施

```
┌─────────────────────────────────────────────────────────────┐
│                    安全措施                                    │
│                                                              │
│  1. API Key 鉴权                                             │
│     - 所有 API 需要 X-API-Key 头                              │
│     - Key 存储在服务端环境变量                                  │
│                                                              │
│  2. 文件类型验证                                              │
│     - 白名单：jpg, jpeg, png, webp, tiff, heic               │
│     - 检查 MIME 类型 + 文件扩展名                              │
│                                                              │
│  3. 命令注入防护                                              │
│     - 命令白名单（只允许已知命令）                              │
│     - 参数类型验证                                            │
│     - 危险字符过滤                                            │
│                                                              │
│  4. 速率限制（未来）                                          │
│     - 单 IP 每分钟 100 次请求                                  │
│     - 单 Key 每分钟 50 次请求                                  │
│                                                              │
│  5. 数据保护                                                  │
│     - 图片加密存储（未来）                                    │
│     - HTTPS 传输                                             │
│     - 定期清理用户数据                                        │
└─────────────────────────────────────────────────────────────┘
```

### 4.3 命令白名单

```typescript
const ALLOWED_COMMANDS = new Set([
  'color.temperature',    // 色温
  'color.saturation',     // 饱和度
  'color.brightness',     // 亮度
  'color.contrast',       // 对比度
  'filter.warm',          // 暖色调
  'filter.cool',          // 冷色调
  'filter.blackwhite',    // 黑白
  'sharpen',              // 锐化
  'denoise',              // 降噪
  'blur',                 // 模糊
  'resize',               // 调整大小
  'crop',                 // 裁剪
  'rotate',               // 旋转
]);
```

---

## 5. 错误处理设计（脑暴）

### 5.1 错误分类

| 错误类型 | 错误码 | 描述 | 处理方式 |
|----------|--------|------|----------|
| 认证错误 | UNAUTHORIZED | API Key 无效 | 401 |
| 请求错误 | BAD_REQUEST | 参数错误 | 400 |
| 文件错误 | FILE_ERROR | 文件格式不支持 | 400 |
| LLM 错误 | LLM_ERROR | LLM API 调用失败 | 502 |
| 命令错误 | COMMAND_ERROR | 命令不支持 | 400 |
| 执行错误 | EXECUTION_ERROR | CLI 执行失败 | 500 |
| 系统错误 | SYSTEM_ERROR | 服务器内部错误 | 500 |

### 5.2 错误处理流程

```
┌─────────────────────────────────────────────────────────────┐
│                    错误处理流程                                │
│                                                              │
│  1. 捕获错误                                                 │
│     - try-catch 包裹所有异步操作                              │
│                                                              │
│  2. 记录日志                                                 │
│     - 错误类型、消息、堆栈                                    │
│     - 请求上下文（taskId, imageId）                          │
│                                                              │
│  3. 分类处理                                                 │
│     - 认证错误 → 401                                        │
│     - 请求错误 → 400                                        │
│     - 系统错误 → 500                                        │
│                                                              │
│  4. 通知客户端                                               │
│     - HTTP API: JSON 错误响应                                │
│     - WebSocket: { type: "error", ... }                     │
│                                                              │
│  5. 恢复服务                                                 │
│     - pm2 自动重启崩溃进程                                   │
│     - 连接池自动恢复                                         │
└─────────────────────────────────────────────────────────────┘
```

### 5.3 错误响应格式

```typescript
interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

// 示例
{
  "error": {
    "code": "EXECUTION_ERROR",
    "message": "CLI execution failed: command not found",
    "details": {
      "command": "color.brightness",
      "params": { "value": 30 }
    }
  }
}
```

---

## 6. 性能优化（脑暴）

### 6.1 当前优化措施

| 优化项 | 实现 | 效果 |
|--------|------|------|
| 异步非阻塞 | async/await | 高并发 |
| 文件流处理 | fs.createReadStream | 大文件 |
| 缓存 LLM 响应 | 简单 Map 缓存 | 减少 API 调用 |
| 定期清理 | setInterval | 磁盘空间 |

### 6.2 未来优化方向

| 优化项 | 方案 | 优先级 |
|--------|------|--------|
| 数据库缓存 | Redis 缓存 LLM 响应 | 中 |
| 图片压缩 | sharp 生成缩略图 | 高 |
| CDN 加速 | 云存储 + CDN | 中 |
| 队列系统 | BullMQ 任务队列 | 低 |
| 集群模式 | pm2 cluster mode | 低 |

### 6.3 性能监控

```typescript
// 性能指标
interface PerformanceMetrics {
  // 请求指标
  requestCount: number;
  requestTime: { min: number; avg: number; max: number };
  
  // LLM 指标
  llmCallCount: number;
  llmCallTime: { min: number; avg: number; max: number };
  
  // CLI 指标
  cliExecCount: number;
  cliExecTime: { min: number; avg: number; max: number };
  
  // 系统指标
  memory: { used: number; total: number };
  cpu: { usage: number };
}
```

---

## 7. 日志设计（脑暴）

### 7.1 日志级别

| 级别 | 描述 | 示例 |
|------|------|------|
| DEBUG | 调试信息 | 函数参数、变量值 |
| INFO | 一般信息 | 请求开始、任务完成 |
| WARN | 警告信息 | 重试、降级 |
| ERROR | 错误信息 | 异常、失败 |

### 7.2 日志格式

```json
{
  "timestamp": "2026-10-24T07:30:00.000Z",
  "level": "info",
  "message": "Task completed",
  "context": {
    "taskId": "task_123",
    "imageId": "img_456",
    "commands": ["color.brightness", "sharpen"]
  }
}
```

### 7.3 日志存储

```
/opt/ai-agent-server/logs/
├── 2026-10-24.log      # 每日日志文件
├── error.log           # 错误日志
├── out.log             # pm2 stdout
└── ...
```

---

## 8. 部署架构（脑暴）

### 8.1 当前部署架构

```
┌─────────────────────────────────────────────────────────────┐
│                    百度云服务器                                │
│                    120.48.86.101                              │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  /opt/ai-agent-server/                                 │ │
│  │  ├── dist/              # 编译后的代码                  │ │
│  │  ├── node_modules/      # 依赖包                       │ │
│  │  ├── uploads/           # 上传的图片                    │ │
│  │  ├── processed/         # 处理后的图片                  │ │
│  │  ├── thumbnails/        # 缩略图                       │ │
│  │  ├── logs/              # 日志                         │ │
│  │  ├── temp/              # 临时文件                      │ │
│  │  ├── .env               # 环境变量                     │ │
│  │  └── ecosystem.config.js # pm2 配置                    │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  pm2 进程管理器                                         │ │
│  │  ├── ai-agent-server (Node.js)                         │ │
│  │  └── 自动重启、日志管理                                  │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  端口：3000 (Node.js)                                        │
└─────────────────────────────────────────────────────────────┘
```

### 8.2 生产环境架构（未来）

```
┌─────────────────────────────────────────────────────────────┐
│                    生产环境架构                                │
│                                                              │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │  CDN/CDN    │    │  负载均衡    │    │  云存储      │     │
│  │  静态资源    │    │  Nginx      │    │  图片存储    │     │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘     │
│         │                  │                  │             │
│         └──────────────────┼──────────────────┘             │
│                            ▼                                │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  应用服务器集群                                          │ │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐               │ │
│  │  │Server 1 │  │Server 2 │  │Server N │               │ │
│  │  │pm2 x4   │  │pm2 x4   │  │pm2 x4   │               │ │
│  │  └─────────┘  └─────────┘  └─────────┘               │ │
│  └────────────────────────────────────────────────────────┘ │
│                            │                                │
│                            ▼                                │
│  ┌────────────────────────────────────────────────────────┐ │
│  │  数据库 / 缓存                                          │ │
│  │  PostgreSQL + Redis                                    │ │
│  └────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

---

## 9. 测试策略（脑暴）

### 9.1 测试类型

| 类型 | 工具 | 覆盖 | 优先级 |
|------|------|------|--------|
| 单元测试 | Vitest/Jest | 核心函数 | 高 |
| 集成测试 | Supertest | API 接口 | 高 |
| E2E 测试 | Playwright | 完整流程 | 中 |
| 性能测试 | k6/Artillery | 并发性能 | 低 |

### 9.2 测试用例示例

```typescript
// LLM Parser 单元测试
describe('LLM Parser', () => {
  it('should parse simple brightness command', async () => {
    const result = await parseInstruction('调亮一点');
    expect(result.commands).toContainEqual({
      cmd: 'color.brightness',
      params: { value: 30 }
    });
  });
  
  it('should parse multiple commands', async () => {
    const result = await parseInstruction('调亮一点，然后锐化一下');
    expect(result.commands.length).toBe(2);
  });
  
  it('should return error for invalid JSON', () => {
    expect(() => parseResponse('not json')).toThrow();
  });
});

// API 集成测试
describe('Upload API', () => {
  it('should upload valid image', async () => {
    const response = await request(app)
      .post('/api/upload')
      .attach('image', 'test.jpg')
      .set('X-API-Key', 'test-key');
    expect(response.status).toBe(200);
    expect(response.body.filename).toBeDefined();
  });
  
  it('should reject invalid file type', async () => {
    const response = await request(app)
      .post('/api/upload')
      .attach('image', 'test.exe')
      .set('X-API-Key', 'test-key');
    expect(response.status).toBe(400);
  });
});
```

---

## 10. 可扩展性设计（脑暴）

### 10.1 插件化架构

```typescript
// 未来插件系统
interface Plugin {
  name: string;
  version: string;
  
  // 注册命令
  registerCommands(commands: Command[]): void;
  
  // 注册 API 路由
  registerRoutes(router: Router): void;
  
  // 生命周期
  init(): Promise<void>;
  destroy(): Promise<void>;
}

// 示例：批量处理插件
class BatchPlugin implements Plugin {
  name = 'batch';
  version = '1.0.0';
  
  registerCommands(commands: Command[]): void {
    commands.push({ cmd: 'batch.process', params: {} });
  }
  
  registerRoutes(router: Router): void {
    router.post('/batch', this.handleBatch);
  }
  
  async handleBatch(req, res) {
    // 批量处理逻辑
  }
  
  async init() {}
  async destroy() {}
}
```

### 10.2 多模型支持

```typescript
// 未来多 LLM 支持
interface LLMProvider {
  name: string;
  parseInstruction(message: string): Promise<LLMResult>;
}

class QwenProvider implements LLMProvider {
  name = 'qwen';
  // ...
}

class DeepSeekProvider implements LLMProvider {
  name = 'deepseek';
  // ...
}

// 动态切换
const providers = new Map<string, LLMProvider>();
providers.set('qwen', new QwenProvider());
providers.set('deepseek', new DeepSeekProvider());

async function parseWithProvider(providerName: string, message: string) {
  const provider = providers.get(providerName);
  return provider.parseInstruction(message);
}
```

---

## 11. 监控告警（脑暴）

### 11.1 监控指标

```typescript
// 业务指标
{
  requestCount: 1000,          // 请求总数
  successRate: 95.5,           // 成功率
  avgResponseTime: 2.3,        // 平均响应时间
  
  llmCallCount: 500,           // LLM 调用次数
  llmErrorCount: 10,           // LLM 错误次数
  avgLLMTime: 1.2,             // 平均 LLM 时间
  
  uploadCount: 200,            // 上传次数
  processCount: 300,           // 处理次数
}

// 系统指标
{
  memoryUsage: 150,            // 内存使用 (MB)
  cpuUsage: 25,                // CPU 使用率 (%)
  diskUsage: 5,                // 磁盘使用 (GB)
  activeConnections: 5,        // 活跃连接数
}
```

### 11.2 告警规则

| 指标 | 阈值 | 告警级别 | 处理方式 |
|------|------|----------|----------|
| 错误率 | > 10% | 高 | 通知管理员 |
| 响应时间 | > 10s | 中 | 检查性能 |
| 内存使用 | > 80% | 中 | 检查内存泄漏 |
| 磁盘使用 | > 90% | 高 | 清理磁盘 |
| 服务不可用 | 任何 | 紧急 | pm2 自动重启 |

---

## 12. 文档索引

| 文档 | 路径 | 说明 |
|------|------|------|
| 需求文档 | doc/requirements-brainstorm.md | 功能需求、非功能需求 |
| 设计文档 | doc/design-brainstorm.md | 架构设计、模块设计 |
| API 文档 | apps/ai-agent-server/README.md | API 使用示例 |
| 部署文档 | .github/workflows/deploy-ai-agent.yml | CI/CD 配置 |

---

**文档版本**：v1.0  
**创建日期**：2026-10-24  
**状态**：草案
