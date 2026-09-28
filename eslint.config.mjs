export default [
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        AbortController: 'readonly',
        fetch: 'readonly'
      }
    },
    rules: {
      'no-unused-vars': ['error', { args: 'none' }],
      'no-undef': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],
      eqeqeq: 'error',
      'prefer-const': 'error',
      'no-var': 'error'
    }
  }
];
