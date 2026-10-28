/**
 * 从模型输出里提取**指令 JSON 对象**。
 *
 * 为什么不用 `/\{[\s\S]*\}/`：那是贪婪匹配，模型输出多个 JSON 块
 * （方案示例 + 最终答案）时会从第一个 `{` 一直吃到最后一个 `}`，
 * 把中间的非 JSON 文本也括进来，导致 `JSON.parse` 失败。
 * 实测症状：`[Harness] final 不是合法 JSON，按空命令处理`。
 *
 * 策略：扫描文本里所有括号平衡的顶层对象，**优先返回含 `commands` 字段的那个**
 * （模型常先给示例、后给答案，取第一个可能拿到示例）；都没有时返回第一个。
 *
 * @param text 模型返回的原始文本
 * @returns 选中的 JSON 对象文本；找不到时返回 null
 */
export function extractFirstJsonObject(text: string): string | null {
  if (!text) return null

  // 优先看 ```json ... ``` 代码块，模型常把答案放里面。
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidates = fence ? [fence[1], text] : [text]

  for (const src of candidates) {
    const objects = scanTopLevelObjects(src)
    if (!objects.length) continue

    // 优先：含 commands 字段的（真正的答案）
    const withCommands = objects.find((o) => o.includes('"commands"'))
    if (withCommands) return withCommands

    // 兜底：第一个对象
    return objects[0]
  }

  return null
}

/** 扫描文本里所有括号平衡的顶层 JSON 对象（跳过字符串内的括号）。 */
function scanTopLevelObjects(src: string): string[] {
  const found: string[] = []
  let i = 0
  while (i < src.length) {
    const start = src.indexOf('{', i)
    if (start < 0) break

    let depth = 0
    let inString = false
    let escaped = false
    let end = -1

    for (let j = start; j < src.length; j++) {
      const ch = src[j]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === '\\') escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          end = j
          break
        }
      }
    }

    if (end < 0) break
    found.push(src.slice(start, end + 1))
    i = end + 1
  }
  return found
}
