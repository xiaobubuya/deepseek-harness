/**
 * PhotoCraft 调整命令目录与系统提示词。
 *
 * 命令 id 与参数名/取值区间**全部取自上游源码**
 * `crates/engine/src/adjust_params.rs` 的 `from_params` 和
 * `crates/engine/src/adjust_cmds.rs`，不是猜的。
 *
 * 旧版本这里是 Studio 的 60 多个 `uXxx` 参数，前端还得再翻译成 `adjust.*` 命令——
 * 而那些 `adjust.*` id 在 PhotoCraft 里根本不存在，于是「显示已应用但图片不变」。
 * 现在让模型直接产出 PhotoCraft 原生命令，前端只负责转发。
 */

/** 单个参数的约束。 */
export interface ParamSpec {
  /** 数值下限（含）。 */
  min?: number
  /** 数值上限（含）。 */
  max?: number
  /** 必须是整数。 */
  integer?: boolean
  /** 布尔参数。 */
  bool?: boolean
  /** 定长数值数组（如 `[r,g,b]`）。 */
  arrayOf?: number
}

/** 参数表里没列出的键一律丢弃，数值一律按区间钳制。 */
export const PHOTOCRAFT_COMMANDS: Record<string, Record<string, ParamSpec>> = {
  'image.adjustments.invert': {},

  'image.adjustments.brightnessContrast': {
    brightness: { min: -150, max: 150 },
    contrast: { min: -100, max: 100 },
    legacy: { bool: true },
  },

  'image.adjustments.threshold': {
    level: { min: 1, max: 255 },
  },

  'image.adjustments.posterize': {
    levels: { min: 2, max: 255, integer: true },
  },

  'image.adjustments.exposure': {
    exposure: { min: -20, max: 20 },
    offset: { min: -0.5, max: 0.5 },
    gamma: { min: 0.01, max: 9.99 },
  },

  'image.adjustments.vibrance': {
    vibrance: { min: -100, max: 100 },
    saturation: { min: -100, max: 100 },
  },

  'image.adjustments.hueSaturation': {
    hue: { min: -180, max: 180 },
    saturation: { min: -100, max: 100 },
    lightness: { min: -100, max: 100 },
    colorize: { bool: true },
  },

  'image.adjustments.levels': {
    inBlack: { min: 0, max: 253 },
    inWhite: { min: 2, max: 255 },
    gamma: { min: 0.01, max: 9.99 },
    outBlack: { min: 0, max: 255 },
    outWhite: { min: 0, max: 255 },
  },

  'image.adjustments.curves': {
    // [[输入, 输出], …]，0..255
    points: {},
    pencil: { bool: true },
  },

  'image.adjustments.colorBalance': {
    // [青-红, 洋红-绿, 黄-蓝]，各自 -100..100
    shadows: { arrayOf: 3 },
    midtones: { arrayOf: 3 },
    highlights: { arrayOf: 3 },
    preserveLuminosity: { bool: true },
  },

  'image.adjustments.blackWhite': {
    reds: { min: -200, max: 300 },
    yellows: { min: -200, max: 300 },
    greens: { min: -200, max: 300 },
    cyans: { min: -200, max: 300 },
    blues: { min: -200, max: 300 },
    magentas: { min: -200, max: 300 },
    tint: { bool: true },
    tintColor: {},
  },

  'image.adjustments.photoFilter': {
    filter: {},
    color: {},
    density: { min: 0, max: 100 },
    preserveLuminosity: { bool: true },
  },

  'image.adjustments.channelMixer': {
    red: { arrayOf: 4 },
    green: { arrayOf: 4 },
    blue: { arrayOf: 4 },
    gray: { arrayOf: 4 },
    monochrome: { bool: true },
  },

  'image.adjustments.gradientMap': {
    stops: {},
    reverse: { bool: true },
    dither: { bool: true },
  },

  'image.adjustments.selectiveColor': {
    method: {},
    relative: { bool: true },
    reds: { arrayOf: 4 },
    yellows: { arrayOf: 4 },
    greens: { arrayOf: 4 },
    cyans: { arrayOf: 4 },
    blues: { arrayOf: 4 },
    magentas: { arrayOf: 4 },
    whites: { arrayOf: 4 },
    neutrals: { arrayOf: 4 },
    blacks: { arrayOf: 4 },
  },

  'image.adjustments.shadowsHighlights': {
    shadowAmount: { min: 0, max: 100 },
    shadowTone: { min: 0, max: 100 },
    shadowRadius: { min: 0, max: 2500 },
    highlightAmount: { min: 0, max: 100 },
    highlightTone: { min: 0, max: 100 },
    highlightRadius: { min: 0, max: 2500 },
    color: { min: -100, max: 100 },
    midtone: { min: -100, max: 100 },
    blackClip: { min: 0, max: 50 },
    whiteClip: { min: 0, max: 50 },
  },

  'image.adjustments.hdrToning': {
    radius: { min: 1, max: 500 },
    strength: { min: 0.1, max: 4 },
    gamma: { min: 0.1, max: 2 },
    exposure: { min: -5, max: 5 },
    detail: { min: -100, max: 300 },
    shadow: { min: -100, max: 100 },
    highlight: { min: -100, max: 100 },
    vibrance: { min: -100, max: 100 },
    saturation: { min: -100, max: 100 },
  },
}

