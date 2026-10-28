# ai-agent-server 部署后自测清单

每次 `deploy-ai-agent.yml` 部署成功后**必须走一遍**。任何一项不符合预期，先按文末
「故障对照表」排查，再决定是否回滚。

> 本文是操作清单，不是设计文档。事故根因与修复过程见前端仓库
> `openspec/changes/archive/legacy-docs/SERVER-OPS-2026-10-28.md`；
> 视觉定位设计见 `docs/DESIGN-vision-localization.md`。

## 一、环境自检（复制整段执行）

```bash
# 1. 服务健康
curl -s http://localhost:3000/api/health; echo

# 2. .env 关键项：API_KEY 必须是 bubu（前端 ai-widget.js 硬编码），其余非空
grep -E '^API_KEY|^LLM_API_URL|^LLM_MODEL|^HARNESS_ENABLED|^PHOTOCRAFT_SERVE_PORT' \
  /opt/ai-agent-server/.env
awk -F= '/^LLM_API_KEY=/{print "LLM_API_KEY 长度:", length($2)}' /opt/ai-agent-server/.env
awk -F= '/^PHOTOCRAFT_SERVE_TOKEN=/{print "SERVE_TOKEN 长度:", length($2)}' /opt/ai-agent-server/.env

# 3. dsh 必须指向全局完好版本（不是 harness 副本）
readlink -f /usr/local/bin/dsh
dsh --version

# 4. skill 必须已预加载
ls -la /root/.dsh/skills/photocraft-commands/SKILL.md

# 5. 进程状态
pm2 list | grep -E 'ai-agent-server|photocraft-serve'
```

### 预期值

| 项 | 预期 |
|---|---|
| `/api/health` | `{"status":"ok",...}` |
| `API_KEY` | `bubu` |
| `LLM_API_URL` / `LLM_MODEL` | 部署 secret 的值（当前 sensenova） |
| `LLM_API_KEY` 长度 | > 0（当前 35） |
| `PHOTOCRAFT_SERVE_TOKEN` 长度 | > 0（当前 64） |
| `/usr/local/bin/dsh` | `/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` |
| `dsh --version` | 能输出版本号（当前 `0.2.1-rc.2`） |
| skill | `photocraft-commands/SKILL.md` 存在 |
| 进程 | 两个都 `online` |

## 二、功能验证（3 条，覆盖新旧命令）

```bash
for msg in "把照片旋转180度" "改成黑白并提高对比度" "给照片加高斯模糊，半径5像素"; do
  echo "--- $msg"
  curl -s -X POST http://localhost:3000/api/parse \
    -H "Content-Type: application/json" -H "X-API-Key: bubu" \
    -d "{\"message\":\"$msg\"}" --max-time 300 \
  | python3 -c "import json,sys;d=json.load(sys.stdin);print([c['id'] for c in d.get('commands',[])],'| 共',len(d.get('commands',[])))"
done
```

### 预期结果

| 需求 | 预期命令 |
|---|---|
| 把照片旋转180度 | `['edit.transform.rotate180']` |
| 改成黑白并提高对比度 | `['image.adjustments.blackWhite', 'image.adjustments.brightnessContrast']`（2 条） |
| 给照片加高斯模糊，半径5像素 | `['filter.blur.gaussianBlur']` |

三条分别验证：**变换类**（skill 查询是否生效）、**多命令 + 默认参数**（sanitize 是否误杀）、
**滤镜类**（新命令是否透传）。

## 三、L2 视觉定位（带画布，需要定位的需求）

视觉链路：前端画布 → `imageBase64` → 视觉摘要 → 定位命令（`select.rect` / `select.object`）。

```bash
IMG=$(ls /opt/ai-agent-server/uploads/*.png | head -1)
B64=$(base64 -w0 "$IMG")
python3 -c "import json,sys;print(json.dumps({'message':'把照片上半部分调暗','imageBase64':'data:image/png;base64,'+sys.argv[1],'docSize':{'w':100,'h':100}}))" "$B64" > /tmp/l2.json
curl -s -X POST http://localhost:3000/api/parse \
  -H "Content-Type: application/json" -H "X-API-Key: bubu" \
  --data-binary @/tmp/l2.json --max-time 300
```

