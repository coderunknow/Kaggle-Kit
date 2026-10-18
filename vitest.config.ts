import { defineConfig } from 'vitest/config';

/**
 * Tests run in the node environment by default. Component tests opt into
 * jsdom with a `@vitest-environment jsdom` docblock.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'server/**/*.test.ts', 'shared/**/*.test.ts'],
    restoreMocks: true,
    clearMocks: true,
    setupFiles: ['./src/test-setup.ts'],
  },
});
