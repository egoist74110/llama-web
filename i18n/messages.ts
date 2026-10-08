// Locale table and the shape every dictionary has to satisfy (decision 18).
//
// `i18n/zh-CN.ts` is the source of truth for the keys and keeps its `as const`. `Messages` is the same
// key tree with the literals widened to `string`, so a locale file is checked key by key against the
// Chinese one. A third language later: one entry in LOCALES, one line in `dictionaries`, one file.
import zh from './zh-CN'
import en from './en'

/**
 * Widen every string leaf to `string` and drop the `readonly` that `as const` adds, keeping the key
 * structure. Arrays need their own branch: `as const` makes them readonly tuples, and a readonly
 * tuple is not assignable to a mutable one. They stay readonly in the type - a dictionary is only
 * ever read - and they are real arrays at runtime (`fill.ts` builds plain objects and plain arrays).
 */
type Deep<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? readonly Deep<U>[]
    : { -readonly [K in keyof T]: Deep<T[K]> }

/** A complete dictionary: every key of `zh-CN.ts`, every string leaf widened to `string`. */
export type Messages = Deep<typeof zh>

/** The same shape with any branch left out - a translation that is not finished yet. */
type PartialOf<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? readonly PartialOf<U>[]
    : { [K in keyof T]?: PartialOf<T[K]> }

/** A partial dictionary: every key it does not carry falls back to Chinese (see `fill.ts`). */
export type PartialMessages = PartialOf<Messages>

/** Every locale llama-web knows. A new language: add its code here and a file named after it. */
export const LOCALES = ['zh-CN', 'en'] as const

export type LocaleCode = (typeof LOCALES)[number]

/** What a process starts with, and what an unknown value falls back to (decision 18). */
export const DEFAULT_LOCALE: LocaleCode = 'zh-CN'

/**
 * What each language calls itself. A language picker shows `中文` / `English` in every language, so
 * these are names and not wording: they are not translated and they are not part of a dictionary.
 */
export const LOCALE_NAMES: { [K in LocaleCode]: string } = { 'zh-CN': '中文', en: 'English' }

/**
 * Labels the interface shows instead of a stored value (decision 18). The stored value stays the
 * value: `DEFAULT_PROFILE` is `默认` in models.json and every migration keeps it - only an English
 * interface reads it as `Default`. A display table, not a translation (work package 11-2); wording
 * lives in `i18n/en.ts`.
 */
export const DISPLAY_LABELS: { [K in LocaleCode]: Record<string, string> } = { 'zh-CN': {}, en: { '默认': 'Default' } }

/** One resolved dictionary per locale. The mapped type makes a missing locale a type error. */
export const dictionaries: { [K in LocaleCode]: Messages } = { 'zh-CN': zh, en }
