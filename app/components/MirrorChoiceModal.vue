<script setup lang="ts">
// Mounted once in the layout. After a check or download that the user started failed because
// GitHub could not be reached (the server marks the failure with `offer`), asks which public
// mirror to retry through. Automatic checks never reach this dialog.
import t from '~~/i18n/zh-CN'
import { customMirror, offeredMirrors } from '~~/server/core/mirrors'

const s = t.mirror
const { state } = useLive()
const toast = useToast()
const { doc, load } = useSettings()
// The user's own mirror (settings) comes last; read fresh when the dialog opens.
const mirrors = computed(() => {
  const own = customMirror(doc.value?.mirror.custom)
  return [...offeredMirrors(), ...(own ? [own] : [])]
})

interface Offer {
  key: string
  what: string
  reason: string
  retry: (mirror: string) => Promise<unknown>
}

const offers = computed<Offer[]>(() => {
  const out: Offer[] = []
  const reasonOf = (code: string) => (t.status.runtime.errors as Record<string, string>)[code] ?? code
  const llama = (rt: { state: string, code?: string, detail?: string, offer?: 'check' | 'download' } | undefined, channel?: string) => {
    if (rt?.state !== 'error' || !rt.offer) return
    const action = rt.offer
    out.push({
      key: `llama:${channel ?? 'main'}:${action}:${rt.code}:${rt.detail}`,
      what: s.whatLlama,
      reason: reasonOf(rt.code ?? ''),
      retry: mirror => $fetch(`/api/llamacpp/${action}`, { method: 'POST', body: { mirror, ...(channel ? { channel } : {}) } }),
    })
  }
  const l = state.value?.llamacpp
  llama(l?.runtime as never)
  llama(l?.secondary?.runtime as never, l?.secondary?.accel)
  const a = state.value?.appUpdate
  if (a?.check.state === 'error' && a.check.offer) {
    out.push({ key: `app:check:${a.check.code}:${a.check.at}`, what: s.whatApp, reason: appUpdateErrorText(a.check.code), retry: mirror => $fetch('/api/app-update/check', { method: 'POST', body: { mirror } }) })
  }
  if (a?.download.state === 'error' && a.download.offer) {
    out.push({ key: `app:download:${a.download.code}:${a.download.version}`, what: s.whatApp, reason: appUpdateErrorText(a.download.code), retry: mirror => $fetch('/api/app-update/download', { method: 'POST', body: { mirror } }) })
  }
  return out
})

// Cancelled offers stay closed until the failure goes away (a new attempt clears it).
const dismissed = ref<string | null>(null)
const current = computed(() => offers.value.find(o => o.key !== dismissed.value) ?? null)
watch(() => current.value?.key, (k) => { if (k) void load() })
watch(offers, (list) => { if (!list.length) dismissed.value = null })

const busy = ref(false)
const open = computed({
  get: () => current.value !== null,
  set: (v: boolean) => { if (!v && current.value) dismissed.value = current.value.key },
})

async function use(id: string) {
  const offer = current.value
  if (!offer || busy.value) return
  busy.value = true
  dismissed.value = offer.key
  try {
    await offer.retry(id)
  } catch (e) {
    const err = e as { data?: { message?: string }, message?: string }
    toast.add({ title: s.title, description: err.data?.message ?? err.message, color: 'error', icon: 'i-lucide-circle-alert' })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="s.title" :description="current ? fmt(s.body, { what: current.what, reason: current.reason }) : ''">
    <template #body>
      <div class="flex flex-col gap-2.5">
        <UButton
          v-for="(m, i) in mirrors"
          :key="m.id"
          :color="i === 0 ? 'primary' : 'neutral'"
          :variant="i === 0 ? 'solid' : 'outline'"
          icon="i-lucide-globe"
          :loading="busy"
          block
          @click="use(m.id)"
        >
          {{ fmt(s.use, { host: m.host }) }}
          <span class="text-xs opacity-80">（{{ m.id === 'custom' ? s.custom : i === 0 ? s.recommended : s.alternative }}）</span>
        </UButton>
        <p class="m-0 mt-1 text-xs text-muted">
          {{ s.risk }}
        </p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end">
        <UButton size="sm" color="neutral" variant="ghost" @click="open = false">
          {{ s.cancel }}
        </UButton>
      </div>
    </template>
  </UModal>
</template>
