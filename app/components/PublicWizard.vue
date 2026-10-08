<script setup lang="ts">
// The public access guide (4-6). Steps are filled with defaults where possible and confirmed one
// by one; what a step confirms is saved at once, and the current step is saved on the server
// (settings.public.wizard), so the guide continues where it was left. Three branches: Cloudflare
// API token (one click, the 4-5 flow), the dashboard guide + pasted tunnel token, or a quick
// tunnel (no domain, decision 31: straight on to "connect"). All end in "connect": entry +
// hosting on, wait for the tunnel, show the address and key.
import { t } from '../composables/useLocale'
import type { PublicWizard, WizardStep } from '~~/server/core/config'
import type { KeyView } from '~~/server/core/keys'

const p = t.publicAccess
const { doc, saving, save } = useSettings()
const cf = useCloudflareSetup()
const toast = useToast()

const pub = computed(() => doc.value!.public)
const w = reactive<PublicWizard>({ ...doc.value!.public.wizard! })
// Server-side progress changed (another tab, or this guide restarted from the overview).
watch(() => doc.value?.public.wizard, (v) => { if (v && v.step !== w.step) Object.assign(w, v) })

const branch = (path: PublicWizard['path']): WizardStep[] => (path === 'quick' ? [] : path === 'manual' ? ['guide', 'paste'] : ['cf-token', 'cf-zone', 'cf-run'])
const steps = computed<WizardStep[]>(() => [...(w.mode === 'setup' ? ['port', 'key'] as WizardStep[] : []), 'path', ...branch(w.path), 'connect'])
const index = computed(() => Math.max(0, steps.value.indexOf(w.step)))

const busy = ref('')
const fail = (e: unknown) => toast.add({ title: p.actionFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })

/** Save the progress (plus any other `public` fields) in one patch. */
function persist(extra: Record<string, unknown> = {}, opts: { quiet?: boolean } = { quiet: true }) {
  return save('public-wizard', { public: { ...extra, wizard: { ...w } } }, opts)
}
/** Move to a step once the server has it (a refused save keeps the current step). */
async function go(step: WizardStep, extra: Record<string, unknown> = {}) {
  if (await save('public-wizard', { public: { ...extra, wizard: { ...w, step } } }, { quiet: true })) w.step = step
}
const back = () => { const i = index.value; if (i > 0) void go(steps.value[i - 1]!) }
const forward = (extra: Record<string, unknown> = {}) => go(steps.value[index.value + 1]!, extra)

async function saveLater() {
  if (await persist({}, { quiet: true })) toast.add({ title: p.savedLater, color: 'success', icon: 'i-lucide-bookmark' })
}
const exit = () => save('public-wizard', { public: { wizard: null } }, { quiet: true })

// ---- port
const portEdit = ref(false)
const port = ref(String(pub.value.port))
const badPort = computed(() => !/^\d+$/.test(port.value.trim()) || Number(port.value) < 1024 || Number(port.value) > 65535)
const setPort = (v: string | number | undefined) => { port.value = v == null ? '' : String(v) }
const nextPort = () => forward(portEdit.value && Number(port.value) !== pub.value.port ? { port: Number(port.value) } : {})

