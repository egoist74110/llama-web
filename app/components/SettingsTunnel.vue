<script setup lang="ts">
// Cloudflare tunnel hosted by llama-web: on/off, tunnel token (masked, saved on the server),
// live status from the snapshot, the client address, and the step-by-step guide.
import t from '~~/i18n/zh-CN'

const s = t.tunnel
const { doc, saving, save, load } = useSettings()
const { state, serverNow } = useLive()
const toast = useToast()

const token = ref('')
const busy = ref('')

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}
const fail = (e: unknown) => toast.add({ title: s.actionFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })

const pub = computed(() => doc.value?.public)
const info = computed(() => state.value?.tunnel ?? null)
const ingress = computed(() => `127.0.0.1:${pub.value?.port ?? 8080}`)
const address = computed(() => (pub.value?.domain ? `https://${pub.value.domain}/v1` : ''))

const toggle = (v: boolean) => save('tunnel', { public: { tunnelEnabled: v } }, { quiet: true })

async function saveToken(value: string) {
  if (busy.value) return
  busy.value = 'token'
  try {
    await $fetch('/api/tunnel/token', { method: 'POST', body: { token: value } })
    toast.add({ title: value ? s.saved : s.cleared, color: 'success', icon: 'i-lucide-check' })
    token.value = ''
    await load()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

async function retry() {
  if (busy.value) return
  busy.value = 'retry'
  try {
    await $fetch('/api/tunnel/retry', { method: 'POST' })
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

const status = computed(() => {
  const st = info.value?.status
  if (!st) return null
  switch (st.state) {
    case 'off': return { text: (s.off as Record<string, string>)[st.reason] ?? st.reason, color: 'text-muted' }
    case 'preparing': return { text: s.preparing[st.step], color: 'text-muted' }
    case 'starting': return { text: st.lastError ? fmt(s.startingError, { error: st.lastError }) : s.starting, color: 'text-muted' }
    case 'connected': return { text: fmt(s.connected, { n: st.connections }), color: 'text-success' }
    case 'error': return { text: fmt(s.error, { reason: tunnelErrorText(st.code, st.detail) }), color: 'text-error' }
  }
  return null
})
const errorState = computed(() => (info.value?.status.state === 'error' ? info.value.status : null))
const retryText = computed(() => {
  const e = errorState.value
  if (!e) return ''
  if (e.retryAt === null) return s.noRetry
  return fmt(s.retryIn, { n: Math.max(0, Math.ceil((e.retryAt - serverNow.value) / 1000)) })
})
const exe = computed(() => info.value?.cloudflared ?? null)
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
        <USwitch :model-value="pub?.tunnelEnabled ?? false" :disabled="saving === 'tunnel'" :aria-label="s.enabled" @update:model-value="toggle" />
      </div>
      <div class="space-y-2 pt-3">
        <div>
          <p class="text-sm text-default">
            {{ s.token }}
          </p>
          <p class="text-xs text-muted">
            {{ s.tokenHint }}
          </p>
        </div>
        <p class="text-xs" :class="pub?.tunnel.hasToken ? 'text-success' : 'text-muted'">
          {{ pub?.tunnel.hasToken ? fmt(s.tokenSaved, { masked: pub.tunnel.maskedToken ?? '' }) : s.tokenNone }}
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <UInput v-model="token" type="password" size="sm" class="min-w-0 flex-1 basis-64" autocomplete="off" :placeholder="s.tokenPlaceholder" :aria-label="s.token" />
          <UButton size="sm" icon="i-lucide-save" :disabled="!token.trim()" :loading="busy === 'token'" @click="saveToken(token)">
            {{ s.saveToken }}
          </UButton>
          <UButton v-if="pub?.tunnel.hasToken" size="sm" color="neutral" variant="ghost" icon="i-lucide-trash-2" :disabled="busy === 'token'" @click="saveToken('')">
            {{ s.clearToken }}
          </UButton>
        </div>
      </div>
    </div>

    <div class="mt-4 space-y-2 border-t border-default pt-4">
      <p v-if="status" class="text-sm">
        <span class="text-muted">{{ s.status }}</span>
        <span class="ml-2" :class="status.color">{{ status.text }}</span>
      </p>
      <div v-if="errorState" class="flex flex-wrap items-center gap-2">
        <span class="text-xs text-muted">{{ retryText }}</span>
        <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="busy === 'retry'" @click="retry">
          {{ s.retryNow }}
        </UButton>
      </div>
      <details v-if="errorState?.tail.length" class="text-xs">
        <summary class="cursor-pointer text-muted">
          {{ s.tail }}
        </summary>
        <pre class="mt-1 max-h-48 overflow-auto rounded-[var(--ui-radius)] bg-muted p-2 font-mono text-[11px] leading-snug text-default">{{ errorState.tail.join('\n') }}</pre>
      </details>
      <p v-if="exe" class="text-xs text-muted">
        {{ s.cloudflared }}：{{ s.cloudflaredFrom[exe.source] }}<template v-if="exe.version">，{{ fmt(s.cloudflaredVersion, { v: exe.version }) }}</template>
      </p>
      <p class="text-xs text-muted">
        <template v-if="address">
          {{ s.addressHint }}<code class="ml-1 font-mono text-default">{{ address }}</code>
        </template>
        <template v-else>
          {{ s.addressMissing }}
        </template>
      </p>
    </div>

    <TunnelGuide :ingress="ingress" />
  </AppCard>
</template>
