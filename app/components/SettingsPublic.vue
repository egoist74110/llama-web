<script setup lang="ts">
// Public entry for the Cloudflare tunnel: on/off, port, domain, tunnel name, listener status and
// the DNS command the user runs by hand.
import t from '~~/i18n/zh-CN'

const s = t.settings.public
const { doc, saving, save } = useSettings()
const toast = useToast()

const f = reactive({ enabled: false, port: '', domain: '', tunnelName: '' })
const initial = ref('')
function reset() {
  const p = doc.value?.public
  Object.assign(f, { enabled: p?.enabled ?? false, port: String(p?.port ?? ''), domain: p?.domain ?? '', tunnelName: p?.tunnelName ?? '' })
  initial.value = JSON.stringify(f)
}
watch(() => JSON.stringify(doc.value?.public), reset, { immediate: true })

const dirty = computed(() => JSON.stringify(f) !== initial.value)
const badPort = computed(() => !/^\d+$/.test(f.port.trim()) || Number(f.port) < 1024 || Number(f.port) > 65535)
const set = (key: 'port' | 'domain' | 'tunnelName', v: string | number | undefined) => { f[key] = v == null ? '' : String(v) }

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
const ingressUrl = computed(() => `http://127.0.0.1:${doc.value?.public.port ?? 8080}`)

const submit = () => save('public', {
  public: { enabled: f.enabled, port: Number(f.port), domain: f.domain.trim(), tunnelName: f.tunnelName.trim() },
})

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: s.copied, color: 'success', icon: 'i-lucide-check' })
  } catch { /* clipboard blocked: the text is selectable */ }
}
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
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
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
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pt-3">
        <div class="min-w-0 flex-1 basis-56">
          <p class="text-sm text-default">
            {{ s.tunnelName }}
          </p>
          <p class="text-xs text-muted">
            {{ s.tunnelNameHint }}
          </p>
        </div>
        <UInput :model-value="f.tunnelName" size="sm" class="w-64" :placeholder="s.tunnelNamePlaceholder" :aria-label="s.tunnelName" @update:model-value="(v: string | number | undefined) => set('tunnelName', v)" />
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
      <p class="text-sm text-default">
        {{ s.dnsTitle }}
      </p>
      <template v-if="doc?.public.dnsCommand">
        <p class="text-xs text-muted">
          {{ s.dnsHint }}
        </p>
        <div class="flex items-start gap-2">
          <code class="min-w-0 flex-1 break-all rounded-[var(--ui-radius)] bg-muted px-3 py-2 font-mono text-xs text-default">{{ doc.public.dnsCommand }}</code>
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy" :aria-label="s.copy" @click="copy(doc.public.dnsCommand)" />
        </div>
      </template>
      <p v-else class="text-xs text-muted">
        {{ s.dnsMissing }}
      </p>
      <p class="text-xs text-muted">
        {{ fmt(s.ingressHint, { url: ingressUrl }) }}
      </p>
    </div>
  </AppCard>
</template>
