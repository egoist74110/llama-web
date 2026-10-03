<script setup lang="ts">
// Live state of the public path: the entry listener (127.0.0.1:port) and the hosted tunnel
// (cloudflared), with retry and the last output on errors. Used by the guide and the overview.
import t from '~~/i18n/zh-CN'

const s = t.tunnel
const p = t.publicAccess
const { doc } = useSettings()
const { state, serverNow } = useLive()
const toast = useToast()
const busy = ref(false)

const pub = computed(() => doc.value?.public)
const info = computed(() => state.value?.tunnel ?? null)

const entry = computed(() => {
  const st = pub.value?.status
  const e = t.settings.public.status
  if (!st) return null
  switch (st.state) {
    case 'off': return { text: e.off, color: 'text-muted', icon: 'i-lucide-circle' }
    case 'unavailable': return { text: e.unavailable, color: 'text-muted', icon: 'i-lucide-circle' }
    case 'listening': return { text: fmt(e.listening, { address: `${st.host}:${st.port}` }), color: 'text-success', icon: 'i-lucide-check' }
    case 'error': return { text: fmt(e.error, { port: st.port, detail: st.detail }), color: 'text-error', icon: 'i-lucide-x' }
  }
  return null
})

const tunnel = computed(() => {
  const st = info.value?.status
  if (!st) return null
  switch (st.state) {
    case 'off': return { text: (s.off as Record<string, string>)[st.reason] ?? st.reason, color: 'text-muted', icon: 'i-lucide-circle' }
    case 'preparing': return { text: s.preparing[st.step], color: 'text-muted', icon: 'i-lucide-loader', spin: true }
    case 'starting': return { text: st.lastError ? fmt(s.startingError, { error: st.lastError }) : s.starting, color: 'text-muted', icon: 'i-lucide-loader', spin: true }
    case 'connected': return { text: fmt(s.connected, { n: st.connections }), color: 'text-success', icon: 'i-lucide-check' }
    case 'error': return { text: fmt(s.error, { reason: tunnelErrorText(st.code, st.detail) }), color: 'text-error', icon: 'i-lucide-x' }
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

async function retry() {
  if (busy.value) return
  busy.value = true
  try {
    await $fetch('/api/tunnel/retry', { method: 'POST' })
  } catch (e) {
    toast.add({ title: p.actionFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="space-y-2">
    <div v-for="row in [{ label: p.connect.entry, v: entry }, { label: p.connect.tunnel, v: tunnel }]" :key="row.label" class="flex items-start gap-2 text-sm">
      <UIcon v-if="row.v" :name="row.v.icon" class="mt-0.5 size-4 shrink-0" :class="[row.v.color, 'spin' in row.v && row.v.spin ? 'animate-spin' : '']" />
      <span class="w-16 shrink-0 text-muted">{{ row.label }}</span>
      <span class="min-w-0 break-words" :class="row.v?.color">{{ row.v?.text ?? '-' }}</span>
    </div>
    <div v-if="errorState" class="flex flex-wrap items-center gap-2 pl-6">
      <span class="text-xs text-muted">{{ retryText }}</span>
      <UButton size="xs" color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="busy" @click="retry">
        {{ s.retryNow }}
      </UButton>
    </div>
    <details v-if="errorState?.tail.length" class="pl-6 text-xs">
      <summary class="cursor-pointer text-muted">
        {{ s.tail }}
      </summary>
      <pre class="mt-1 max-h-48 overflow-auto rounded-[10px] bg-muted p-2 font-mono text-[11px] leading-snug text-default">{{ errorState.tail.join('\n') }}</pre>
    </details>
  </div>
</template>
