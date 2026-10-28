import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import sharp from 'sharp'
import { config } from '../config.js'
import { logger } from '../utils/logger.js'

/**
 * 视觉分析结果。所有坐标都是**相对比例**（0~1），与像素尺寸无关，
 * 这样缩图后依然能对齐到原文档。
 */
export interface VisionSummary {
  /** 被分析图片的像素尺寸（可能是缩略图尺寸，不是文档尺寸）。 */
  size: { w: number; h: number }
  /** 主体：名称、中心点、包围盒 [x1,y1,x2,y2]，均为 0~1。 */
  subject: { name: string; point: [number, number]; bbox: [number, number, number, number] }
  /** 其它可定位区域（天空、地面、人物等）。 */
  regions: Array<{ name: string; bbox: [number, number, number, number] }>
}

/** 摘要缓存：同一张图（按内容 hash）只分析一次。 */
const cache = new Map<string, { summary: VisionSummary; at: number }>()
const CACHE_TTL_MS = 24 * 60 * 60 * 1000
const CACHE_MAX = 50

const VISION_PROMPT = `你是图像视觉分析器。只输出 JSON，不要任何解释或 markdown。

输出格式：
{"subject":{"name":"主体名称","point":[0.5,0.5],"bbox":[0.1,0.1,0.9,0.9]},"regions":[{"name":"天空","bbox":[0,0,1,0.4]}]}

要求：
- point 是主体中心，bbox 是主体范围，全部用 0~1 的相对比例（左上为原点）。
- regions 列出画面中可独立定位的其它区域（最多 5 个），没有就给空数组。
- 若画面没有明确主体，subject.name 填 "scene"，point 给 [0.5,0.5]，bbox 给 [0,0,1,1]。
- 坐标必须落在 0~1，不要输出像素值。`

/** 校验并收敛相对坐标；非法时返回 null。 */
function sanitize01(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(1, value))
}

function sanitizeBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  const nums = value.map(sanitize01)
  if (nums.some((n) => n === null)) return null
  const [x1, y1, x2, y2] = nums as [number, number, number, number]
  if (x2 <= x1 || y2 <= y1) return null
  return [x1, y1, x2, y2]
}

/** 从模型返回的一段文本里提取并校验 VisionSummary。 */
function parseSummary(text: string, size: { w: number; h: number }): VisionSummary | null {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) return null
  let raw: unknown
  try {
    raw = JSON.parse(match[0])
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as {
    subject?: { name?: unknown; point?: unknown; bbox?: unknown }
    regions?: Array<{ name?: unknown; bbox?: unknown }>
  }
  const subject = obj.subject
  if (!subject) return null

  const pointArr = Array.isArray(subject.point) ? subject.point : []
  const point: [number, number] = [
    sanitize01(pointArr[0]) ?? 0.5,
    sanitize01(pointArr[1]) ?? 0.5,
  ]
  const bbox = sanitizeBbox(subject.bbox) ?? [0, 0, 1, 1]
  const name = typeof subject.name === 'string' && subject.name ? subject.name : 'subject'

  const regions: VisionSummary['regions'] = []
  if (Array.isArray(obj.regions)) {
    for (const r of obj.regions.slice(0, 5)) {
      const b = sanitizeBbox(r?.bbox)
      if (b) regions.push({ name: typeof r?.name === 'string' ? r.name : 'region', bbox: b })
    }
  }

  return { size, subject: { name, point, bbox }, regions }
}

