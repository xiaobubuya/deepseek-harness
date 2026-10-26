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
                    │ Cloudflare Tunnel │
                    │ ai.muyaya.world   │
                    │ 命名隧道（永久）  │
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

**隧道地址**: `https://ai.muyaya.world`（命名隧道，2026-10-27 起）

> 旧文档这里写的是 `shops-voip-storage-click.trycloudflare.com`。
> 那是**匿名隧道**，每次 `cloudflared` 重启就换域名，所以早就失效了——
> 前端写死它，就成了「悬浮球显示已断开」的直接原因。

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

### 1. Mixed Content 阻断（已解决）

| 组件 | 协议 | 状态 |
|------|------|------|
| GitHub Pages 前端 | HTTPS | ✅ |
| `ai.muyaya.world`（经隧道） | HTTPS / WSS | ✅ 2026-10-27 起 |
| 服务器 API/WebSocket 直连 | HTTP | ⚠️ 仍不可用，但已经不依赖它 |

**原因**：浏览器安全策略阻止 HTTPS 页面加载 HTTP 资源。

**为什么现在不是问题**：前端只跟 `https://ai.muyaya.world` 说话，
由 Cloudflare 边缘终结 TLS，隧道是服务器主动外连，链路全程 HTTPS/WSS。
**不要再往代码里写 `http://120.48.86.101`。**

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
| `ai.muyaya.world` | —— | Cloudflare → 命名隧道 `muyaya-ai` → `:3000`，systemd 托管 |
| `localhost:3000/api/health` | 3000 | AI Agent Server，`{"status":"ok"}` |
| `localhost:3001/api/health` | 3001 | Muyaya API，`{"ok":true}` |
| cloudflared（旧，待清理） | —— | 两个匿名隧道进程，一个指 `:3000`、一个指 `:3001` |

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

### 方案 B：Cloudflare 命名隧道（当前方案 ✅）

**状态**：✅ 2026-10-27 部署，systemd 托管，开机自启

**地址**：`https://ai.muyaya.world`
**端点**：`/api/health`、`/api/parse`、`/ws?key=bubu`（WSS 可用）

| 项 | 值 |
|---|---|
| 隧道名 / id | `muyaya-ai` / `89c07fac-0db4-463e-8e01-dddee0f2cc94` |
| 配置 | `/etc/cloudflared/config.yml` |
| 凭据 | `/root/.cloudflared/cert.pem`、`/root/.cloudflared/89c07fac-….json` |
| 服务 | `systemctl status cloudflared` |

`/etc/cloudflared/config.yml`：

```yaml
tunnel: 89c07fac-0db4-463e-8e01-dddee0f2cc94
credentials-file: /root/.cloudflared/89c07fac-0db4-463e-8e01-dddee0f2cc94.json

ingress:
  - hostname: ai.muyaya.world
    service: http://localhost:3000
  - service: http_status:404
```

为什么这样能绕开备案：`muyaya.world` 的 NS 在 Cloudflare，橙云代理后流量
终点是 CF 边缘，隧道是服务器**主动外连**，没有入站连接打到百度云 IP。
`api.muyaya.world` 是 DNS 直指 `120.48.86.101`，才会被以「未备案」403。

#### 授权流程（一次性，踩过的坑）

```bash
cloudflared tunnel login        # 打印一个 dash.cloudflare.com/argotunnel 链接
```

- 链接里的 callback 是 **Cloudflare 自己的** `login.cloudflareaccess.org`，
  不是 `localhost`，所以在任意电脑的浏览器点都行，不需要端口转发。
- **必须在链接有效期内点完**（约 10 分钟）。等太久这个进程会超时退出，
  并提示「浏览器会下载证书，请手动放到 `/root/.cloudflared/cert.pem`」——
  实测那次浏览器并没有真的下载，白等 45 分钟。超时就重新生成，别猜。
