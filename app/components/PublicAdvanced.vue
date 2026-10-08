<script setup lang="ts">
// "Advanced" part of the public access overview: entry port, hosting switch, replacing / clearing
// the tunnel token, clearing the Cloudflare API token, and where cloudflared comes from.
import { t } from '../composables/useLocale'

const p = t.publicAccess
const o = p.overview
const s = t.tunnel
const { doc, saving, save, load } = useSettings()
const { state } = useLive()
const cf = useCloudflareSetup()
const toast = useToast()

const pub = computed(() => doc.value?.public)
const port = ref('')
watch(() => pub.value?.port, (v) => { port.value = String(v ?? '') }, { immediate: true })
const badPort = computed(() => !/^\d+$/.test(port.value.trim()) || Number(port.value) < 1024 || Number(port.value) > 65535)
const savePort = () => save('public-port', { public: { port: Number(port.value) } })
const quick = computed(() => pub.value?.tunnelMode === 'quick')
// Computeds: the option labels follow the interface language.
const modeItems = computed(() => [{ label: o.modeOwn, value: 'token' }, { label: o.modeQuick, value: 'quick' }])
const protocolItems = computed(() => [{ label: o.protocolHttp2, value: 'http2' }, { label: o.protocolQuic, value: 'quic' }])
const setMode = (v: string) => { if (v !== pub.value?.tunnelMode) void save('public-mode', { public: { tunnelMode: v } }, { quiet: true }).then(ok => ok && toast.add({ title: o.modeSaved, color: 'success', icon: 'i-lucide-check' })) }
const setProtocol = (v: string) => { if (v !== pub.value?.tunnelProtocol) void save('public-protocol', { public: { tunnelProtocol: v } }, { quiet: true }) }
const toggle = (v: boolean) => save('public-tunnel', { public: { tunnelEnabled: v } }, { quiet: true })

const token = ref('')
const busy = ref('')
async function saveToken(value: string) {
  if (busy.value) return
  busy.value = 'token'
  try {
    await $fetch('/api/tunnel/token', { method: 'POST', body: { token: value } })
    toast.add({ title: value ? s.saved : s.cleared, color: 'success', icon: 'i-lucide-check' })
    token.value = ''
    await load()
  } catch (e) {
    toast.add({ title: p.actionFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    busy.value = ''
  }
}

onMounted(() => { if (!cf.info.value.loaded) void cf.loadInfo() })
const exeText = computed(() => {
  const exe = state.value?.tunnel.cloudflared
  if (!exe) return p.path.cloudflaredState[pub.value?.cloudflared ?? 'none']
  return exe.version ? `${s.cloudflaredFrom[exe.source]}，${fmt(s.cloudflaredVersion, { v: exe.version })}` : s.cloudflaredFrom[exe.source]
})
const setPort = (v: string | number | undefined) => { port.value = v == null ? '' : String(v) }
</script>

<template>
  <div class="divide-y divide-default">
    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 pb-3">
      <div class="min-w-0 flex-1 basis-56">
        <p class="text-sm text-default">
          {{ t.settings.public.port }}
        </p>
        <p class="text-xs text-muted">
          {{ t.settings.public.portHint }}
        </p>
      </div>
      <div class="flex items-center gap-2">
        <UInput :model-value="port" type="number" size="sm" class="w-28" :color="badPort ? 'error' : undefined" :aria-label="t.settings.public.port" @update:model-value="setPort" />
        <UButton size="sm" icon="i-lucide-save" :disabled="badPort || Number(port) === pub?.port" :loading="saving === 'public-port'" @click="savePort">
          {{ t.settings.save }}
        </UButton>
      </div>
    </div>

    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div class="min-w-0 flex-1 basis-56">
        <p class="text-sm text-default">
          {{ o.tunnelSwitch }}
        </p>
        <p class="text-xs text-muted">
          {{ o.tunnelSwitchHint }}
        </p>
      </div>
      <USwitch :model-value="pub?.tunnelEnabled ?? false" :disabled="saving === 'public-tunnel'" :aria-label="o.tunnelSwitch" @update:model-value="toggle" />
    </div>

    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div class="min-w-0 flex-1 basis-56">
        <p class="text-sm text-default">
          {{ o.modeSwitch }}
        </p>
        <p class="text-xs text-muted">
          {{ o.modeSwitchHint }}
        </p>
      </div>
      <USelect :model-value="pub?.tunnelMode" :items="modeItems" size="sm" class="w-40" :disabled="saving === 'public-mode'" :aria-label="o.modeSwitch" @update:model-value="setMode" />
    </div>

    <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3">
      <div class="min-w-0 flex-1 basis-56">
        <p class="text-sm text-default">
          {{ o.protocol }}
        </p>
        <p class="text-xs text-muted">
          {{ o.protocolHint }}
        </p>
      </div>
      <USelect :model-value="pub?.tunnelProtocol" :items="protocolItems" size="sm" class="w-full sm:w-80" :disabled="saving === 'public-protocol'" :aria-label="o.protocol" @update:model-value="setProtocol" />
    </div>

    <div v-if="!quick" class="space-y-2 py-3">
      <div>
        <p class="text-sm text-default">
          {{ s.token }}
        </p>
        <p class="text-xs text-muted">
          {{ s.tokenHint }}
        </p>
      </div>
      <p class="break-all text-xs" :class="pub?.tunnel.hasToken ? 'text-success' : 'text-muted'">
        {{ pub?.tunnel.hasToken ? fmt(s.tokenSaved, { masked: pub.tunnel.maskedToken ?? '' }) : s.tokenNone }}
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <UInput v-model="token" type="password" size="sm" class="min-w-0 flex-1 basis-56" autocomplete="off" :placeholder="s.tokenPlaceholder" :aria-label="s.token" />
        <UButton size="sm" icon="i-lucide-save" :disabled="!token.trim()" :loading="busy === 'token'" @click="saveToken(token)">
          {{ s.saveToken }}
        </UButton>
        <UButton v-if="pub?.tunnel.hasToken" size="sm" color="neutral" variant="ghost" icon="i-lucide-trash-2" :disabled="!!busy" @click="saveToken('')">
          {{ s.clearToken }}
        </UButton>
      </div>
    </div>

    <div class="space-y-2 py-3">
      <div>
        <p class="text-sm text-default">
          {{ o.apiToken }}
        </p>
        <p class="text-xs text-muted">
          {{ o.apiTokenHint }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <span class="break-all text-xs" :class="cf.info.value.hasToken ? 'text-success' : 'text-muted'">
          {{ cf.info.value.hasToken ? fmt(t.cloudflare.tokenSaved, { masked: cf.info.value.maskedToken ?? '' }) : t.cloudflare.tokenNone }}
        </span>
        <UButton v-if="cf.info.value.hasToken" size="xs" color="neutral" variant="ghost" icon="i-lucide-trash-2" :disabled="!!cf.busy.value" @click="cf.saveToken('')">
          {{ t.cloudflare.clearToken }}
        </UButton>
      </div>
    </div>

    <p class="pt-3 text-xs text-muted">
      {{ s.cloudflared }}：{{ exeText }}
    </p>
  </div>
</template>
