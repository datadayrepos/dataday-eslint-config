import { pluginDataDay, pluginImport } from '../plugins'
import type { ConfigItem, OptionsStylistic } from '../types'

export function imports(options: OptionsStylistic = {}): ConfigItem[] {
  const {
    stylistic = true,
  } = options

  return [
    {
      name: 'datadayrepos:imports',
      plugins: {
        datadayrepos: pluginDataDay,
        import: pluginImport,
      },
      rules: {
        'datadayrepos/import-dedupe': 'error',
        'datadayrepos/no-import-node-modules-by-path': 'error',

        'import/first': 'error',
        'import/no-duplicates': 'error',
        'import/no-mutable-exports': 'error',
        'import/no-named-default': 'error',
        'import/no-self-import': 'error',
        'import/no-webpack-loader-syntax': 'error',
        'import/order': 'error',

        ...stylistic
          ? {
            'import/newline-after-import': ['error', { considerComments: true, count: 1 }],
          }
          : {},
      },
    },
  ]
}
