// ESLint flat config (ESLint v9).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
    {
        // Language files and auto-generated Wails bindings are excluded from
        // strict application rules.
        ignores: [
            'node_modules/**',
            'dist/**',
            'dist-types/**',
            'wailsjs/**',
        ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2020,
            sourceType: 'module',
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
        rules: {
            // Project uses 4-space indent (Wails/Go-style consistency).
            'indent': ['error', 4],
            'no-console': ['warn', { allow: ['warn', 'error'] }],
            // Allow explicit any in test-friendly spots; keep `any` usage low.
            '@typescript-eslint/no-explicit-any': 'off',
            '@typescript-eslint/no-unused-vars': ['error', {
                argsIgnorePattern: '^_',
                varsIgnorePattern: '^_',
            }],
        },
    },
);
