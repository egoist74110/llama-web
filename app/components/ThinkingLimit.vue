<script setup lang="ts">
import t from '~~/i18n/zh-CN'
import { validThinkingLimit } from '~~/server/core/thinking-limit'

const props = defineProps<{ modelValue: number | string, enabled: boolean, idPrefix: string, disabled?: boolean, legacyDisabled?: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
const expanded = ref(false)
const s = t.models.thinkingLimit
const valid = computed(() => props.modelValue !== '' && validThinkingLimit(Number(props.modelValue)))
// Keep an explicit re-entry of legacy raw zero observable, even when the display stays zero.
function input(event: Event) { emit('update:modelValue', (event.target as HTMLInputElement).value) }
</script>

<template>
  <div v-if="enabled" class="w-full space-y-2">
    <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-settings-2" :aria-label="s.action"
      :aria-expanded="expanded" :aria-controls="`${idPrefix}-thinking-panel`" @click="expanded = !expanded">{{ s.settings }}</UButton>
    <div v-if="expanded" :id="`${idPrefix}-thinking-panel`" class="space-y-2 rounded-md border border-default p-3">
      <slot />
      <p v-if="legacyDisabled" class="m-0 text-xs text-warning">{{ s.legacyDisabled }}</p>
      <div class="flex flex-wrap items-center gap-2">
        <label :for="`${idPrefix}-thinking-limit`" class="text-sm">{{ s.title }}</label>
        <UInput :id="`${idPrefix}-thinking-limit`" :model-value="String(modelValue)" type="number" :min="0" step="1" class="w-36" :disabled="disabled"
          :color="valid || disabled ? undefined : 'error'" :aria-describedby="`${idPrefix}-thinking-hint`"
          @input="input" />
      </div>
      <p :id="`${idPrefix}-thinking-hint`" class="m-0 text-xs text-muted">{{ s.hint }}</p>
      <p v-if="!disabled && !valid" class="m-0 text-xs text-error">{{ s.invalid }}</p>
      <p class="m-0 text-xs text-muted">{{ s.extraHint }}</p>
    </div>
  </div>
</template>