/** 调视觉模型；content 优先，为空时从 reasoning 里提取（sensenova 是 reasoning 模型）。 */
async function callVision(dataUrl: string, size: { w: number; h: number }): Promise<VisionSummary | null> {
  const base = config.llmApiUrl.replace(/\/+$/, '')
  const body = {
    model: config.llmModel,
    // 必须给足：该模型把推理写进 reasoning，给少了 content 会是空的。
    max_tokens: 1500,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: VISION_PROMPT },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  }

  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.llmApiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  })
  if (!res.ok) {
    logger.warn(`[Vision] HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return null
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning?: string } }>
  }
  const msg = json.choices?.[0]?.message
  const text = msg?.content || msg?.reasoning || ''
  if (!text) {
    logger.warn('[Vision] 模型未返回内容')
    return null
  }
  return parseSummary(text, size)
}

function remember(key: string, summary: VisionSummary): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
    if (oldest) cache.delete(oldest[0])
  }
  cache.set(key, { summary, at: Date.now() })
}

/**
 * 分析磁盘上的图片：先用 sharp 缩到长边 1024 再送模型（控制 base64 体积）。
 *
 * @param imagePath 图片绝对路径
 * @returns 视觉摘要；失败或无法识图时返回 null（调用方应退化为纯文字解析）
 */
export async function analyzeImage(imagePath: string): Promise<VisionSummary | null> {
  try {
    const raw = await readFile(imagePath)
    const key = createHash('sha256').update(raw).digest('hex')
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.summary

    const buf = await sharp(raw)
      .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer()
    const meta = await sharp(buf).metadata()
    const size = { w: meta.width ?? 0, h: meta.height ?? 0 }

    const summary = await callVision(`data:image/png;base64,${buf.toString('base64')}`, size)
    if (summary) remember(key, summary)
    return summary
  } catch (e) {
    logger.warn(`[Vision] 分析失败(${imagePath}): ${(e as Error).message}`)
    return null
  }
}

/**
 * 分析前端传来的 data URL（前端已缩放到长边 1024，这里不再缩放）。
 *
 * @param dataUrl `data:image/png;base64,...`
 * @returns 视觉摘要；失败时返回 null
 */
export async function analyzeImageBase64(dataUrl: string): Promise<VisionSummary | null> {
  if (!dataUrl.startsWith('data:image/')) {
    logger.warn('[Vision] imageBase64 不是 data URL，忽略')
    return null
  }
  try {
    const comma = dataUrl.indexOf(',')
    if (comma < 0) return null
    const b64 = dataUrl.slice(comma + 1)
    const raw = Buffer.from(b64, 'base64')
    if (!raw.length) return null

    const key = createHash('sha256').update(raw).digest('hex')
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.summary

    const meta = await sharp(raw).metadata()
    const size = { w: meta.width ?? 0, h: meta.height ?? 0 }
    if (!size.w || !size.h) return null

    const summary = await callVision(dataUrl, size)
    if (summary) remember(key, summary)
    return summary
  } catch (e) {
    logger.warn(`[Vision] 分析 imageBase64 失败: ${(e as Error).message}`)
    return null
  }
}

/**
 * 把视觉摘要渲染成给 agent 的文字块。
 *
 * 坐标按 `docSize`（文档真实尺寸）换算成像素；未提供时只给相对比例，
 * 并明确提示 agent 需要自行换算。
 *
 * @param summary 视觉摘要
 * @param docSize 文档真实像素尺寸（可选）
 * @returns 可直接拼进 task 的 Markdown 文本
 */
export function renderVisionBlock(
  summary: VisionSummary,
  docSize?: { w: number; h: number }
): string {
  const pct = (n: number) => n.toFixed(2)
  const lines: string[] = ['## 图片信息（视觉分析）', '']
  lines.push(`- 主体: ${summary.subject.name}`)
  lines.push(
    `- 主体中心(相对): (${pct(summary.subject.point[0])}, ${pct(summary.subject.point[1])})`
  )
  lines.push(
    `- 主体范围(相对): x ${pct(summary.subject.bbox[0])}~${pct(summary.subject.bbox[2])}, y ${pct(summary.subject.bbox[1])}~${pct(summary.subject.bbox[3])}`
  )
  for (const r of summary.regions) {
    lines.push(
      `- 区域「${r.name}」: x ${pct(r.bbox[0])}~${pct(r.bbox[2])}, y ${pct(r.bbox[1])}~${pct(r.bbox[3])}`
    )
  }

  if (docSize && docSize.w > 0 && docSize.h > 0) {
    const px = (n: number, total: number) => Math.round(n * total)
    const cx = px(summary.subject.point[0], docSize.w)
    const cy = px(summary.subject.point[1], docSize.h)
    const b = summary.subject.bbox
    lines.push('')
    lines.push(`- 文档尺寸: ${docSize.w}x${docSize.h}`)
    lines.push(`- 主体中心(像素): (${cx}, ${cy})`)
    lines.push(
      `- 主体范围(像素): x ${px(b[0], docSize.w)}~${px(b[2], docSize.w)}, y ${px(b[1], docSize.h)}~${px(b[3], docSize.h)}`
    )
    lines.push('')
    lines.push('## 定位命令建议')
    lines.push(
      `- 选中主体: select.object {"point":[${cx},${cy}]}（引擎会自动贴合对象边界，优先用它）`
    )
    lines.push(
      `- 矩形区域: select.rect {"x":..,"y":..,"width":..,"height":..}（选不中对象或要整块区域时用）`
    )
  } else {
    lines.push('')
    lines.push('文档像素尺寸未知：如需像素坐标，先运行 photocraft-cli info <图片> 获取尺寸再换算。')
  }

  return lines.join('\n')
}
