<script setup lang="ts">
// Interface language (decision 18, work package 11-2). The page saves `ui.locale`; the settings
// response and the live snapshot carry the new language to every open page, so the whole console
// changes wording without a reload. Models, profiles and saved files are untouched.
import { LOCALES, LOCALE_NAMES, type LocaleCode } from '~~/i18n/messages'
import { getUiLocale, t } from '../composables/useLocale'

const s = t.settings.language
const { saving, save } = useSettings()

// A language is called by its own name in every interface (i18n/messages.ts).
const items = LOCALES.map((code) => ({ value: code, label: LOCALE_NAMES[code] }))
const current = computed(() => getUiLocale())

function pick(value: unknown): void {
  const next = String(value)
  if (!LOCALES.includes(next as LocaleCode) || next === getUiLocale()) return
  void save('language', { ui: { locale: next } }, { quiet: true })
}
</script>

<template>
  <AppCard :title="s.title" :hint="s.hint">
    <div class="flex flex-wrap items-center gap-2.5">
      <label class="text-xs font-medium text-muted" for="ui-locale">{{ s.label }}</label>
      <USelect
        id="ui-locale"
        :model-value="current"
        :items="items"
        size="sm"
        class="w-40"
        :aria-label="s.label"
        :disabled="saving === 'language'"
        @update:model-value="pick"
      />
    </div>
  </AppCard>
</template>
