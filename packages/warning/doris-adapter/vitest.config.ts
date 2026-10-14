import { defineConfig } from 'vitest/config'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/dsh-warning-data-core': fileURLToPath(new URL('../data-core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['tests/**/*.spec.ts'],
  },
})
