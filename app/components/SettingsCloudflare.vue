<script setup lang="ts">
// One-click tunnel setup through the Cloudflare API: API token (masked, saved on the server),
// zone + subdomain, a preview with explicit choices for existing tunnels / DNS records, then the
// run with every step's result (retry from the failed step, or undo what the run created).
import t from '~~/i18n/zh-CN'
import type { Inspection, SetupJob, SetupPlan, ZoneView } from '~~/server/core/cloudflare'

const s = t.cloudflare
const { doc, load: loadSettings } = useSettings()
const toast = useToast()

function messageOf(e: unknown): string {
  const err = e as { data?: { message?: string }, statusMessage?: string, message?: string }
  return err?.data?.message ?? err?.statusMessage ?? err?.message ?? String(e)
}
const fail = (e: unknown) => toast.add({ title: s.actionFailed, description: messageOf(e), color: 'error', icon: 'i-lucide-circle-alert' })

const info = ref<{ hasToken: boolean, maskedToken: string | null }>({ hasToken: false, maskedToken: null })
const job = ref<SetupJob | null>(null)
const inspection = ref<Inspection | null>(null)
const plan = ref<SetupPlan | null>(null)
const token = ref('')
const busy = ref('')
const confirmOpen = ref(false)
const f = reactive({ zoneId: '', subdomain: '', tunnelName: 'llama-web', tunnel: '', dns: '' })

const usable = computed(() => inspection.value?.zones.filter(z => z.usable) ?? [])
const unusable = computed(() => inspection.value?.zones.filter(z => !z.usable) ?? [])
const zoneItems = computed(() => usable.value.map(z => ({ label: z.name, value: z.id })))
const missingText = computed(() => (inspection.value?.missing ?? []).map(p => s.permissions[p]).join('；'))
const zoneReason = (z: ZoneView) => fmt(s.zoneReason[z.reason!], { status: z.status })

async function run<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  if (busy.value) return
  busy.value = name
  try {
    return await fn()
  } catch (e) {
    fail(e)
  } finally {
    busy.value = ''
  }
}

/** Pick the zone (and subdomain) of the domain already set in the public entry, when there is one. */
function prefill() {
  if (f.zoneId && usable.value.some(z => z.id === f.zoneId)) return
  const domain = doc.value?.public.domain ?? ''
  const z = usable.value.find(z => domain.endsWith(`.${z.name}`)) ?? (usable.value.length === 1 ? usable.value[0] : undefined)
  if (!z) return
  f.zoneId = z.id
  if (!f.subdomain && domain.endsWith(`.${z.name}`)) f.subdomain = domain.slice(0, -(z.name.length + 1))
}

async function loadZones() {
  await run('zones', async () => {
    const r = await $fetch<{ inspection: Inspection }>('/api/cloudflare/zones')
    inspection.value = r.inspection
    prefill()
  })
}

async function saveToken(value: string) {
  await run('token', async () => {
    const r = await $fetch<{ hasToken: boolean, maskedToken: string | null, inspection: Inspection | null }>('/api/cloudflare/token', { method: 'POST', body: { token: value } })
    info.value = { hasToken: r.hasToken, maskedToken: r.maskedToken }
    inspection.value = r.inspection
    plan.value = null
    token.value = ''
    toast.add({ title: value ? s.saved : s.cleared, color: 'success', icon: 'i-lucide-check' })
    prefill()
  })
}

const body = () => ({ ...f, tunnel: f.tunnel || undefined, dns: f.dns || undefined })

async function preview() {
  await run('preview', async () => {
    plan.value = await $fetch<SetupPlan>('/api/cloudflare/preview', { method: 'POST', body: body() })
  })
}

function startPreview() {
  f.tunnel = ''
  f.dns = ''
  void preview()
}

function choose(kind: 'tunnel' | 'dns', value: string) {
  f[kind] = value
  if (kind === 'tunnel') f.dns = ''
  void preview()
}

