import { useSyncExternalStore } from 'react'
import { translations, supportedLanguages, type Language, type TranslationKey } from './translations'

export { supportedLanguages }

const storageKey = 'study-os-language'
const languageCodes = new Set<string>(supportedLanguages.map(language => language.code))
let currentLanguage: Language = readLanguage()
const listeners = new Set<() => void>()

function readLanguage(): Language {
  const stored = typeof window === 'undefined' ? null : window.localStorage.getItem(storageKey)
  return stored && languageCodes.has(stored) ? stored as Language : 'fr'
}

export function getLanguage() { return currentLanguage }

export function setLanguage(language: string) {
  if (!languageCodes.has(language)) {
    console.error(`[i18n] Unsupported language: ${language}`)
    return
  }
  currentLanguage = language as Language
  if (typeof window !== 'undefined') window.localStorage.setItem(storageKey, currentLanguage)
  listeners.forEach(listener => listener())
}

export function t(key: TranslationKey, values: Record<string, string | number> = {}) {
  const selected = translations[currentLanguage][key]
  const value = selected ?? translations.fr[key]
  if (!selected) console.error(`[i18n] Missing translation: ${currentLanguage}.${key}`)
  return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values[name] ?? `{{${name}}}`))
}

export function useI18n() {
  const language = useSyncExternalStore(subscribe, getLanguage, () => 'fr' as Language)
  return { language, setLanguage, t }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}