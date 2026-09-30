<script setup lang="ts">
// Listening port, llama-server port range, timeouts; the online limit is shown read-only.
import t from '~~/i18n/zh-CN'

const s = t.settings.server
const { doc, saving, save } = useSettings()

const f = reactive({ port: '', from: '', to: '', load: '', drain: '' })
const initial = ref('')
function reset() {
  const v = doc.value?.server
  Object.assign(f, {
    port: String(v?.port ?? ''), from: String(v?.portRange[0] ?? ''), to: String(v?.portRange[1] ?? ''),
    load: String(v?.loadTimeoutSec ?? ''), drain: String(v?.drainTimeoutSec ?? ''),
  })
  initial.value = JSON.stringify(f)
}
watch(() => JSON.stringify(doc.value?.server), reset, { immediate: true })

const dirty = computed(() => JSON.stringify(f) !== initial.value)
const intIn = (v: string, min: number, max: number) => /^\d+$/.test(v.trim()) && Number(v) >= min && Number(v) <= max
const bad = computed(() => ({
  port: !intIn(f.port, 1024, 65535),
  from: !intIn(f.from, 1024, 65535),
  to: !intIn(f.to, 1024, 65535) || Number(f.to) < Number(f.from),
  load: !intIn(f.load, 10, 7200),
  drain: !intIn(f.drain, 5, 7200),
}))
const anyBad = computed(() => Object.values(bad.value).some(Boolean))
const set = (key: keyof typeof f, v: string | number | undefined) => { f[key] = v == null ? '' : String(v) }

const submit = () => save('server', {
  server: { port: Number(f.port), portRange: [Number(f.from), Number(f.to)], loadTimeoutSec: Number(f.load), drainTimeoutSec: Number(f.drain) },
})
</script>

<template>
  <AppCard :title="s.title" :hint="s.hint">
    <div class="divide-y divide-default">
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ s.port }}
          </p>
          <p class="text-xs text-muted">
            {{ s.portHint }}
          </p>
        </div>
        <UInput :model-value="f.port" type="number" size="sm" class="w-40" :color="bad.port ? 'error' : undefined" :aria-label="s.port" @update:model-value="(v: string | number | undefined) => set('port', v)" />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ s.portRange }}
          </p>
          <p class="text-xs text-muted">
            {{ s.portRangeHint }}
          </p>
        </div>
        <div class="flex items-center gap-2 text-xs text-muted">
          {{ s.from }}
          <UInput :model-value="f.from" type="number" size="sm" class="w-24" :color="bad.from ? 'error' : undefined" :aria-label="s.from" @update:model-value="(v: string | number | undefined) => set('from', v)" />
          {{ s.to }}
          <UInput :model-value="f.to" type="number" size="sm" class="w-24" :color="bad.to ? 'error' : undefined" :aria-label="s.to" @update:model-value="(v: string | number | undefined) => set('to', v)" />
        </div>
      </div>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ s.loadTimeout }}
          </p>
          <p class="text-xs text-muted">
            {{ s.loadTimeoutHint }}
          </p>
        </div>
        <UInput :model-value="f.load" type="number" size="sm" class="w-40" :color="bad.load ? 'error' : undefined" :aria-label="s.loadTimeout" @update:model-value="(v: string | number | undefined) => set('load', v)" />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ s.drainTimeout }}
          </p>
          <p class="text-xs text-muted">
            {{ s.drainTimeoutHint }}
          </p>
        </div>
        <UInput :model-value="f.drain" type="number" size="sm" class="w-40" :color="bad.drain ? 'error' : undefined" :aria-label="s.drainTimeout" @update:model-value="(v: string | number | undefined) => set('drain', v)" />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ s.maxLoaded }}
          </p>
          <p class="text-xs text-muted">
            {{ s.maxLoadedHint }}
          </p>
        </div>
        <span class="w-40 text-sm text-muted">{{ fmt(s.maxLoadedValue, { n: doc?.server.maxLoaded ?? 1 }) }}</span>
      </div>
    </div>
    <div class="mt-4 flex flex-wrap items-center gap-2">
      <UButton size="sm" icon="i-lucide-save" :disabled="!dirty || anyBad" :loading="saving === 'server'" @click="submit">
        {{ t.settings.save }}
      </UButton>
      <UButton v-if="dirty" size="sm" color="neutral" variant="ghost" @click="reset">
        {{ t.settings.reset }}
      </UButton>
      <span v-if="dirty" class="text-xs text-warning">{{ t.settings.dirty }}</span>
    </div>
    <p v-if="doc?.restartRequired" class="mt-3 text-xs text-warning">
      {{ fmt(s.restartRequired, { port: doc.server.port, current: doc.bootPort }) }}
    </p>
  </AppCard>
</template>
