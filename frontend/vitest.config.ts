import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'jsdom',
        globals: true,
        css: false,
        // xterm.js is mocked per test file; CSS is not processed.
        coverage: {
            provider: 'v8',
            include: ['src/**/*.ts'],
            exclude: ['src/**/*.test.ts', 'src/test/**'],
            // Report per-file; aim for >=70% on each source file.
            reporter: ['text', 'html'],
        },
        setupFiles: ['src/test/setup.ts'],
    },
});
