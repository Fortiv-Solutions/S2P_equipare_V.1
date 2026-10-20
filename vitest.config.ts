import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['server/tests/**/*.test.ts'],
    pool: 'forks',
    testTimeout: 30000,
    hookTimeout: 60000,
    fileParallelism: true,
  },
});
