<script setup lang="ts">
// Network card (decision 63): the proxy used for GitHub, mirrors and the Cloudflare API, where downloads
// come from (ask / automatic fallback to a mirror / a fixed mirror), and the user's own mirror prefix.
import { t } from '../composables/useLocale'
import { customMirror, MIRRORS, normalizeCustomMirror } from '~~/server/core/mirrors'

type ProxyMode = 'system' | 'manual' | 'off'
type Source = 'ask' | 'auto' | 'mirror'

const s = t.settings.network
const { doc, saving, save } = useSettings()

const f = reactive({ mode: 'system' as ProxyMode, url: '', source: 'ask' as Source, mirror: MIRRORS[0]!.id, custom: '' })
const initial = ref('')
function reset() {
  const n = doc.value?.network
  Object.assign(f, {
    mode: n?.proxy.mode ?? 'system',
    url: n?.proxy.url ?? '',
    source: n?.downloadSource ?? 'ask',
    // '' = the first built-in mirror.
    mirror: n?.mirror || MIRRORS[0]!.id,
    custom: doc.value?.mirror.custom ?? '',
  })
  initial.value = JSON.stringify(f)
}
watch(() => JSON.stringify([doc.value?.network, doc.value?.mirror]), reset, { immediate: true })

const dirty = computed(() => JSON.stringify(f) !== initial.value)
const modeItems = computed(() => (['system', 'manual', 'off'] as const).map(v => ({ value: v, label: s.proxyModes[v] })))
const sourceItems = computed(() => (['ask', 'auto', 'mirror'] as const).map(v => ({ value: v, label: s.sources[v], description: s.sourceHints[v] })))
const own = computed(() => customMirror(f.custom))
const mirrorItems = computed(() => [
  ...MIRRORS.map(m => ({ value: m.id, label: m.host })),
  ...(own.value ? [{ value: own.value.id, label: `${own.value.host} (${t.mirror.custom})` }] : []),
])
const bad = computed(() => ({
  // The server has the final word (and explains it); this only catches the obvious cases early.
  url: f.mode === 'manual' ? !/^https?:\/\/\S+$/i.test(f.url.trim()) : !!f.url.trim() && !/^https?:\/\/\S+$/i.test(f.url.trim()),
  custom: normalizeCustomMirror(f.custom) === null,
  mirror: f.source === 'mirror' && f.mirror === 'custom' && !own.value,
}))
const anyBad = computed(() => Object.values(bad.value).some(Boolean))

const submit = () => save('network', {
  network: { proxy: { mode: f.mode, url: f.url.trim() }, downloadSource: f.source, mirror: f.mirror },
  mirror: { custom: f.custom.trim() },
})
</script>

<template>
  <AppCard :title="s.title" :hint="s.hint">
    <div class="divide-y divide-default">
      <div class="flex flex-col gap-2 pb-3">
        <p class="text-sm text-default">
          {{ s.proxy }}
        </p>
        <div class="lw-seg self-start" role="radiogroup" :aria-label="s.proxy">
          <button
            v-for="m in modeItems"
            :key="m.value"
            type="button"
            role="radio"
            :aria-checked="f.mode === m.value"
            :class="{ on: f.mode === m.value }"
            @click="f.mode = m.value"
          >
            {{ m.label }}
          </button>
        </div>
        <template v-if="f.mode === 'manual'">
          <UInput
            v-model="f.url"
            size="sm"
            class="w-full max-w-md"
            :placeholder="s.proxyPlaceholder"
            :color="bad.url ? 'error' : undefined"
            :aria-label="s.proxyUrl"
            :ui="{ base: 'font-mono text-xs' }"
          />
          <p class="m-0 text-xs text-muted">
            {{ s.proxyHint }}
          </p>
        </template>
        <p v-else-if="f.mode === 'system'" class="m-0 text-xs text-muted">
          {{ s.proxySystemHint }}
        </p>
      </div>

      <div class="flex flex-col gap-2 py-3">
        <p class="text-sm text-default">
          {{ s.source }}
        </p>
        <URadioGroup v-model="f.source" :items="sourceItems" size="sm" :aria-label="s.source" />
        <div v-if="f.source !== 'ask'" class="flex flex-wrap items-center gap-2 pt-1">
          <span class="text-xs text-muted">{{ s.mirror }}</span>
          <USelect v-model="f.mirror" :items="mirrorItems" size="sm" class="w-56 max-w-full" :color="bad.mirror ? 'error' : undefined" :aria-label="s.mirror" />
        </div>
        <p class="m-0 text-xs text-muted">
          {{ s.digestNote }}
        </p>
      </div>

      <div class="flex flex-col gap-2 pt-3">
        <div>
          <p class="text-sm text-default">
            {{ s.customMirror }}
          </p>
          <p class="text-xs text-muted">
            {{ s.customMirrorHint }}
          </p>
        </div>
        <UInput
          v-model="f.custom"
          size="sm"
          class="w-full max-w-md"
          :placeholder="t.mirror.settingsPlaceholder"
          :color="bad.custom ? 'error' : undefined"
          :aria-label="t.mirror.settingsLabel"
        />
      </div>
    </div>
    <div class="mt-4 flex flex-wrap items-center gap-2">
      <UButton size="sm" icon="i-lucide-save" :disabled="!dirty || anyBad" :loading="saving === 'network'" @click="submit">
        {{ t.settings.save }}
      </UButton>
      <UButton v-if="dirty" size="sm" color="neutral" variant="ghost" @click="reset">
        {{ t.settings.reset }}
      </UButton>
      <span v-if="dirty" class="text-xs text-warning">{{ t.settings.dirty }}</span>
    </div>
  </AppCard>
</template>
