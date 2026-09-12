import en from './locales/en.json'
import ja from './locales/ja.json'
import type { UiLanguage } from './types'

const messages = { en, ja } as const

export function t(language: UiLanguage, key: string, vars: Record<string, string | number> = {}): string {
  let value = messages[language][key as keyof typeof en] ?? messages.en[key as keyof typeof en] ?? key
  return Object.entries(vars).reduce((result, [name, replacement]) => result.replaceAll(`{${name}}`, String(replacement)), value)
}

export function browserLanguage(): UiLanguage {
  return navigator.language.toLowerCase().startsWith('ja') ? 'ja' : 'en'
}