- 成功后 `/root/.cloudflared/cert.pem` 出现（约 282 字节，开头
  `-----BEGIN ARGO TUNNEL TOKEN-----`）。

```bash
cloudflared tunnel create muyaya-ai
cloudflared tunnel route dns muyaya-ai ai.muyaya.world
cloudflared service install          # 生成 systemd unit，读 /etc/cloudflared/config.yml
systemctl enable --now cloudflared
```

验证（两条都要看，缺一条说明链路有问题）：

```bash
curl -s https://ai.muyaya.world/api/health          # → {"status":"ok"}
curl -i  https://ai.muyaya.world/ws?key=bubu \
     -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ=="
# → HTTP/1.1 101 Switching Protocols
```

> 本机 DNS 缓存可能比公共 DNS 慢几分钟。验证时如果解析不到，
> 用 `--resolve ai.muyaya.world:443:<CF边缘IP>` 绕过本地解析器，别误判成隧道坏了。

**优点**：地址永久稳定，不改 DNS，不需要备案，HTTPS + WSS
**缺点**：依赖 Cloudflare；隧道挂了整条 AI 链路就断

**注意**：这是长期方案，不是临时补丁。备案完成后**也没有必要**切回方案 A。

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

### 隧道地址

```
https://ai.muyaya.world
```

### 各文件当前写死的是哪个后端地址（2026-10-27 实测）

| 文件 | 写死的地址 | 状态 |
|------|------------|------|
| `ai-widget.js:20` | `https://ai.muyaya.world` | ✅ 已修好 |
| `app.js:20` | `https://main-lawsuit-sewing-pregnancy.trycloudflare.com` | ❌ 死（10-25 09:49 关掉的旧匿名隧道） |
| `common.js:12` | 同上 | ❌ 死 |
| `ai-agent.html:181` | `https://shops-voip-storage-click.trycloudflare.com` | ❌ 死 |
| `share.js:13` | `https://api.muyaya.world` | ❌ 403（DNS 直指服务器，未备案） |

**注意**：`app.js` 的 `PROD_API` 只在 `location.hostname` 不是本地时生效，
且**没有 fallback**。所以线上 `muyaya.world` 的登录/相册接口现在是断的——
这不是新问题，是同一个「写死匿名隧道地址」的根因，只是没人报过。
要修就是把四处都换成 `https://ai.muyaya.world`（`share.js` 同理），
换完必须实测登录、取图、分享、AI 对话四条链路。

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
# 前端（GitHub Pages，30~60 秒生效）
git push origin main

