<script setup lang="ts">
import { t } from '../composables/useLocale'
import { normalizeCustomMirror } from '~~/server/core/mirrors'

const s = t.mirror
const { doc, saving, save } = useSettings()
const text = ref('')
watch(() => doc.value?.mirror.custom, (v) => { text.value = v ?? '' }, { immediate: true })
const dirty = computed(() => text.value.trim() !== (doc.value?.mirror.custom ?? ''))
const bad = computed(() => normalizeCustomMirror(text.value) === null)
const submit = () => save('mirror', { mirror: { custom: text.value } })
</script>

<template>
  <AppCard :title="s.settingsTitle" :hint="s.settingsHint">
    <div class="flex flex-wrap items-center gap-2">
      <UInput v-model="text" size="sm" class="min-w-0 flex-1 basis-72" :placeholder="s.settingsPlaceholder" :color="bad ? 'error' : undefined" :aria-label="s.settingsLabel" />
      <UButton size="sm" icon="i-lucide-save" :disabled="!dirty || bad" :loading="saving === 'mirror'" @click="submit">
        {{ t.settings.save }}
      </UButton>
    </div>
  </AppCard>
</template>
