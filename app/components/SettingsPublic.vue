<script setup lang="ts">
// Public entry (the port the Cloudflare tunnel points at): on/off, port, domain, listener status.
// The tunnel itself is the next card (SettingsTunnel).
import t from '~~/i18n/zh-CN'

const s = t.settings.public
const { doc, saving, save } = useSettings()

const f = reactive({ enabled: false, port: '', domain: '' })
const initial = ref('')
function reset() {
  const p = doc.value?.public
  Object.assign(f, { enabled: p?.enabled ?? false, port: String(p?.port ?? ''), domain: p?.domain ?? '' })
  initial.value = JSON.stringify(f)
}
watch(() => JSON.stringify(doc.value?.public), reset, { immediate: true })

const dirty = computed(() => JSON.stringify(f) !== initial.value)
const badPort = computed(() => !/^\d+$/.test(f.port.trim()) || Number(f.port) < 1024 || Number(f.port) > 65535)
const set = (key: 'port' | 'domain', v: string | number | undefined) => { f[key] = v == null ? '' : String(v) }

const status = computed(() => {
  const st = doc.value?.public.status
  if (!st) return null
  switch (st.state) {
    case 'off': return { text: s.status.off, color: 'text-muted' }
    case 'unavailable': return { text: s.status.unavailable, color: 'text-muted' }
    case 'listening': return { text: fmt(s.status.listening, { address: `${st.host}:${st.port}` }), color: 'text-success' }
    case 'error': return { text: fmt(s.status.error, { port: st.port, detail: st.detail }), color: 'text-error' }
  }
  return null
})

const submit = () => save('public', {
  public: { enabled: f.enabled, port: Number(f.port), domain: f.domain.trim() },
})
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
        <USwitch v-model="f.enabled" :aria-label="s.enabled" />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ s.port }}
          </p>
          <p class="text-xs text-muted">
            {{ s.portHint }}
          </p>
        </div>
        <UInput :model-value="f.port" type="number" size="sm" class="w-40" :color="badPort ? 'error' : undefined" :aria-label="s.port" @update:model-value="(v: string | number | undefined) => set('port', v)" />
      </div>
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ s.domain }}
          </p>
          <p class="text-xs text-muted">
            {{ s.domainHint }}
          </p>
        </div>
        <UInput :model-value="f.domain" size="sm" class="w-64" :placeholder="s.domainPlaceholder" :aria-label="s.domain" @update:model-value="(v: string | number | undefined) => set('domain', v)" />
      </div>
    </div>
    <div class="mt-4 flex flex-wrap items-center gap-2">
      <UButton size="sm" icon="i-lucide-save" :disabled="!dirty || badPort" :loading="saving === 'public'" @click="submit">
        {{ t.settings.save }}
      </UButton>
      <UButton v-if="dirty" size="sm" color="neutral" variant="ghost" @click="reset">
        {{ t.settings.reset }}
      </UButton>
      <span v-if="dirty" class="text-xs text-warning">{{ t.settings.dirty }}</span>
    </div>

    <div class="mt-4 space-y-2 border-t border-default pt-4">
      <p v-if="status" class="text-xs" :class="status.color">
        {{ status.text }}
      </p>
      <p v-if="doc?.public.enabled && doc.public.activeKeys === 0" class="text-xs text-warning">
        {{ s.noKeys }}
      </p>
    </div>
  </AppCard>
</template>
