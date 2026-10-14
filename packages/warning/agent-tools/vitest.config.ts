import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-warning-data-core': fileURLToPath(new URL('../data-core/src/index.ts', import.meta.url)),
      '@deepseek-ai/dsh-warning-doris-adapter': fileURLToPath(new URL('../doris-adapter/src/index.ts', import.meta.url)),
      '@deepseek-ai/dsh-warning-lps-adapter': fileURLToPath(new URL('../lps-adapter/src/index.ts', import.meta.url)),
      '@deepseek-ai/dsh-warning-ntsdb-adapter': fileURLToPath(new URL('../ntsdb-adapter/src/index.ts', import.meta.url)),
    },
  },
  test: { include: ['tests/**/*.spec.ts'] },
})
