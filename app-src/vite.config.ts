/// <reference types="vitest/config" />
import { defineConfig } from 'vite'

export default defineConfig({
  base: '/english-materials/app/',
  build: { outDir: '../app', emptyOutDir: true },
  test: { environment: 'node', include: ['src/**/*.test.ts'], passWithNoTests: true },
})