async function apply() {
  confirmOpen.value = false
  await run('apply', async () => {
    const r = await $fetch<{ job: SetupJob }>('/api/cloudflare/apply', { method: 'POST', body: { ...body(), fingerprint: plan.value?.fingerprint } })
    job.value = r.job
    plan.value = null
    await loadSettings()
  })
}

async function jobAction(name: 'retry' | 'cleanup' | 'dismiss') {
  await run(name, async () => {
    const r = await $fetch<{ job: SetupJob | null }>(`/api/cloudflare/${name}`, { method: 'POST' })
    job.value = r.job
    await loadSettings()
  })
  if (!job.value && info.value.hasToken) await loadZones()
}

onMounted(async () => {
  try {
    const r = await $fetch<{ hasToken: boolean, maskedToken: string | null, job: SetupJob | null }>('/api/cloudflare')
    info.value = { hasToken: r.hasToken, maskedToken: r.maskedToken }
    job.value = r.job
  } catch (e) {
    fail(e)
    return
  }
  if (info.value.hasToken && !job.value) await loadZones()
})

// Preview texts
const tunnelLabel = computed(() => {
  const p = plan.value
  if (!p?.tunnel) return ''
  if (p.tunnel.kind === 'create') return fmt(s.actions.createTunnel, { name: p.tunnel.name })
  return fmt(p.tunnel.current ? s.actions.reuseCurrent : s.actions.reuseTunnel, { name: p.tunnel.tunnel.name })
})
const ingressLabel = computed(() => {
  const c = plan.value?.ingress?.change
  if (!c) return ''
  return c.from ? fmt(s.actions.ingressChange, { ...c, from: c.from }) : fmt(s.actions.ingressAdd, { hostname: c.hostname, to: c.to })
})
const dnsLabel = computed(() => {
  const p = plan.value
  const d = p?.dns
  if (!p || !d || d.kind === 'blocked') return ''
  if (d.kind === 'create') return fmt(s.actions.dnsCreate, { hostname: p.hostname })
  if (d.kind === 'keep') return s.actions.dnsKeep
  return fmt(s.actions.dnsUpdate, { hostname: p.hostname, from: d.fromTunnel ? fmt(s.dnsFrom, { name: d.fromTunnel }) : d.record.content })
})
const blockedText = computed(() => {
  const p = plan.value
  if (p?.dns?.kind !== 'blocked') return ''
  return fmt(s.blocked, { hostname: p.hostname, records: p.dns.records.map(r => `${r.type} ${r.content}`).join('，') })
})
const dnsRecord = computed(() => (plan.value?.dns?.kind === 'update' ? plan.value.dns : null))
const dnsIsProxyFix = computed(() => {
  const p = plan.value
  return !!dnsRecord.value && p?.tunnel?.kind === 'reuse' && dnsRecord.value.record.tunnelId === p.tunnel.tunnel.id
})
const warningText = (w: SetupPlan['warnings'][number]) => fmt(s.warnings[w], { hosts: plan.value?.ingress?.others.join('，') ?? '' })
const choiceLabel = (c: SetupPlan['tunnelChoices'][number]) => {
  const p = plan.value!
  if (!('reuse' in c)) return { title: fmt(s.choice.create, { name: p.tunnelName }), note: '' }
  const why = c.why.map(w => (w === 'dns-target' ? fmt(s.choice['dns-target'], { hostname: p.hostname }) : s.choice[w]))
  const conn = c.reuse.connections ? fmt(s.choice.connections, { n: c.reuse.connections }) : s.choice.idle
  return { title: fmt(s.choice.reuse, { name: c.reuse.name }), note: [...why, conn].join(' · ') }
}

