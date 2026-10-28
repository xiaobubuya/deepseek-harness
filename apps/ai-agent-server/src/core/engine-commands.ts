import { execFile } from 'child_process'
import { promisify } from 'util'
import { config } from '../config.js'

const execFileAsync = promisify(execFile)

/** 引擎命令 id 缓存，避免每次解析都起子进程。 */
let cache: { ids: Set<string>; at: number } | null = null
const TTL_MS = 5 * 60 * 1000

/**
 * 从 photocraft-cli 拉取引擎支持的全部命令 id。
 *
 * `commands --json` 返回 920 条命令的完整规格；这里只取 id 集合用于校验
 * 模型返回的 id 是否真实存在（防止编造）。失败时返回 null，调用方退化为
 * 只信任内置的 {@link PHOTOCRAFT_COMMAND_IDS}。
 */
export async function getEngineCommandIds(): Promise<Set<string> | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.ids
  try {
    const { stdout } = await execFileAsync(config.photocraftCli, ['commands', '--json'], {
      timeout: 20000,
      maxBuffer: 16 * 1024 * 1024,
    })
    // cli 可能在 JSON 前输出提示行，截取第一个 '[' 开始的部分。
    const start = stdout.indexOf('[')
    if (start < 0) return null
    const list = JSON.parse(stdout.slice(start)) as Array<{ id?: string }>
    const ids = new Set(list.map((c) => c.id).filter((id): id is string => !!id))
    if (!ids.size) return null
    cache = { ids, at: Date.now() }
    return ids
  } catch {
    return null
  }
}
