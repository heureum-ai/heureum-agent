import { settings } from './config.js'

export const WEB_DEFAULTS = {
  runtime: {
    cacheDirName: 'heureum-web',
  },
} as const

export const WEB_SETTINGS = settings
export type WebSettings = typeof settings