/** 允许的 id 集合。 */
export const PHOTOCRAFT_COMMAND_IDS: string[] = Object.keys(PHOTOCRAFT_COMMANDS)

/**
 * 给模型的命令清单（人读格式，由 PHOTOCRAFT_COMMANDS 渲染，避免两处不同步）。
 */
export function renderCommandCatalog(): string {
  return PHOTOCRAFT_COMMAND_IDS.map((id) => {
    const params = PHOTOCRAFT_COMMANDS[id]
    const keys = Object.keys(params)
    if (!keys.length) return `- ${id}  参数: {}`
    const desc = keys.map((k) => {
      const s = params[k]
      if (s.bool) return `${k}:布尔`
      if (s.arrayOf) return `${k}:${s.arrayOf} 个数字组成的数组`
      if (s.min !== undefined && s.max !== undefined) return `${k}:${s.min}..${s.max}`
      return `${k}:自定义`
    })
    return `- ${id}  参数: {${desc.join(', ')}}`
  }).join('\n')
}

/**
 * 系统提示词。要求模型只输出 JSON，且命令必须是上面目录里的 id。
 */
export const PHOTOCRAFT_SYSTEM_PROMPT = `你是专业照片编辑助手，把用户的中文/英文修图需求翻译成 PhotoCraft 编辑器的命令。

你只能使用下面这些命令 id（这是编辑器真实支持的清单，不要发明新 id）：

${renderCommandCatalog()}

输出格式（只输出这个 JSON，不要 markdown、不要解释性文字）：

{"commands":[{"id":"image.adjustments.<命令>","params":{...}}],"explanation":"一句话说明做了什么"}

规则：
1. units 全部是 Photoshop 式的：百分比参数是 -100..100（不是 -1..1），曝光是 EV（-20..20），色阶/曲线是 0..255。
2. 只填需要的参数，没提到的参数不要写。可以一次给多条命令，按执行顺序排列。
3. 常见需求的写法：
   - 黑白照片 → {"id":"image.adjustments.hueSaturation","params":{"saturation":-100}}
   - 变亮 → {"id":"image.adjustments.exposure","params":{"exposure":0.5}}
   - 加对比 → {"id":"image.adjustments.brightnessContrast","params":{"contrast":20}}
   - 暖一点 → {"id":"image.adjustments.photoFilter","params":{"filter":"warming85","density":25}}
   - 去雾/通透 → {"id":"image.adjustments.shadowsHighlights","params":{"shadowAmount":35,"highlightAmount":20}}
   - 复古 → {"id":"image.adjustments.gradientMap","params":{"stops":[[0,"#3b2410"],[1,"#f4e3c1"]]}}
4. 如果需求无法用这些命令表达（例如裁剪、液化、局部选区、去物），commands 返回空数组，
   explanation 直接说明做不到，不要硬凑命令。
5. 数值必须在参数区间内，不要超范围。`

/**
 * 给 harness agent 的提示词。
 *
 * 与 {@link PHOTOCRAFT_SYSTEM_PROMPT} 的区别：不带硬编码命令清单，
 * 而是要求 agent 用 `photocraft-cli commands --json --filter <关键词>`
 * 查询引擎真实的 920 个命令及其参数规格。
 *
 * 为什么：920 个命令全量塞进 prompt 约 25K tokens，每次解析都发不现实；
 * 让 agent 按需过滤查询既覆盖全量，又只消耗实际用到的部分。
 */
export const PHOTOCRAFT_AGENT_PROMPT = `你是专业照片编辑助手，把用户的中文/英文修图需求翻译成 PhotoCraft 编辑器的命令。

## 必须先查命令清单（重要）

PhotoCraft 引擎支持 920 个命令，**你不要凭记忆发明命令 id**。每个操作都必须先在引擎里查到真实命令：

  photocraft-cli commands --json --filter <关键词>

例如：
- 需求含「旋转」→ photocraft-cli commands --json --filter rotate
- 需求含「黑白」→ photocraft-cli commands --json --filter blackWhite
- 需求含「对比」→ photocraft-cli commands --json --filter contrast
- 需求含「滤镜」→ photocraft-cli commands --json --filter filter

返回的 JSON 每项含 id / label / menu / params（参数范围与默认值）。

**不要全量拉取 commands**（输出 310KB 会超出上下文），只按关键词过滤查询。

## 输出格式（只输出这个 JSON）

{"commands":[{"id":"<引擎命令 id>","params":{...}}],"explanation":"一句话说明做了什么"}

## 规则

1. 每个操作的 id 必须来自查询结果，不得编造。
2. params 必须按返回的规格填写（范围、默认值、嵌套结构）。
3. units 是 Photoshop 式：百分比参数 -100..100，曝光是 EV，色阶/曲线是 0..255。
4. 只填需要的参数；可以一次给多条命令，按执行顺序排列。
5. 如果查询不到对应命令（需求确实无法表达），commands 返回空数组，explanation 说明做不到。
6. 除 photocraft-cli commands 查询外，不要执行其他命令、不要读写任何文件。`