### 预期

- 日志出现 `[Parse] 视觉摘要: 主体=...` 与 `[Harness] 已注入视觉摘要`
- 返回命令含 `select.rect`（区域）或 `select.object`（对象）+ 后续调整命令
- **不得**出现 `[Harness] final 不是合法 JSON`（出现即 JSON 提取逻辑退化）

> `select.object` 对卡通/平坦区块可能只选中一小块，所以摘要里把 `select.rect` 列为推荐、
> `select.object` 列为备选。

## 四、端到端（chat 链路真执行并出图）

```bash
IMG=$(basename $(ls /opt/ai-agent-server/uploads/*.png | head -1))
echo "测试图: $IMG"
curl -s -X POST http://localhost:3000/api/chat \
  -H "Content-Type: application/json" -H "X-API-Key: bubu" \
  -d "{\"message\":\"把照片旋转180度\",\"imageFilename\":\"$IMG\"}"; echo

sleep 60
pm2 logs ai-agent-server --lines 80 --nostream | grep -E 'Harness|completed|失败|command\(s\) applied' | tail -5
ls -lat /opt/ai-agent-server/processed | head -3
```

### 预期

- 日志出现 `[Harness] 开始解析指令` → `[Harness] agent 完成` → `Task ... completed successfully`
- `processed/` 出现新的 `*_result*.png`
- `N command(s) applied` 的 N **不应为 0**（为 0 说明命令没生效，产物与原图一致）
- **不应**出现 `harness 失败，回退单次 LLM`

## 五、故障对照表

| 症状 | 根因 | 修复 |
|---|---|---|
| `/api/parse` 返回 `401 Forbidden` | `.env` 的 `LLM_API_KEY` 为空或与 secret 不符 | 检查 secret 传递；确认 deploy 用 ssh 环境变量前缀而非裸 heredoc |
| 前端全部请求 401 | `.env` 的 `API_KEY` 不是 `bubu` | 部署脚本应保留服务器现有值，勿被 secret 覆盖 |
| `dsh: Cannot find package 'js-yaml'` | `/usr/local/bin/dsh` 被指到 `harness/.bin/dsh` 副本 | 重链到全局版本（部署脚本已优先全局） |
| 部署跑数小时不结束 | 又在打包上传 160MB+ harness | 确认 `Package` 步骤未包含 `harness` |
| 图片执行失败 / 鉴权错误 | `PHOTOCRAFT_SERVE_TOKEN` 丢失或为空 | 部署脚本应从 `photocraft-serve.token` 复用 |
| harness 回「无法用现有命令表达」 | skill 未加载，或 agent 查不到命令 | 检查 skill 预加载 + `DSH_PERMISSION_MODE=danger-full-access` |
| 日志「丢弃了 …(参数无效)」 | sanitize 把空参数命令误杀 | 确认 parse.ts 未恢复「参数全空就丢」逻辑 |
| `[Harness] final 不是合法 JSON` | JSON 提取用了贪婪正则（跨多个块） | 应使用 `utils/json-extract.ts` 的括号平衡扫描 |
| `0 command(s) applied` 但任务成功 | 命令为空，或全部被 sanitize 丢弃 | 查上一条日志定位；确认提取与校验未退化 |
| L2 定位偏 / 选错区域 | 视觉 bbox 粗估，或 `select.object` 只抓到小块 | 改用 `select.rect`；提示用户可手动微调 |
| `LLM_API_URL` 末尾多斜杠 | secret 值自带 | 实测不影响；介意可去掉 |

## 六、回滚

```bash
# 代码回滚：revert 对应 commit 后重新 push（会再触发部署）
git revert <commit> && git push origin master

# 仅恢复 .env：从备份还原后重启
cp /opt/ai-agent-server/.env.bak-<时间> /opt/ai-agent-server/.env
pm2 restart ai-agent-server --update-env
```
