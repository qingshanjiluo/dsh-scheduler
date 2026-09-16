import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2022',
  external: [/^@deepseek-ai\//, /^node:/],
  dts: true,
  clean: true,
  tsconfig: 'tsconfig.json',
})
