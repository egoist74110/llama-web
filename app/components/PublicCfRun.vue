<script setup lang="ts">
// Guide step "preview and run" (one-click branch): the 4-5 preview with explicit choices for
// existing tunnels / DNS records, the confirmation, then every step's result (retry from the
// failed step, or undo what the run created). Emits `done` when the run finished.
import t from '~~/i18n/zh-CN'
import type { SetupPlan } from '~~/server/core/cloudflare'

const emit = defineEmits<{ done: [] }>()
const s = t.cloudflare
const { job, plan, busy, f, startPreview, choose, apply, jobAction } = useCloudflareSetup()
const { load: loadSettings } = useSettings()
const confirmOpen = ref(false)

async function confirm() {
  confirmOpen.value = false
  await apply()
  await loadSettings()
}
async function act(name: 'retry' | 'cleanup') {
  await jobAction(name)
  await loadSettings()
  if (!job.value) void startPreview()
}

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
  <div class="space-y-3">
    <!-- A run in progress / finished / failed -->
    <template v-if="job">
      <ul class="space-y-1 text-sm">
        <li v-for="st in job.steps" :key="st.id" class="flex min-w-0 items-center gap-2">
          <UIcon :name="stepIcon(st.state)" class="size-4 shrink-0" :class="[stepColor(st.state), st.state === 'running' ? 'animate-spin' : '']" />
          <span class="shrink-0 text-default">{{ s.steps[st.id] }}</span>
          <span class="shrink-0 text-xs" :class="stepColor(st.state)">{{ s.stepState[st.state] }}</span>
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
        <UButton v-if="job.state === 'failed'" size="sm" icon="i-lucide-refresh-cw" :loading="busy === 'retry'" :disabled="!!busy" @click="act('retry')">
          {{ s.retry }}
        </UButton>
        <UButton v-if="job.state === 'failed'" size="sm" color="error" variant="outline" icon="i-lucide-undo-2" :loading="busy === 'cleanup'" :disabled="!!busy" @click="act('cleanup')">
          {{ s.cleanup }}
        </UButton>
        <UButton v-if="job.state === 'done'" size="sm" icon="i-lucide-arrow-right" :disabled="!!busy" @click="emit('done')">
          {{ t.publicAccess.run.toConnect }}
        </UButton>
      </div>
    </template>

    <USkeleton v-else-if="!plan" class="h-24 w-full" />

    <!-- Preview -->
    <div v-else class="space-y-3 rounded-[var(--ui-radius)] border border-default p-3">
      <p class="break-all text-sm font-medium text-default">
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
            <span class="flex min-w-0 flex-col">
              <span>{{ choiceLabel(c).title }}</span>
              <span v-if="choiceLabel(c).note" class="text-xs text-muted">{{ choiceLabel(c).note }}</span>
            </span>
          </UButton>
        </div>
      </div>

      <template v-else>
        <ul class="list-disc space-y-1 break-words pl-5 text-sm text-default">
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
          <p class="break-words text-sm text-default">
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
      </div>
    </div>

    <UModal v-model:open="confirmOpen" :title="s.confirmTitle" :description="plan ? fmt(s.confirmBody, { zone: plan.zone.name }) : ''">
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton size="sm" color="neutral" variant="ghost" @click="confirmOpen = false">
            {{ s.cancel }}
          </UButton>
          <UButton size="sm" icon="i-lucide-play" @click="confirm">
            {{ s.confirm }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
