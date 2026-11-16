// @ts-check
import styleMigrate from '@stylistic/eslint-plugin-migrate'
import sortKeys from 'eslint-plugin-sort-keys'
import datadayrepos from './dist/index.js'

export default datadayrepos(
  {
    vue: true,
    typescript: true,
    ignores: [
      'fixtures',
      '_fixtures',
    ],
  },
  {
    files: ['src/**/*.ts'],
    plugins: {
      'sort-keys': sortKeys,
    },
    rules: {
      'sort-keys/sort-keys-fix': 'error',
    },
  },
  {
    files: ['src/configs/*.ts'],
    plugins: {
      'style-migrate': styleMigrate,
    },
    rules: {
      'style-migrate/migrate': ['error', { namespaceTo: 'style' }],
    },
  },
  {
    // Hub owns this helper's source bytes and global-process style.
    files: ['shell/check-private-updates/main.mjs'],
    rules: {
      'node/prefer-global/process': ['error', 'always'],
    },
  },
)