# 下面这条会同时触发两个工作流，不要无脑推
git push origin deploy-muyaya-node
```

⚠️ 推 `deploy-muyaya-node` 会触发 `deploy-ai-agent.yml` **和**
`deploy-muyaya-api-node.yml`。后者没有 `paths` 过滤、缺 `concurrency`
和 `timeout-minutes`，历史表现是约 2h20m 后失败（失败点在 frontend sync，
在 `pm2 delete muyaya-api` 之前，所以没伤到生产）。见「未完成事项 1」。

⚠️ **`/api/parse` 目前不在 CI 覆盖范围内。** 服务器上的 `ai-agent-server`
是手工部署的，推 `deploy-muyaya-node` 只会用**该分支上的源码**重新构建部署。
`ci/harness-cli` 还没合进去，所以在合并之前，推 `deploy-muyaya-node`
会把这个手工部署的 `/api/parse` **覆盖掉**。合并前别推这条分支。

## 联系信息

- 服务器：120.48.86.101 (百度云)
- 域名：muyaya.world
- GitHub: xiaobubuya/deepseek-harness
- 前端仓库: xiaobubuya/xiaobubuya.github.io

---

## 未完成事项（2026-10-26 关门前记的）

都是明确知道有问题、但这次没动的。按优先级排。

### 1. `ci/harness-cli` 还没合进 `deploy-muyaya-node`

- `deploy-harness-cli.yml` 已在 `ci/harness-cli` 验证跑绿：run `40208477416`，44 秒，
  commit `c0f9cc8e72`。分支 HEAD 现在 `1c5603a524`。
- 阻塞原因：同分支的 `deploy-muyaya-api-node.yml` 的 `on: push` 只写了
  `branches: [deploy-muyaya-node]`，**没有 `paths`**。合入那一刻就会触发它。
- 那个工作流还缺 `concurrency` 和 `timeout-minutes`。历史表现：约 2h20m 后失败，
  失败点在 frontend sync（tar/gzip），位置在 `pm2 delete muyaya-api` **之前**，
  所以历史上没伤到生产。但不该靠这个赌。
- 建议顺序：先给它加 `paths`（`muyaya-api-node/**`、`muyaya-web/**`、
  `.github/workflows/deploy-muyaya-api-node.yml`），再加 `concurrency`，
  最后合 `ci/harness-cli`。

### 2. `/api/parse` 已手工部署，但仍未走 CI

commit `7ee651c070`。`apps/ai-agent-server/src/api/parse.ts` +
`src/core/studio-prompts.ts` + `index.ts` 路由注册。

- ✅ 2026-10-27 已部署到服务器并实测通过：
  `POST /api/parse`（`X-API-Key: bubu`，`{"message":"变成黑白的","tool":"photocraft"}`）
  → `{"commands":[{"key":"uSaturation","value":-1}],...}`；不带 key → 401。
- ⚠️ **是手工部署的，不是 CI。** 服务器 `/opt/ai-agent-server` 不是 git 仓库，
  做法是上传两个 `.ts`、在 `src/index.ts` 插两行、装 `typescript@5.8.3`、
  `npx tsc`、`pm2 restart ai-agent-server`。
  回滚点：`dist.bak-20261027-001238`、`src/index.ts.bak-20261027-001238`、
  `package.json.bak-20261027-001238`。
  线上内容和仓库 commit 一致，但**没有 CI 保证以后也一致**——接上 CI 之前别手改。
- LightCraft 和 PhotoCraft 目前共用同一份 `STUDIO_SYSTEM_PROMPT`，
  LightCraft 专属提示词没写。`parse.ts` 里的 `cliTool` 只用在日志和返回值里。
- 行为细节：值钳到 `[-1, 1]`；`ALL_STUDIO_KEYS` 之外的 key 静默丢弃（不报错）。
- 注意 `parse.ts` 自己的 JSON 解析是包了 try/catch 的，
  下面第 4 条那个裸 `SyntaxError` 只存在于 `llm-parser-fallback.ts`。
- ❗ **返回值用的是带 `u` 前缀的键**（`uExposure`/`uSaturation`/`uTemp`/`uHslSat`…），
  前端 `ai-widget.js` 的映射表用的是无前缀名字，命中不了。
  这是「显示已应用但图片不变」的原因之一，详见前端仓库 `docs/AI_WIDGET.md` 第七节。

### 3. `deploy-cloudflared.yml` 已经不需要了

commit `1c5603a524`。它当年的用途是「起一个匿名隧道并把 URL 打印出来」，
现在改为命名隧道 + systemd（见「方案 B」），URL 永久固定，不需要再生成。

- 这个工作流**从未运行过**，也不建议跑：它第 42 行有
  `pkill cloudflared 2>/dev/null || true`，会**把命名隧道的服务一起杀掉**。
- 服务器上现在跑着 systemd 的 `cloudflared.service`（命名隧道）+
  两个遗留的匿名隧道进程。要清理遗留的，用 `ps -eo pid,args | grep cloudflared`
  看清目标再单独 kill，**不要 `pkill cloudflared`**。
- 建议直接删掉这个 workflow，或者改成「读 `systemctl status cloudflared`」的检查。

### 4. 两个运行时 bug 没碰

**`llm-parser-fallback.ts` 的裸 `SyntaxError`** —— 位置确定。
`apps/ai-agent-server/src/core/llm-parser-fallback.ts` 的 `parseResponse`（141-157 行）：

- 143-145 行处理了「响应里根本没有花括号」的情况，抛干净的
  `LLM 返回格式错误，无法解析 JSON`。
- **147 行 `const parsed = JSON.parse(jsonMatch[0])` 没有 try/catch。**
  只要响应里有花括号但内容不是合法 JSON（比如 LLM 返回了裸数字包在
  markdown 里、尾部多余逗号、`{123}` 这类），就直接抛 `SyntaxError`，
  错误类型和上面的友好提示不一致，调用方没法区分「LLM 写坏了」和「代码崩了」。
- 调用链：`parseResponse` ← `parseInstructionFallback`（118 行，exported）
  ← `llm-parser.ts` 第 2 行 import。
- 修法就一行：把 147 行包进 try/catch，抛成和 144 行同类的错误。

**Muyaya API 的 `.then` 报错** —— 没定位到，别浪费时间找。

- 本仓库**没有** muyaya-api 的源码，它只存在于服务器 `/opt/muyaya-api/`。
- 没有复现步骤，只有症状记录。查的话直接上服务器看
  `pm2 logs muyaya-api`。
- 该服务现在健康：`:3001/api/health` → `{"ok":true}`，pm2 id 19，15 次重启。

### 5. 前端四处写死的后端地址 + 悬浮球两个 bug（2026-10-27 记录，未修）

**地址问题**：`app.js:20`、`common.js:12`、`ai-agent.html:181`、`share.js:13`
四处指向的都不是 `ai.muyaya.world`，其中前三个是**早就关掉的匿名隧道域名**，
`share.js` 指向未备案的 `api.muyaya.world`（403）。所以线上相册的登录、
取图、分享接口其实是断的，只是因为没人报过所以一直没发现。
清单和状态见上文「各文件当前写死的是哪个后端地址」。

**悬浮球 bug**：在 PhotoCraft 里输入「变成黑白的」，面板显示
「✅ 已应用到编辑器，可撤销」，但图片没有任何变化。两个独立原因：

1. `ai-widget.js:540` 漏了 `await` —— `executeCommands` 声明为 `async`，
   不 `await` 得到的是 Promise，恒为真值，所以**永远报成功**。
2. 服务端返回的键是 `uExposure`/`uSaturation`/`uTemp`/`uHslSat`，
   而 `mapToPhotoCraftCommand` 的映射表用无前缀名字（`exposure`/`saturation`/
   `temperature`），命中不了 → 命令静默跳过。注意还有额外错位：
   `uTemp`≠`temperature`、`uHslSat`≠`saturation`、`uVignette`≠`vignetteAmount`、
   `uSharpness`≠`sharpening`，所以要真的补一张对照表，不是去前缀了事。

细节和修法在前端仓库 `docs/AI_WIDGET.md` 第七节。**修完必须实测**
（黑白、提亮、加对比度各一次，看图片真的变），别只看面板文字。

---

## 本仓库文档清理（2026-10-27）

删掉了两份**基于过时调研结论**的文档：

| 删掉的 | 为什么 |
|---|---|
| `docs/AI_WIDGET_BROWSER_EXEC.md` | 结论是「PhotoCraft WASM 没有命令 API」，打完 AI Bridge 补丁后已经不成立 |
| `docs/AI_WIDGET_INTEGRATION.md` | 同上，写的是 patch 之前的集成方案，且引用了已移除的 `studio.html` |

AI 悬浮球的权威文档现在只有一份：
前端仓库 `xiaobubuya/xiaobubuya.github.io` 的 `docs/AI_WIDGET.md`。

（删掉的内容在 git 历史里，`git log --all -- docs/AI_WIDGET_BROWSER_EXEC.md` 能找回。）
