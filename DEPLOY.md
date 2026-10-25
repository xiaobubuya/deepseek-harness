# Muyaya 部署文档

## 当前架构

### 当前方案（Cloudflare Tunnel）

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户浏览器                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │  muyaya.world     │
                    │  (GitHub Pages)   │
                    │  HTTPS ✅          │
                    └───────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │  Cloudflare Tunnel│
                    │  (trycloudflare)  │
                    │  HTTPS ✅          │
                    └───────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │  cloudflared      │
                    │  (服务器端客户端)  │
                    └───────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │  AI Agent Server  │
                    │  120.48.86.101    │
                    │  :3000            │
                    └───────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │                   │
                    ▼                   ▼
              ┌───────────┐      ┌───────────┐
              │PhotoCraft │      │LightCraft │
              │   CLI     │      │   CLI     │
              └───────────┘      └───────────┘
```

**隧道 URL**: `https://shops-voip-storage-click.trycloudflare.com`

### 目标架构（备案完成后）

```
┌─────────────────────────────────────────────────────────────────┐
│                        用户浏览器                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌───────────────────┐
                    │  muyaya.world     │
                    │  (百度云服务器)   │
                    │  HTTPS ✅          │
                    └───────────────────┘
                              │
                    ┌─────────┴─────────┐
                    │                   │
                    ▼                   ▼
              ┌───────────┐      ┌───────────┐
              │ Muyaya API│      │ AI Agent  │
              │ :3001     │      │ :3000     │
              └───────────┘      └───────────┘
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

> ⚠️ **不在这个仓库里。** `ai-widget.js` 和它注入的两个 index.html 都在
> `xiaobubuya/xiaobubuya.github.io`（GitHub Pages 那个前端仓库）。
> 这个仓库只是被它调用的一端。别在这里找 `ai-widget.js`，也别说「这里已经修好了」。
>
> 那边有一条铁律：**PhotoCraft 的 wasm 只能从打过 patch 的源码构建，
> 上游 release 包覆盖会删掉 AI Bridge，悬浮球变成死按钮。**
> 详见前端仓库 `docs/AI_WIDGET.md`（2026-10-25 的 `d325301` 就是这么坏的，
> `dabb051` 修好的）。

### 2. 同源代理支持
- nginx 配置添加 WebSocket 代理 (`/ws`)
- 前端代码支持相对 URL
- 部署工作流添加前端同步步骤

### 3. 服务器端点（实测）

> ⚠️ 2026-10-26 实测：`muyaya.world` 的 DNS 指向 GitHub Pages
> （185.199.110.153），**不经过这台服务器的 nginx**。
> 所以下面这些反代配置虽然写进了 `/etc/nginx/sites-available/muyaya`
> （`server_name muyaya.world api.muyaya.world`），实际上没有流量进来。
> `curl http://localhost/photocraft/index.html` 在这台机器上返回 **404**。

| 实际在用的 | 端口 | 说明 |
|---|---|---|
| `muyaya.world` | —— | GitHub Pages，本仓库无关 |
| `localhost:3000/api/health` | 3000 | AI Agent Server，`{"status":"ok"}` |
| `localhost:3001/api/health` | 3001 | Muyaya API，`{"ok":true}` |
| cloudflared x2 | —— | `--url http://localhost:3000` / `:3001`，各自一个 `*.cfargotunnel.com` |

`muyaya-api` 的 `.env` 关键项：`ALLOWED_ORIGINS=https://muyaya.world,https://xiaobubuya.github.io`、
`AGENT_BASE_URL=http://127.0.0.1:3000`、`AGENT_API_KEY=bubu`。

---

## Harness CLI（`dsh`）部署

工作流：`.github/workflows/deploy-harness-cli.yml`。
已在分支 `ci/harness-cli` 验证跑绿（run `40208477416`，44 秒，commit `c0f9cc8e72`），
尚未合入 `deploy-muyaya-node`。

### 部署形态

服务器上三样东西：

```
/opt/harness-node/          Node 24.17.0 独立前缀（202MB）
/opt/harness-cli/           npm install @deepseek-ai/dsh 的产物（855MB）
/usr/local/bin/dsh          真实文件（不是 symlink），exec 上面的 Node 24
```

系统 Node 20.18.0 保持不动，ai-agent-server 和 muyaya-api 还在用它。

### 踩过的坑（都是真的，别重踩）

1. **Node 24 是必须的，不是偏好。**
   `apps/cli/src/bin.js` 用了 `import.meta.main`，这个 API 只在 Node 24.8.0+ 存在。
   Node 20 下它是 `undefined` → 整个 CLI 静默 return，`dsh --version` **空输出、exit 0**。
   不会报错，所以你只会以为「dsh 装好了」。先在 Node 20 上装完再排查输出，会浪费时间。

