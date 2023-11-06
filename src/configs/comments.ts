import { pluginComments } from '../plugins'
import type { ConfigItem } from '../types'

export function comments(): ConfigItem[] {
  return [
    {
      name: 'datadayrepos:eslint-comments',
      plugins: {
        'eslint-comments': pluginComments,
      },
      rules: {
        'eslint-comments/no-aggregating-enable': 'error',
        'eslint-comments/no-duplicate-disable': 'error',
        'eslint-comments/no-unlimited-disable': 'error',
        'eslint-comments/no-unused-enable': 'error',
      },
    },
  ]
}
