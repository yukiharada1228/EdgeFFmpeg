import tseslint from 'typescript-eslint';
export default tseslint.config(
  { ignores: ['upstream/**', 'node_modules/**', '.build/**', '.wrangler/**', '**/*.d.ts'] },
  ...tseslint.configs.recommended,
  {
    files: ['packages/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { parserOptions: { project: ['./tsconfig.json', './tsconfig.tests.json', './tsconfig.workers.json', './tsconfig.node.json'], tsconfigRootDir: import.meta.dirname } },
    rules: { '@typescript-eslint/no-floating-promises': 'error' }
  }
);
