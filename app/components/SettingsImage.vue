<script setup lang="ts">
import t from '~~/i18n/zh-CN'

const s = t.settings.image
const { doc, saving, save } = useSettings()

const state = reactive({ enabled: true, maxEdge: '', format: 'jpeg', quality: '' })
const initial = ref('')
function reset() {
  const i = doc.value?.image
  Object.assign(state, { enabled: i?.enabled ?? true, maxEdge: String(i?.maxEdge ?? ''), format: i?.format ?? 'jpeg', quality: String(i?.quality ?? '') })
  initial.value = JSON.stringify(state)
}
watch(() => JSON.stringify(doc.value?.image), reset, { immediate: true })

const dirty = computed(() => JSON.stringify(state) !== initial.value)
const intIn = (v: string, min: number, max: number) => /^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max
const badEdge = computed(() => !intIn(state.maxEdge, 64, 8192))
const badQuality = computed(() => !intIn(state.quality, 1, 100))
const formats = ['jpeg', 'png', 'webp']

const submit = () => save('image', { image: { enabled: state.enabled, maxEdge: Number(state.maxEdge), format: state.format, quality: Number(state.quality) } })
</script>

<template>
  <AppCard :title="s.title" :hint="s.hint">
    <div class="divide-y divide-default">
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ s.enabled }}
          </p>
          <p class="text-xs text-muted">
            {{ s.enabledHint }}
          </p>
        </div>
        <USwitch v-model="state.enabled" :aria-label="s.enabled" />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ s.maxEdge }}
          </p>
          <p class="text-xs text-muted">
            {{ s.maxEdgeHint }}
          </p>
        </div>
        <UInput :model-value="state.maxEdge" type="number" size="sm" class="w-40" :color="badEdge ? 'error' : undefined" :aria-label="s.maxEdge" @update:model-value="(v: string | number | undefined) => { state.maxEdge = v == null ? '' : String(v) }" />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
        <p class="min-w-0 flex-1 basis-56 text-sm text-default">
          {{ s.format }}
        </p>
        <USelect v-model="state.format" :items="formats" size="sm" class="w-40" :aria-label="s.format" />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ s.quality }}
          </p>
          <p class="text-xs text-muted">
            {{ s.qualityHint }}
          </p>
        </div>
        <UInput :model-value="state.quality" type="number" size="sm" class="w-40" :color="badQuality ? 'error' : undefined" :aria-label="s.quality" @update:model-value="(v: string | number | undefined) => { state.quality = v == null ? '' : String(v) }" />
      </div>
    </div>
    <div class="mt-4 flex flex-wrap items-center gap-2">
      <UButton size="sm" icon="i-lucide-save" :disabled="!dirty || badEdge || badQuality" :loading="saving === 'image'" @click="submit">
        {{ t.settings.save }}
      </UButton>
      <UButton v-if="dirty" size="sm" color="neutral" variant="ghost" @click="reset">
        {{ t.settings.reset }}
      </UButton>
      <span v-if="dirty" class="text-xs text-warning">{{ t.settings.dirty }}</span>
    </div>
  </AppCard>
</template>
