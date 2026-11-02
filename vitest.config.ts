import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@esm/shared': path.resolve(__dirname, 'packages/shared/src/index.ts') },
  },
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration files share one database, so they run one after the other.
    fileParallelism: false,
  },
});
