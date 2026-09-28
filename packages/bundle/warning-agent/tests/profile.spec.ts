import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { describe, expect, it } from 'vitest'

interface PatchRow {
  id?: string
  disabled?: boolean
}

describe('warning-agent profile overlay', () => {
  it('disables development and unrestricted egress capabilities', () => {
    const file = fileURLToPath(new URL('../cordis.patch.yml', import.meta.url))
    const rows = yaml.load(readFileSync(file, 'utf8'), { schema: entryListSchema }) as Array<PatchRow | { insert: PatchRow[] }>
    const flatRows = rows.flatMap(row => 'insert' in row ? row.insert : [row])
    const disabledIds = new Set(flatRows.filter(row => row.disabled === true).map(row => row.id))
    expect([
      'subprocess', 'sandbox', 'sandbox-policy', 'tool-bash', 'tool-pwsh',
      'tool-fs', 'tool-fs-search', 'web', 'web-search-deepseek', 'web-fetch-http',
      'tool-web', 'skill', 'skill-filesystem', 'tool-skill', 'subagent',
      'tool-subagent', 'tool-subagent-fork', 'tool-ralph',
    ].every(id => disabledIds.has(id))).toBe(true)
    const runtime = flatRows.find(row => row.id === 'warning-agent-runtime')
    expect(runtime).toBeDefined()
  })
})
