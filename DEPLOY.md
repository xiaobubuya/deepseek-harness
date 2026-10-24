# Muyaya 部署文档

## 当前架构

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户浏览器                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │                   │
                    ▼                   ▼
        ┌───────────────────┐  ┌───────────────────┐
        │  muyaya.world     │  │  120.48.86.101    │
        │  (GitHub Pages)   │  │  (百度云服务器)    │
        │  HTTPS ✅          │  │  HTTP ❌           │
        └───────────────────┘  └───────────────────┘
                    │                   │
                    │         ┌─────────┴─────────┐
                    │         │                   │
                    │         ▼                   ▼
                    │   ┌───────────┐      ┌───────────┐
                    │   │ Muyaya API│      │ AI Agent  │
                    │   │ :3001     │      │ Server    │
                    │   └───────────┘      │ :3000     │
                    │                      └───────────┘
                    │                              │
                    │                      ┌───────┴───────┐
                    │                      │               │
                    │                      ▼               ▼
                    │              ┌───────────┐   ┌───────────┐
                    │              │PhotoCraft │   │LightCraft │
                    │              │   CLI     │   │   CLI     │
                    │              └───────────┘   └───────────┘
                    │
                    └─── ⚠️ Mixed Content 阻断 ───
```

## 当前问题

### 1. Mixed Content 阻断（主要问题）

| 组件 | 协议 | 状态 |
|------|------|------|
| GitHub Pages 前端 | HTTPS | ✅ |
| 服务器 API/WebSocket | HTTP | ❌ |
| WebSocket 连接 | ws:// | ❌ 被浏览器阻止 |

**原因**：浏览器安全策略阻止 HTTPS 页面加载 HTTP 资源。

### 2. 域名备案未完成

| 域名 | DNS 指向 | 状态 |
|------|----------|------|
| muyaya.world | GitHub Pages (185.199.x.x) | ✅ 正常 |
| api.muyaya.world | 120.48.86.101 | ❌ 百度云 403 拦截 |

**原因**：域名未在百度云备案，被拦截。

## 已完成的修复

### 1. AI 悬浮组件
- `ai-widget.js` - 悬浮聊天组件
- 嵌入 PhotoCraft 和 LightCraft 编辑器页面
- 支持工具切换（调色/修图）

### 2. 同源代理支持
- nginx 配置添加 WebSocket 代理 (`/ws`)
- 前端代码支持相对 URL
- 部署工作流添加前端同步步骤

### 3. 服务器端点（待验证）

| 端点 | 用途 |
|------|------|
| `/` | 静态文件 |
| `/api/` | Muyaya API 代理 |
| `/agent/` | AI Agent 代理 |
| `/ws` | WebSocket 代理 |

## 解决方案

### 方案 A：等备案完成（推荐）

**步骤**：
1. 等待域名备案完成
2. 修改 DNS：`muyaya.world` → `120.48.86.101`
3. 配置 SSL：
```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d muyaya.world
```
4. WebSocket 启用 `wss://muyaya.world/ws`

**优点**：架构清晰，长期稳定
**缺点**：需要等待备案

---

### 方案 B：Cloudflare Tunnel（快速方案）

**步骤**：
```bash
# 服务器上安装
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
chmod +x cloudflared-linux-amd64
mv cloudflared-linux-amd64 /usr/local/bin/cloudflared

# 启动隧道
cloudflared tunnel --url http://localhost:3000 --no-autoupdate
```

**优点**：不改 DNS，不需要备案，5 分钟搞定
**缺点**：依赖第三方服务

---

### 方案 C：HTTP 轮询（临时方案）

**步骤**：
- 不用 WebSocket，改用 HTTP API + 轮询
- 前端每 2 秒轮询一次消息

**优点**：不需要任何服务器配置
**缺点**：有延迟，不是实时

## 临时测试方案

在备案完成前，可以直接访问服务器测试：

```bash
# API 健康检查
curl http://120.48.86.101:3001/api/health

# AI Agent 健康检查
curl http://120.48.86.101:3000/api/health

# AI 聊天测试
curl -X POST http://120.48.86.101:3000/api/chat \
  -H "Content-Type: application/json" \
  -H "X-API-Key: bubu" \
  -d '{"message":"测试","imageFilename":"xxx.png"}'
```

## 下一步计划

### 备案完成前
- [ ] 部署当前代码到服务器（nginx 配置更新）
- [ ] 测试 HTTP 轮询方案（可选）
- [ ] 等待域名备案完成

### 备案完成后
- [ ] 修改 DNS：`muyaya.world` → `120.48.86.101`
- [ ] 配置 SSL 证书（Let's Encrypt）
- [ ] 验证 WebSocket 连接（`wss://muyaya.world/ws`）
- [ ] 端到端测试 AI 聊天功能

## 技术栈

| 组件 | 技术 | 位置 |
|------|------|------|
| 前端 | HTML/JS | GitHub Pages |
| Muyaya API | Node.js/Express | 120.48.86.101:3001 |
| AI Agent | Node.js/Express/WS | 120.48.86.101:3000 |
| PhotoCraft CLI | Node.js/sharp | 120.48.86.101 |
| LightCraft CLI | Node.js/sharp | 120.48.86.101 |
| Nginx | Reverse Proxy | 120.48.86.101:80 |

## 部署命令

```bash
# Muyaya API
git push origin deploy-muyaya-node

# AI Agent Server
git push origin deploy-muyaya-node

# 前端
git push origin main
```

## 联系信息

- 服务器：120.48.86.101 (百度云)
- 域名：muyaya.world
- GitHub: xiaobubuya/deepseek-harness
- 前端仓库: xiaobubuya/xiaobubuya.github.io