// ---- key
const keys = ref<KeyView[] | null>(null)
const keyName = ref<string>(p.key.defaultName)
const keyAnother = ref(false)
const created = ref<{ name: string, key: string } | null>(null)
const activeKeys = computed(() => keys.value?.filter(k => !k.revoked) ?? [])
async function loadKeys() {
  try {
    keys.value = (await $fetch<{ keys: KeyView[] }>('/api/keys')).keys
  } catch (e) {
    fail(e)
  }
}
async function createKey() {
  if (busy.value || !keyName.value.trim()) return
  busy.value = 'key'
  try {
    const name = keyName.value.trim()
    const r = await $fetch<{ keys: KeyView[], created: { id: string, key: string } | null }>('/api/keys', { method: 'POST', body: { name } })
    keys.value = r.keys
    if (r.created) created.value = { name, key: r.created.key }
    keyAnother.value = false
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}
async function copyKey() {
  if (!created.value) return
  try {
    await navigator.clipboard.writeText(created.value.key)
    toast.add({ title: t.keys.copied, color: 'success', icon: 'i-lucide-check' })
  } catch { /* clipboard blocked: the key is shown and selectable */ }
}

// ---- path
// A quick tunnel has no address to add to: only the first setup offers it.
const pathOptions = computed(() => (w.mode === 'setup' ? ['api', 'manual', 'quick'] as const : ['api', 'manual'] as const))
const choosePath = (path: 'api' | 'manual' | 'quick') => { w.path = path }
const quick = computed(() => w.path === 'quick')

// ---- Cloudflare API token
const cfReplace = ref(false)
const cfToken = ref('')
const missingText = computed(() => (cf.inspection.value?.missing ?? []).map(x => t.cloudflare.permissions[x]).join('；'))
async function nextCfToken() {
  const ok = cfReplace.value || !cf.info.value.hasToken ? await cf.saveToken(cfToken.value) : await cf.loadZones()
  if (!ok) return
  cfToken.value = ''
  cfReplace.value = false
  if (!cf.inspection.value?.missing.length) await forward()
}

// ---- zone + subdomain
const zoneItems = computed(() => cf.usable.value.map(z => ({ label: z.name, value: z.id })))
const zoneName = computed(() => cf.usable.value.find(z => z.id === w.zoneId)?.name ?? '')
const hostname = computed(() => (zoneName.value && w.subdomain.trim() ? `${w.subdomain.trim().toLowerCase()}.${zoneName.value}` : ''))
function prefillZone() {
  const domain = pub.value.domain
  if (!w.zoneId || !cf.usable.value.some(z => z.id === w.zoneId)) {
    const z = cf.usable.value.find(z => domain.endsWith(`.${z.name}`)) ?? (cf.usable.value.length === 1 ? cf.usable.value[0] : undefined)
    w.zoneId = z?.id ?? ''
  }
  // Adding an address: the user picks a new name. First setup: the saved domain's name, or "llm".
  if (w.subdomain || w.mode !== 'setup') return
  const z = cf.usable.value.find(z => z.id === w.zoneId)
  w.subdomain = z && domain.endsWith(`.${z.name}`) ? domain.slice(0, -(z.name.length + 1)) : 'llm'
}
async function recheckZones() {
  if (await cf.loadZones()) prefillZone()
}
async function nextZone() {
  cf.f.value.zoneId = w.zoneId
  cf.f.value.subdomain = w.subdomain.trim()
  if (await cf.startPreview()) await forward()
}
const toManual = () => { w.path = 'manual'; void go('guide') }
// A connect step that could not switch things on (e.g. the port is taken) can be retried.
const switchedOn = computed(() => pub.value.enabled && pub.value.tunnelEnabled && pub.value.tunnelMode === (quick.value ? 'quick' : 'token'))

// ---- run
async function runDone() {
  await cf.jobAction('dismiss')
  await forward()
}

// ---- manual guide + tunnel token
const domainBad = computed(() => !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(w.domain.trim().toLowerCase()))
const nextGuide = () => forward({ domain: w.domain.trim().toLowerCase() })
const tunnelReplace = ref(false)
const tunnelToken = ref('')
async function nextPaste() {
  if (tunnelReplace.value || !pub.value.tunnel.hasToken) {
    if (busy.value) return
    busy.value = 'paste'
    try {
      await $fetch('/api/tunnel/token', { method: 'POST', body: { token: tunnelToken.value } })
      tunnelToken.value = ''
      tunnelReplace.value = false
    } catch (e) {
      fail(e)
      return
    } finally {
      busy.value = ''
    }
  }
  await forward()
}

// ---- connect: switch the entry and hosting on once
async function enterConnect() {
  // Another save (the one that brought us here) may still be finishing.
  for (let i = 0; i < 50 && saving.value; i++) await new Promise(r => setTimeout(r, 100))
  const tunnelMode = quick.value ? 'quick' : 'token'
  if (pub.value.enabled && pub.value.tunnelEnabled && pub.value.tunnelMode === tunnelMode) return
  await persist({ enabled: true, tunnelEnabled: true, tunnelMode })
}
const finish = () => save('public-wizard', { public: { wizard: null } }, { quiet: true })

// Load what each step starts from.
async function enter(step: WizardStep) {
  if (step === 'key' && !keys.value) await loadKeys()
  if ((step === 'cf-token' || step === 'path') && !cf.info.value.loaded) await cf.loadInfo()
  if (step === 'cf-zone') {
    if (!cf.inspection.value) await cf.loadZones()
    prefillZone()
  }
  if (step === 'cf-run' && !cf.job.value && !cf.plan.value && w.zoneId) {
    cf.f.value.zoneId = w.zoneId
    cf.f.value.subdomain = w.subdomain
    await cf.startPreview()
  }
  if (step === 'guide' && !w.domain) w.domain = pub.value.domain
  if (step === 'connect') await enterConnect()
}
watch(() => w.step, step => void enter(step), { immediate: true })

const working = computed(() => !!busy.value || !!cf.busy.value || saving.value === 'public-wizard')
const ingress = computed(() => `127.0.0.1:${pub.value.port}`)
</script>

<template>
  <div class="space-y-4">
    <!-- progress -->
    <div class="space-y-2">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <p class="text-sm font-medium text-highlighted">
          {{ p.steps[w.step] }}
        </p>
        <p class="text-xs text-muted">
          {{ fmt(p.stepOf, { n: index + 1, total: steps.length }) }}
        </p>
      </div>
      <div class="flex gap-1">
        <span v-for="(st, i) in steps" :key="st" class="h-1 flex-1 rounded-full" :class="i <= index ? 'bg-primary' : 'bg-accented'" />
      </div>
    </div>

    <!-- 1 port -->
    <div v-if="w.step === 'port'" class="space-y-3">
      <p class="text-sm text-default">
        {{ fmt(p.port.body, { address: ingress }) }}
      </p>
      <div v-if="portEdit" class="flex items-center gap-2">
        <span class="text-sm text-muted">{{ p.port.label }}</span>
        <UInput :model-value="port" type="number" size="sm" class="w-28" :color="badPort ? 'error' : undefined" :aria-label="p.port.label" @update:model-value="setPort" />
      </div>
      <div class="flex flex-wrap gap-2">
        <UButton size="sm" icon="i-lucide-arrow-right" :disabled="working || (portEdit && badPort)" :loading="saving === 'public-wizard'" @click="nextPort">
          {{ portEdit ? p.next : p.yes }}
        </UButton>
        <UButton v-if="!portEdit" size="sm" color="neutral" variant="outline" :disabled="working" @click="portEdit = true">
          {{ p.change }}
        </UButton>
      </div>
    </div>

    <!-- 2 key -->
    <div v-else-if="w.step === 'key'" class="space-y-3">
      <USkeleton v-if="!keys" class="h-12 w-full" />
      <template v-else>
        <div v-if="created" class="space-y-2 rounded-[10px] border border-default p-3">
          <p class="text-sm text-success">
            {{ fmt(p.key.created, { name: created.name }) }}
          </p>
          <div class="flex min-w-0 items-center gap-1">
            <code class="min-w-0 break-all font-mono text-xs text-default">{{ created.key }}</code>
            <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy" :aria-label="t.keys.copy" @click="copyKey" />
          </div>
        </div>
        <template v-if="activeKeys.length && !created">
          <p class="text-sm text-default">
            {{ fmt(p.key.existing, { n: activeKeys.length }) }}
          </p>
          <ul class="space-y-1">
            <li v-for="k in activeKeys" :key="k.id" class="flex min-w-0 flex-wrap items-baseline gap-x-2 text-sm">
              <span class="text-default">{{ k.name }}</span>
              <span class="break-all font-mono text-xs text-muted">{{ k.masked }}</span>
            </li>
          </ul>
        </template>
        <template v-if="!activeKeys.length || keyAnother">
          <p v-if="!activeKeys.length" class="text-sm text-default">
            {{ p.key.none }}
          </p>
          <UInput v-model="keyName" size="sm" class="w-56" maxlength="40" :aria-label="p.key.name" />
        </template>
        <div class="flex flex-wrap gap-2">
          <UButton v-if="!activeKeys.length || keyAnother" size="sm" icon="i-lucide-key-round" :disabled="working || !keyName.trim()" :loading="busy === 'key'" @click="createKey">
            {{ p.key.generate }}
          </UButton>
          <template v-else>
            <UButton size="sm" icon="i-lucide-arrow-right" :disabled="working" @click="forward()">
              {{ created ? p.next : p.yes }}
            </UButton>
            <UButton v-if="!created" size="sm" color="neutral" variant="outline" :disabled="working" @click="keyAnother = true">
              {{ p.key.another }}
            </UButton>
          </template>
        </div>
      </template>
    </div>

    <!-- 3 path -->
    <div v-else-if="w.step === 'path'" class="space-y-3">
      <p class="text-sm text-default">
        {{ p.path.body }}
      </p>
      <div class="grid gap-2" :class="pathOptions.length > 2 ? 'sm:grid-cols-3' : 'sm:grid-cols-2'">
        <button
          v-for="opt in pathOptions" :key="opt" type="button"
          class="rounded-[10px] border p-3 text-left transition-colors"
          :class="w.path === opt ? 'border-primary bg-primary/5' : 'border-default hover:bg-elevated'"
          :aria-pressed="w.path === opt" @click="choosePath(opt)"
        >
          <span class="flex items-center gap-2 text-sm font-medium text-default">
            <UIcon :name="w.path === opt ? 'i-lucide-circle-check' : 'i-lucide-circle'" class="size-4 shrink-0" :class="w.path === opt ? 'text-primary' : 'text-muted'" />
            {{ p.path[opt] }}
          </span>
          <span class="mt-1 block text-xs text-muted">{{ p.path[`${opt}Hint`] }}</span>
        </button>
      </div>
      <p class="text-xs text-muted">
        {{ fmt(p.path.cloudflared, { state: p.path.cloudflaredState[pub.cloudflared] }) }}
      </p>
      <UButton size="sm" icon="i-lucide-arrow-right" :disabled="working || !w.path" @click="forward()">
        {{ p.next }}
      </UButton>
    </div>

    <!-- 4a Cloudflare API token -->
    <div v-else-if="w.step === 'cf-token'" class="space-y-3">
      <p class="text-xs text-muted">
        {{ t.cloudflare.tokenHint }}
      </p>
      <p v-if="cf.info.value.hasToken && !cfReplace" class="break-all text-sm text-success">
        {{ fmt(t.cloudflare.tokenSaved, { masked: cf.info.value.maskedToken ?? '' }) }}
      </p>
      <UInput v-else v-model="cfToken" type="password" size="sm" class="w-full" autocomplete="off" :placeholder="t.cloudflare.tokenPlaceholder" :aria-label="t.cloudflare.token" />
      <p v-if="missingText" class="text-sm text-error">
        {{ fmt(t.cloudflare.missing, { perms: missingText }) }}
      </p>
      <details class="text-xs" :open="!cf.info.value.hasToken">
        <summary class="cursor-pointer text-muted">
          {{ t.cloudflare.howToken.title }}
        </summary>
        <ol class="mt-2 list-decimal space-y-1 pl-5 text-default">
          <li v-for="(step, i) in t.cloudflare.howToken.steps" :key="i">
            {{ step }}
          </li>
        </ol>
      </details>
      <div class="flex flex-wrap gap-2">
        <UButton
          size="sm" icon="i-lucide-shield-check" :disabled="working || ((cfReplace || !cf.info.value.hasToken) && !cfToken.trim())"
          :loading="cf.busy.value === 'token' || cf.busy.value === 'zones'" @click="nextCfToken"
        >
          {{ cf.info.value.hasToken && !cfReplace ? p.yes : p.cfToken.verify }}
        </UButton>
        <UButton v-if="cf.info.value.hasToken && !cfReplace" size="sm" color="neutral" variant="outline" :disabled="working" @click="cfReplace = true">
          {{ p.replace }}
        </UButton>
      </div>
    </div>

    <!-- 5a zone + subdomain -->
    <div v-else-if="w.step === 'cf-zone'" class="space-y-3">
      <USkeleton v-if="!cf.inspection.value" class="h-16 w-full" />
      <template v-else-if="!cf.usable.value.length">
        <p class="text-sm text-default">
          {{ p.zone.noZones }}
        </p>
        <div class="space-y-1 text-xs text-default">
          <p>{{ t.cloudflare.howDomain.intro }}</p>
          <ol class="list-decimal space-y-1 pl-5">
            <li v-for="(step, i) in t.cloudflare.howDomain.steps" :key="i">
              {{ step }}
            </li>
          </ol>
        </div>
        <div class="flex flex-wrap gap-2">
          <UButton size="sm" icon="i-lucide-refresh-cw" :loading="cf.busy.value === 'zones'" :disabled="working" @click="recheckZones">
            {{ p.zone.recheck }}
          </UButton>
          <UButton size="sm" color="neutral" variant="outline" :disabled="working" @click="toManual">
            {{ p.zone.toManual }}
          </UButton>
        </div>
      </template>
      <template v-else>
        <div class="grid gap-3 sm:grid-cols-2">
          <div class="space-y-1">
            <p class="text-sm text-default">
              {{ t.cloudflare.zone }}
            </p>
            <USelect v-model="w.zoneId" :items="zoneItems" size="sm" class="w-full" :placeholder="t.cloudflare.zonePlaceholder" :aria-label="t.cloudflare.zone" />
          </div>
          <div class="space-y-1">
            <p class="text-sm text-default">
              {{ t.cloudflare.subdomain }}
            </p>
            <UInput v-model="w.subdomain" size="sm" class="w-full" placeholder="llm" :aria-label="t.cloudflare.subdomain" />
          </div>
        </div>
        <p class="text-xs text-muted">
          {{ t.cloudflare.zoneHint }}
        </p>
        <p v-if="hostname" class="break-all text-sm">
          <span class="text-muted">{{ p.zone.address }}</span><code class="font-mono text-default">https://{{ hostname }}/v1</code>
        </p>
        <details class="text-xs">
          <summary class="cursor-pointer text-muted">
            {{ t.cloudflare.advanced }}
          </summary>
          <div class="mt-2 max-w-xs space-y-1">
            <p class="text-sm text-default">
              {{ t.cloudflare.tunnelName }}
            </p>
            <UInput v-model="cf.f.value.tunnelName" size="sm" class="w-full" :aria-label="t.cloudflare.tunnelName" />
            <p class="text-xs text-muted">
              {{ t.cloudflare.tunnelNameHint }}
            </p>
          </div>
        </details>
        <details v-if="cf.unusable.value.length" class="text-xs">
          <summary class="cursor-pointer text-muted">
            {{ t.cloudflare.unusable }}（{{ cf.unusable.value.length }}）
          </summary>
          <ul class="mt-1 space-y-0.5 pl-1">
            <li v-for="z in cf.unusable.value" :key="z.id">
              <span class="font-mono text-default">{{ z.name }}</span><span class="ml-2 text-muted">{{ fmt(t.cloudflare.zoneReason[z.reason!], { status: z.status }) }}</span>
            </li>
          </ul>
        </details>
        <UButton size="sm" icon="i-lucide-eye" :disabled="working || !w.zoneId || !w.subdomain.trim() || !cf.f.value.tunnelName.trim()" :loading="cf.busy.value === 'preview'" @click="nextZone">
          {{ t.cloudflare.preview }}
        </UButton>
      </template>
    </div>

    <!-- 6a preview + run -->
    <PublicCfRun v-else-if="w.step === 'cf-run'" @done="runDone" />

    <!-- 4b dashboard guide -->
    <div v-else-if="w.step === 'guide'" class="space-y-3">
      <p v-if="w.mode === 'add'" class="text-sm text-default">
        {{ fmt(p.guide.addOnly, { url: `http://${ingress}` }) }}
      </p>
      <TunnelGuide :ingress="ingress" :open="w.mode === 'setup'" :bare="true" />
      <div class="space-y-1">
        <p class="text-sm text-default">
          {{ p.guide.address }}
        </p>
        <UInput v-model="w.domain" size="sm" class="w-full max-w-sm" :placeholder="t.settings.public.domainPlaceholder" :aria-label="p.guide.address" />
        <p class="text-xs text-muted">
          {{ p.guide.addressHint }}
        </p>
      </div>
      <UButton size="sm" icon="i-lucide-arrow-right" :disabled="working || domainBad" @click="nextGuide">
        {{ p.next }}
      </UButton>
    </div>

    <!-- 5b tunnel token -->
    <div v-else-if="w.step === 'paste'" class="space-y-3">
      <p class="text-sm text-default">
        {{ p.paste.body }}
      </p>
      <p v-if="pub.tunnel.hasToken && !tunnelReplace" class="break-all text-sm text-success">
        {{ fmt(p.paste.saved, { masked: pub.tunnel.maskedToken ?? '' }) }}
      </p>
      <UInput v-else v-model="tunnelToken" type="password" size="sm" class="w-full" autocomplete="off" :placeholder="t.tunnel.tokenPlaceholder" :aria-label="t.tunnel.token" />
      <div class="flex flex-wrap gap-2">
        <UButton
          size="sm" icon="i-lucide-arrow-right" :disabled="working || ((tunnelReplace || !pub.tunnel.hasToken) && !tunnelToken.trim())"
          :loading="busy === 'paste'" @click="nextPaste"
        >
          {{ pub.tunnel.hasToken && !tunnelReplace ? p.yes : p.next }}
        </UButton>
        <UButton v-if="pub.tunnel.hasToken && !tunnelReplace" size="sm" color="neutral" variant="outline" :disabled="working" @click="tunnelReplace = true">
          {{ p.replace }}
        </UButton>
      </div>
    </div>

    <!-- 7 connect -->
    <div v-else-if="w.step === 'connect'" class="space-y-4">
      <div v-if="quick" class="space-y-1 rounded-[10px] border border-warning/40 bg-warning/10 p-3 text-xs text-default">
        <p class="font-medium text-warning">
          {{ p.quickLimits.title }}
        </p>
        <ul class="list-disc space-y-0.5 pl-4">
          <li v-for="(item, i) in p.quickLimits.items" :key="i">
            {{ item }}
          </li>
        </ul>
      </div>
      <PublicStatus />
      <UButton v-if="!switchedOn" size="sm" icon="i-lucide-power" :disabled="working" @click="enterConnect">
        {{ p.connect.switchOn }}
      </UButton>
      <div class="space-y-1">
        <p class="text-sm font-medium text-default">
          {{ p.overview.addresses }}
        </p>
        <PublicAddresses auto-check />
      </div>
      <div class="space-y-1">
        <p class="text-sm font-medium text-default">
          {{ p.overview.keys }}
        </p>
        <p class="text-xs text-muted">
          {{ p.connect.useIt }}
        </p>
        <PublicKeys />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <UButton size="sm" icon="i-lucide-check" :disabled="working" @click="finish">
          {{ p.connect.finish }}
        </UButton>
        <span class="text-xs text-muted">{{ p.connect.notYet }}</span>
      </div>
    </div>

    <!-- navigation -->
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-default pt-3">
      <UButton v-if="index > 0" size="xs" color="neutral" variant="ghost" icon="i-lucide-arrow-left" :disabled="working" @click="back">
        {{ p.prev }}
      </UButton>
      <span class="flex-1" />
      <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-bookmark" :disabled="working" @click="saveLater">
        {{ p.saveLater }}
      </UButton>
      <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-x" :disabled="working" @click="exit">
        {{ p.exit }}
      </UButton>
    </div>
  </div>
</template>
