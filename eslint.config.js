import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

// Layer boundaries. The simulation must not know about three.js, React or the
// DOM; render must not know about React. See README "Layout".
const SIM_LAYERS = ['core', 'data', 'engine', 'sim', 'ai', 'mission', 'shell', 'launcher', 'generated'];
const noUi = [
  { group: ['three', 'three/*'], message: 'Simulation layers must not import three.js - go through a port (engine/ports.ts).' },
  { group: ['react', 'react-dom', 'react/*', 'react-dom/*'], message: 'Simulation layers must not import React.' },
  { group: ['**/render/**', '**/editor/**', '**/app/**', '**/audio/**', '**/input/**', '**/hud/**'], message: 'Simulation layers must not import presentation layers.' },
];

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Ported C is full of bit manipulation; these are not mistakes there.
      'no-bitwise': 'off',
      'no-constant-condition': ['error', { checkLoops: false }],
    },
  },
  {
    files: SIM_LAYERS.map((l) => `src/${l}/**/*.ts`),
    rules: { 'no-restricted-imports': ['error', { patterns: noUi }] },
  },
  {
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [...noUi, { group: ['**/data/**', '**/engine/**', '**/sim/**', '**/ai/**', '**/mission/**', '**/generated/**'], message: 'core depends on nothing outside core.' }] }],
    },
  },
  {
    files: ['src/render/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [{ group: ['react', 'react-dom', '**/editor/**', '**/app/**'], message: 'render must not depend on React.' }] }] },
  },
  {
    files: ['src/**/*.tsx'],
    plugins: { 'react-hooks': reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
);