2. **不要去 build monorepo。**
   发布的 `@deepseek-ai/dsh` npm 包已经自带完整运行时
   （`npm install` 装 855MB、约 9 分钟）。而且本分支从未改过
   `apps/cli` / `packages` / `native` / `vendor` / `pnpm-lock.yaml` ——
   **npm 包就是本分支的构建产物**，两者等价。
   build monorepo 要多跑 pnpm install + native addon + web build，
   产出一个 700MB+ tarball 再 scp 过去，收益为零。

3. **`/usr/local/bin/dsh` 必须是真实文件，不能是 symlink。**
   `cat > 已有的symlink` 会**穿透写进目标文件**，不是替换 symlink。
   它会把你 symlink 指向的东西弄坏。old master 的做法是 symlink 到
   `/opt/ai-agent-server/harness/.bin/dsh`，就差点把那份源码改写了。

4. **名字叫 `harness` 的目录不是 `node_modules`。**
   Node 的 resolver 只会向上遍历**字面上叫 `node_modules`** 的目录。
   old master 的布局是 `/opt/ai-agent-server/harness/@deepseek-ai/dsh`
   和 `harness/@deepseek-ai/dsh-app-boot` 并排放着 —— 依赖明明就在旁边，
   CLI 也永远看不到它，报 `ERR_MODULE_NOT_FOUND: @deepseek-ai/dsh-app-boot`。
   这就是最初「包在错误位置」的那个 bug 的根因。

5. **加幂等戳。**
   `/opt/harness-cli/.dsh-version` 记录已安装版本；和 pin 的版本一致就跳过
   npm install。把一次 9 分钟的运行压到约 44 秒。

6. **workflow 的 `env:` 不会传到远端。**
   `env:` 和 step `env:` 只在 runner 上。你 `scp` 过去 `bash` 的脚本里一个都没有。
   要在脚本内部声明。

7. **只验证，不要重启。**
   `dsh` 是 ai-agent-server 每次请求时现起的子进程，换版本不需要重启它。
   重启只会白白制造一次中断。

8. **`paths:` 必须包含 workflow 自己的目录。**
   否则只改 workflow 文件的提交不会匹配任何 path，run 根本不会启动。


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

### 方案 B：Cloudflare Tunnel（当前方案 ✅）

**状态**：✅ 已部署，正常运行

**当前隧道 URL**：
```
https://shops-voip-storage-click.trycloudflare.com
```

**端点**：
- API: `https://shops-voip-storage-click.trycloudflare.com/api/health`
- WebSocket: `wss://shops-voip-storage-click.trycloudflare.com/ws?key=bubu`

**服务器端配置**：
```bash
# 安装位置
/usr/local/bin/cloudflared

# 启动命令
nohup cloudflared tunnel --url http://localhost:3000 --no-autoupdate \
  > /var/log/cloudflared.log 2>&1 &

# 查看日志
tail -f /var/log/cloudflared.log

# 重启隧道
pkill cloudflared
nohup cloudflared tunnel --url http://localhost:3000 --no-autoupdate \
  > /var/log/cloudflared.log 2>&1 &
```

**优点**：不改 DNS，不需要备案，HTTPS WebSocket
**缺点**：临时隧道，URL 可能变化，依赖第三方服务

**注意**：这是临时方案，备案完成后需要切换到方案 A

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

### 当前状态（备案完成前）

### ✅ 已完成
- [x] Cloudflare Tunnel 部署完成
- [x] 前端代码已更新（使用隧道 URL）
- [x] AI 聊天组件已更新（ai-widget.js, ai-agent.html）
- [x] 主站 API 已更新（app.js, common.js）
- [x] DEPLOY.md 文档已更新
- [x] 代码已推送到 GitHub

### ⏳ 进行中
- [ ] 等待域名备案完成

### 隧道 URL
```
https://shops-voip-storage-click.trycloudflare.com
```

### 使用隧道 URL 的文件
| 文件 | 用途 |
|------|------|
| `app.js` | 主站 API（相册、登录） |
| `common.js` | 共享 API 模块 |
| `ai-widget.js` | AI 聊天悬浮组件 |
| `ai-agent.html` | AI 聊天独立页面 |

### 备案完成后切换计划

**步骤 1：修改 DNS**
```
muyaya.world A 记录 → 120.48.86.101
```

**步骤 2：配置 SSL 证书**
```bash
# 在服务器上执行
apt install certbot python3-certbot-nginx
certbot --nginx -d muyaya.world
```

**步骤 3：停止 Cloudflare Tunnel**
```bash
pkill cloudflared
```

**步骤 4：更新前端代码**
```javascript
// 改回相对 URL 或直接域名
const API_BASE = 'https://muyaya.world';
const WS_URL = 'wss://muyaya.world/ws?key=bubu';
```

**步骤 5：验证**
- [ ] 修改 DNS：`muyaya.world` → `120.48.86.101`
- [ ] 配置 SSL 证书（Let's Encrypt）
- [ ] 停止 Cloudflare Tunnel
- [ ] 更新前端代码
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