// Job texts
const failedStep = computed(() => job.value?.steps.find(x => x.state === 'failed') ?? null)
const failedText = computed(() => {
  const st = failedStep.value
  if (!st?.error) return ''
  return fmt(s.failed, { step: s.steps[st.id], reason: cfErrorText(st.error.code, st.error.detail) })
})
const cleanupText = computed(() => {
  const c = job.value?.created
  if (!c) return ''
  const what = [c.tunnel ? fmt(s.cleanupWhat.tunnel, { name: c.tunnel.name }) : '', c.dnsRecordId ? s.cleanupWhat.dns : ''].filter(Boolean)
  return what.length ? fmt(s.cleanupHint, { what: what.join('、') }) : s.cleanupNothing
})
const stepColor = (state: string) => (state === 'done' ? 'text-success' : state === 'failed' ? 'text-error' : 'text-muted')
const stepIcon = (state: string) => ({ done: 'i-lucide-check', skipped: 'i-lucide-minus', failed: 'i-lucide-x', running: 'i-lucide-loader', pending: 'i-lucide-circle' } as Record<string, string>)[state]
</script>

<template>
  <AppCard :title="s.title" :hint="s.hint">
    <div class="space-y-2">
      <div>
        <p class="text-sm text-default">
          {{ s.token }}
        </p>
        <p class="text-xs text-muted">
          {{ s.tokenHint }}
        </p>
      </div>
      <p class="text-xs" :class="info.hasToken ? 'text-success' : 'text-muted'">
        {{ info.hasToken ? fmt(s.tokenSaved, { masked: info.maskedToken ?? '' }) : s.tokenNone }}
      </p>
      <div class="flex flex-wrap items-center gap-2">
        <UInput v-model="token" type="password" size="sm" class="min-w-0 flex-1 basis-64" autocomplete="off" :placeholder="s.tokenPlaceholder" :aria-label="s.token" />
        <UButton size="sm" icon="i-lucide-shield-check" :disabled="!token.trim()" :loading="busy === 'token'" @click="saveToken(token)">
          {{ s.saveToken }}
        </UButton>
        <UButton v-if="info.hasToken" size="sm" color="neutral" variant="ghost" icon="i-lucide-trash-2" :disabled="!!busy" @click="saveToken('')">
          {{ s.clearToken }}
        </UButton>
      </div>
      <details class="text-xs">
        <summary class="cursor-pointer text-muted">
          {{ s.howToken.title }}
        </summary>
        <ol class="mt-2 list-decimal space-y-1 pl-5 text-default">
          <li v-for="(step, i) in s.howToken.steps" :key="i">
            {{ step }}
          </li>
        </ol>
      </details>
      <details class="text-xs">
        <summary class="cursor-pointer text-muted">
          {{ s.howDomain.title }}
        </summary>
        <p class="mt-2 text-default">
          {{ s.howDomain.intro }}
        </p>
        <ol class="mt-1 list-decimal space-y-1 pl-5 text-default">
          <li v-for="(step, i) in s.howDomain.steps" :key="i">
            {{ step }}
          </li>
        </ol>
      </details>
    </div>

    <!-- A run in progress / finished / failed -->
    <div v-if="job" class="mt-4 space-y-3 border-t border-default pt-4">
      <ul class="space-y-1 text-sm">
        <li v-for="st in job.steps" :key="st.id" class="flex items-center gap-2">
          <UIcon :name="stepIcon(st.state)" class="size-4 shrink-0" :class="[stepColor(st.state), st.state === 'running' ? 'animate-spin' : '']" />
          <span class="text-default">{{ s.steps[st.id] }}</span>
          <span class="text-xs" :class="stepColor(st.state)">{{ s.stepState[st.state] }}</span>
          <span v-if="st.note" class="min-w-0 truncate font-mono text-xs text-muted">{{ st.note }}</span>
        </li>
      </ul>
      <p v-if="job.state === 'done'" class="text-sm text-success">
        {{ fmt(s.done, { hostname: job.hostname }) }}
      </p>
      <template v-if="job.state === 'failed'">
        <p class="text-sm text-error">
          {{ failedText }}
        </p>
        <p class="text-xs text-muted">
          {{ cleanupText }}
        </p>
      </template>
      <div class="flex flex-wrap gap-2">
        <UButton v-if="job.state === 'failed'" size="sm" icon="i-lucide-refresh-cw" :loading="busy === 'retry'" :disabled="!!busy" @click="jobAction('retry')">
          {{ s.retry }}
        </UButton>
        <UButton v-if="job.state === 'failed'" size="sm" color="error" variant="outline" icon="i-lucide-undo-2" :loading="busy === 'cleanup'" :disabled="!!busy" @click="jobAction('cleanup')">
          {{ s.cleanup }}
        </UButton>
        <UButton v-if="job.state === 'done'" size="sm" color="neutral" variant="outline" :disabled="!!busy" @click="jobAction('dismiss')">
          {{ s.dismiss }}
        </UButton>
      </div>
    </div>

    <!-- Choose zone + subdomain, then preview -->
    <div v-else-if="info.hasToken" class="mt-4 space-y-3 border-t border-default pt-4">
      <div class="flex flex-wrap items-center gap-2">
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" :loading="busy === 'zones'" :disabled="!!busy && busy !== 'zones'" @click="loadZones">
          {{ s.reload }}
        </UButton>
      </div>
      <p v-if="missingText" class="text-sm text-error">
        {{ fmt(s.missing, { perms: missingText }) }}
      </p>
      <template v-if="inspection">
        <p v-if="!usable.length" class="text-sm text-muted">
          {{ s.noZones }}
        </p>
        <template v-else>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="space-y-1">
              <p class="text-sm text-default">
                {{ s.zone }}
              </p>
              <USelect v-model="f.zoneId" :items="zoneItems" size="sm" class="w-full" :placeholder="s.zonePlaceholder" :aria-label="s.zone" @update:model-value="plan = null" />
              <p class="text-xs text-muted">
                {{ s.zoneHint }}
              </p>
            </div>
            <div class="space-y-1">
              <p class="text-sm text-default">
                {{ s.subdomain }}
              </p>
              <UInput v-model="f.subdomain" size="sm" class="w-full" placeholder="llm" :aria-label="s.subdomain" @update:model-value="plan = null" />
              <p class="text-xs text-muted">
                {{ s.subdomainHint }}
              </p>
            </div>
          </div>
          <details class="text-xs">
            <summary class="cursor-pointer text-muted">
              {{ s.advanced }}
            </summary>
            <div class="mt-2 max-w-xs space-y-1">
              <p class="text-sm text-default">
                {{ s.tunnelName }}
              </p>
              <UInput v-model="f.tunnelName" size="sm" class="w-full" :aria-label="s.tunnelName" @update:model-value="plan = null" />
              <p class="text-xs text-muted">
                {{ s.tunnelNameHint }}
              </p>
            </div>
          </details>
          <UButton size="sm" icon="i-lucide-eye" :disabled="!f.zoneId || !f.subdomain.trim() || !f.tunnelName.trim()" :loading="busy === 'preview' && !plan" @click="startPreview">
            {{ s.preview }}
          </UButton>
        </template>
        <details v-if="unusable.length" class="text-xs">
          <summary class="cursor-pointer text-muted">
            {{ s.unusable }}（{{ unusable.length }}）
          </summary>
          <ul class="mt-1 space-y-0.5 pl-1">
            <li v-for="z in unusable" :key="z.id">
              <span class="font-mono text-default">{{ z.name }}</span><span class="ml-2 text-muted">{{ zoneReason(z) }}</span>
            </li>
          </ul>
        </details>
      </template>

      <!-- Preview -->
      <div v-if="plan" class="space-y-3 rounded-[var(--ui-radius)] border border-default p-3">
        <p class="text-sm font-medium text-default">
          {{ s.previewTitle }} · <span class="font-mono">{{ plan.hostname }}</span>
        </p>

        <div v-if="plan.needs.includes('tunnel')" class="space-y-2">
          <p class="text-sm text-default">
            {{ s.chooseTunnel }}
          </p>
          <div class="flex flex-col gap-2">
            <UButton
              v-for="c in plan.tunnelChoices" :key="c.value" size="sm" color="neutral" variant="outline" class="justify-start text-left"
              :disabled="!!busy" @click="choose('tunnel', c.value)"
            >
              <span class="flex flex-col">
                <span>{{ choiceLabel(c).title }}</span>
                <span v-if="choiceLabel(c).note" class="text-xs text-muted">{{ choiceLabel(c).note }}</span>
              </span>
            </UButton>
          </div>
        </div>

        <template v-else>
          <ul class="list-disc space-y-1 pl-5 text-sm text-default">
            <li>{{ tunnelLabel }}</li>
            <li v-if="ingressLabel">
              {{ ingressLabel }}
            </li>
            <li v-if="dnsLabel">
              {{ dnsLabel }}
            </li>
            <template v-if="plan.dns?.kind !== 'blocked'">
              <li>{{ s.actions.token }}</li>
              <li>{{ fmt(s.actions.enable, { hostname: plan.hostname }) }}</li>
            </template>
          </ul>
          <p v-if="blockedText" class="text-sm text-error">
            {{ blockedText }}
          </p>
          <div v-if="plan.needs.includes('dns') && dnsRecord" class="space-y-2">
            <p class="text-sm text-default">
              {{ dnsIsProxyFix ? s.dnsFixProxy : fmt(s.chooseDns, { hostname: plan.hostname, content: dnsRecord.record.content, tunnel: dnsRecord.fromTunnel ? fmt(s.dnsTunnel, { name: dnsRecord.fromTunnel }) : '' }) }}
            </p>
            <UButton size="sm" color="neutral" variant="outline" :disabled="!!busy" @click="choose('dns', 'repoint')">
              {{ dnsIsProxyFix ? s.fixProxy : s.repoint }}
            </UButton>
          </div>
          <ul v-if="plan.warnings.length" class="space-y-1">
            <li v-for="w in plan.warnings" :key="w" class="flex gap-2 text-xs text-warning">
              <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-3.5 shrink-0" />
              <span>{{ warningText(w) }}</span>
            </li>
          </ul>
        </template>

        <div class="flex flex-wrap gap-2">
          <UButton size="sm" icon="i-lucide-play" :disabled="!plan.ready || !!busy" :loading="busy === 'apply'" @click="confirmOpen = true">
            {{ s.confirm }}
          </UButton>
          <UButton v-if="plan.autoChosen && plan.tunnelChoices.length > 1" size="sm" color="neutral" variant="outline" icon="i-lucide-shuffle" :disabled="!!busy" @click="choose('tunnel', 'ask')">
            {{ s.otherTunnel }}
          </UButton>
          <UButton v-if="(f.tunnel && f.tunnel !== 'ask') || f.dns" size="sm" color="neutral" variant="outline" icon="i-lucide-rotate-ccw" :disabled="!!busy" @click="startPreview">
            {{ s.rechoose }}
          </UButton>
          <UButton size="sm" color="neutral" variant="ghost" :disabled="!!busy" @click="plan = null">
            {{ s.cancel }}
          </UButton>
        </div>
      </div>
    </div>

    <UModal v-model:open="confirmOpen" :title="s.confirmTitle" :description="plan ? fmt(s.confirmBody, { zone: plan.zone.name }) : ''">
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton size="sm" color="neutral" variant="ghost" @click="confirmOpen = false">
            {{ s.cancel }}
          </UButton>
          <UButton size="sm" icon="i-lucide-play" @click="apply">
            {{ s.confirm }}
          </UButton>
        </div>
      </template>
    </UModal>
  </AppCard>
</template>
