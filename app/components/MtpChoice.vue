<script setup lang="ts">
import { t } from '../composables/useLocale'
import { MTP_MAX_N, type MtpInput } from '~~/server/core/mtp'
import type { FileRef } from '~~/server/core/types'

const value = defineModel<MtpInput>({ required: true })
const props = defineProps<{ candidates: Array<{ ref: FileRef, fileName: string, size: number }>, idPrefix: string }>()
const s = t.models.firstStart.mtp
const key = (r: FileRef | null) => r ? JSON.stringify([r.dirId, r.rel]) : ''
const draftKey = computed(() => key(value.value.draft))
const choices = computed(() => withEmptyOption(s.chooseFile, props.candidates.map(c => ({ value: key(c.ref), label: `${c.fileName} · ${formatBytes(c.size)}` }))))
const nValid = computed(() => Number.isInteger(value.value.n) && value.value.n >= 1 && value.value.n <= MTP_MAX_N)
const missing = computed(() => !!value.value.draft && !props.candidates.some(c => key(c.ref) === draftKey.value))
function patch(update: Partial<MtpInput>) { value.value = { ...value.value, ...update } }
</script>

<template>
  <section class="flex flex-col gap-2">
    <div class="flex items-center justify-between gap-3">
      <h3 class="m-0 text-sm font-semibold">{{ s.title }}</h3>
      <div class="lw-seg" role="radiogroup" :aria-label="s.title">
        <button type="button" role="radio" :aria-checked="value.enabled" :class="{ on: value.enabled }" @click="patch({ enabled: true })">{{ s.on }}</button>
        <button type="button" role="radio" :aria-checked="!value.enabled" :class="{ on: !value.enabled }" @click="patch({ enabled: false })">{{ s.off }}</button>
      </div>
    </div>
    <p class="m-0 text-xs text-muted">{{ s.hint }}</p>
    <template v-if="value.enabled">
      <div class="flex flex-wrap gap-2" role="radiogroup" :aria-label="s.mode">
        <button v-for="mode in (['builtin', 'file'] as const)" :key="mode" type="button" role="radio" :aria-checked="value.mode === mode"
          class="rounded-md border px-3 py-2 text-sm" :class="value.mode === mode ? 'border-primary bg-primary/10 text-primary' : 'border-default text-muted'"
          @click="patch({ mode, draft: mode === 'builtin' ? null : value.draft })">{{ s[mode] }}</button>
      </div>
      <p v-if="!value.mode" class="m-0 text-xs text-warning">{{ s.chooseMode }}</p>
      <p v-if="value.mode === 'builtin'" class="m-0 text-xs text-muted">{{ s.builtinHint }}</p>
      <template v-if="value.mode === 'file'">
        <p class="m-0 text-xs text-muted">{{ s.fileHint }}</p>
        <USelect :model-value="toSelectValue(missing ? '' : draftKey)" :items="choices" :disabled="!candidates.length" class="w-full font-mono"
          :aria-label="s.file" @update:model-value="(v: unknown) => patch({ draft: candidates.find(c => key(c.ref) === fromSelectValue(v))?.ref ?? null })" />
        <p v-if="!candidates.length" class="m-0 text-xs text-warning">{{ s.none }}</p>
        <p v-else-if="missing" class="m-0 text-xs text-warning">{{ s.missing }}</p>
      </template>
      <div v-if="value.mode" class="mt-1 flex flex-wrap items-center gap-2 text-sm">
        <label :for="`${idPrefix}-mtp-n`">{{ s.n }}</label>
        <UInput :id="`${idPrefix}-mtp-n`" :model-value="value.n" type="number" size="sm" class="w-24" :min="1" :max="MTP_MAX_N" step="1"
          :color="nValid ? undefined : 'error'" :aria-describedby="`${idPrefix}-mtp-hint`" @update:model-value="(v: string | number) => patch({ n: v === '' ? NaN : Number(v) })" />
        <span :id="`${idPrefix}-mtp-hint`" class="text-xs text-muted">{{ s.nHint }}</span>
      </div>
    </template>
  </section>
</template>
