<script setup lang="ts">
// Client addresses (own tunnel: the saved domain plus every host name the tunnel routes to this
// entry; quick tunnel: the address cloudflared printed) and
// the self-check: the server requests each address without a key and expects 401.
import t from '~~/i18n/zh-CN'
import type { CheckResult } from '~~/server/core/public-check'
import { publicAddresses } from '~~/server/core/public-addresses'

const props = defineProps<{ autoCheck?: boolean }>()
const p = t.publicAccess
const c = p.check
const { doc } = useSettings()
const { state } = useLive()
const toast = useToast()

const quick = computed(() => doc.value?.public.tunnelMode === 'quick')
const addresses = computed(() => (doc.value ? publicAddresses(doc.value.public, state.value?.tunnel ?? { hostnames: null, quickHost: null }) : []))
const results = ref<Record<string, CheckResult>>({})
const checking = ref(false)

async function check() {
  if (checking.value) return
  checking.value = true
  try {
    const r = await $fetch<{ results: CheckResult[] }>('/api/public/check', { method: 'POST' })
    results.value = Object.fromEntries(r.results.map(x => [x.host, x]))
  } catch (e) {
    toast.add({ title: p.actionFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    checking.value = false
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: p.overview.copied, color: 'success', icon: 'i-lucide-check' })
  } catch { /* clipboard blocked: the address is selectable */ }
}

function resultText(r: CheckResult): string {
  if (r.code === 'ok') return fmt(c.ok, { ms: r.ms })
  // 530 while this machine's tunnel is not connected: the cause is here, not the DNS record.
  if (r.code === 'tunnel-down' && !connected.value) return c.tunnelDownLocal
  return fmt(c.codes[r.code], { detail: r.detail })
}
const anyFailed = computed(() => Object.values(results.value).some(r => r.code !== 'ok'))

// Check once as soon as the tunnel is connected (guide's last step).
const connected = computed(() => state.value?.tunnel.status.state === 'connected')
watch(connected, (v) => { if (v && props.autoCheck) void check() }, { immediate: true })
</script>

<template>
  <div class="space-y-2">
    <p v-if="!addresses.length" class="text-sm text-muted">
      {{ quick ? p.overview.noAddressQuick : p.overview.noAddress }}
    </p>
    <ul v-else class="space-y-2">
      <li v-for="h in addresses" :key="h" class="space-y-0.5">
        <div class="flex min-w-0 items-center gap-1">
          <code class="min-w-0 break-all font-mono text-sm text-default">https://{{ h }}/v1</code>
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy" :aria-label="p.overview.copy" @click="copy(`https://${h}/v1`)" />
        </div>
        <p v-if="results[h]" class="flex gap-1.5 text-xs" :class="results[h]!.code === 'ok' ? 'text-success' : 'text-error'">
          <UIcon :name="results[h]!.code === 'ok' ? 'i-lucide-check' : 'i-lucide-x'" class="mt-0.5 size-3.5 shrink-0" />
          <span class="min-w-0 break-words">{{ resultText(results[h]!) }}</span>
        </p>
      </li>
    </ul>
    <p v-if="anyFailed" class="text-xs text-muted">
      {{ c.blocked }}
    </p>
    <div class="flex flex-wrap items-center gap-2">
      <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-activity" :loading="checking" :disabled="!addresses.length" @click="check">
        {{ checking ? c.running : c.button }}
      </UButton>
      <span class="text-xs text-dimmed">{{ c.hint }}</span>
    </div>
  </div>
</template>
