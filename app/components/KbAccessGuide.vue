<script setup lang="ts">
// How an outside agent reaches the knowledge bases (decisions 65 ⑦ / 69 ⑦): the MCP address, ready-made client
// commands, curl examples and a prompt to give the agent. Addresses are built from where this page is open and from
// the public address (when one is set up); keys are always placeholders.
import { t } from '../composables/useLocale'
import type { KbView } from '~~/server/core/kb/manager'
import { publicAddresses } from '~~/server/core/public-addresses'

const k = t.upstreams.kbAccess
const { doc } = useSettings()
const { state } = useLive()
const toast = useToast()

const origin = ref('')
const firstKb = ref('')
onMounted(async () => {
  origin.value = window.location.origin
  try {
    firstKb.value = (await $fetch<{ bases: KbView[] }>('/api/kb')).bases[0]?.id ?? ''
  } catch { /* the examples keep the <kb_id> placeholder */ }
})

const publicHost = computed(() => (doc.value ? publicAddresses(doc.value.public, state.value?.tunnel ?? { hostnames: null, quickHost: null })[0] ?? '' : ''))
const base = computed(() => origin.value || 'http://localhost')
const mcpLocal = computed(() => `${base.value}/v1/mcp`)
const mcpPublic = computed(() => `https://${publicHost.value || 'example.com'}/v1/mcp`)
const kb = computed(() => firstKb.value || '<kb_id>')
const json = '-H "Content-Type: application/json"'

const addresses = computed(() => [
  { label: k.local, text: mcpLocal.value },
  { label: publicHost.value ? k.public : k.publicExample, text: mcpPublic.value },
])
const clients = computed(() => [
  { label: k.claudeLocal, text: `claude mcp add --transport http llama-web ${mcpLocal.value}` },
  { label: k.claudePublic, text: `claude mcp add --transport http llama-web ${mcpPublic.value} --header "Authorization: Bearer ${k.keyPlaceholder}"` },
])
const rest = computed(() => [
  { label: k.restList, text: `curl ${base.value}/v1/kb` },
  { label: k.restGuide, text: `curl ${base.value}/v1/kb/${kb.value}/guide` },
  { label: k.restSearch, text: `curl -X POST ${base.value}/v1/kb/search ${json} -d '{"query":"...","kb_ids":["${kb.value}"],"top_k":5}'` },
  { label: k.restAdd, text: `curl -X POST ${base.value}/v1/kb/${kb.value}/entries ${json} -d '{"title":"...","body":"...","tags":["..."],"guide_rev":"<guide_rev>"}'` },
])

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.add({ title: k.copied, color: 'success', icon: 'i-lucide-check' })
  } catch { /* clipboard blocked: the text is selectable */ }
}
</script>

<template>
  <AppCard :title="k.title" :hint="k.hint">
    <div class="flex min-w-0 flex-col gap-5">
      <section class="flex min-w-0 flex-col gap-2">
        <h3 class="m-0 text-[13px] font-semibold">
          {{ k.mcpTitle }}
        </h3>
        <p class="m-0 text-xs text-muted">
          {{ k.mcpBody }}
        </p>
        <div v-for="x in addresses" :key="x.label" class="flex min-w-0 flex-col gap-1">
          <span class="text-xs text-dimmed">{{ x.label }}</span>
          <div class="flex min-w-0 items-start gap-1">
            <pre class="m-0 min-w-0 flex-1 whitespace-pre-wrap break-all rounded-lg bg-[var(--lw-sunken)] px-3 py-2 font-mono text-xs">{{ x.text }}</pre>
            <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy" :aria-label="k.copy" :title="k.copy" @click="copy(x.text)" />
          </div>
        </div>
      </section>

      <section class="flex min-w-0 flex-col gap-2">
        <h3 class="m-0 text-[13px] font-semibold">
          {{ k.clientsTitle }}
        </h3>
        <div v-for="x in clients" :key="x.label" class="flex min-w-0 flex-col gap-1">
          <span class="text-xs text-dimmed">{{ x.label }}</span>
          <div class="flex min-w-0 items-start gap-1">
            <pre class="m-0 min-w-0 flex-1 whitespace-pre-wrap break-all rounded-lg bg-[var(--lw-sunken)] px-3 py-2 font-mono text-xs">{{ x.text }}</pre>
            <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy" :aria-label="k.copy" :title="k.copy" @click="copy(x.text)" />
          </div>
        </div>
        <p class="m-0 text-xs text-muted">
          {{ k.otherClients }}
        </p>
      </section>

      <section class="flex min-w-0 flex-col gap-2">
        <h3 class="m-0 text-[13px] font-semibold">
          {{ k.restTitle }}
        </h3>
        <p class="m-0 text-xs text-muted">
          {{ k.restHint }}
        </p>
        <div v-for="x in rest" :key="x.label" class="flex min-w-0 flex-col gap-1">
          <span class="text-xs text-dimmed">{{ x.label }}</span>
          <div class="flex min-w-0 items-start gap-1">
            <pre class="m-0 min-w-0 flex-1 whitespace-pre-wrap break-all rounded-lg bg-[var(--lw-sunken)] px-3 py-2 font-mono text-xs">{{ x.text }}</pre>
            <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy" :aria-label="k.copy" :title="k.copy" @click="copy(x.text)" />
          </div>
        </div>
      </section>

      <section class="flex min-w-0 flex-col gap-2">
        <h3 class="m-0 text-[13px] font-semibold">
          {{ k.promptTitle }}
        </h3>
        <p class="m-0 text-xs text-muted">
          {{ k.promptHint }}
        </p>
        <div class="flex min-w-0 items-start gap-1">
          <pre class="m-0 min-w-0 flex-1 whitespace-pre-wrap break-words rounded-lg bg-[var(--lw-sunken)] px-3 py-2 text-xs leading-relaxed">{{ k.prompt }}</pre>
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy" :aria-label="k.copy" :title="k.copy" @click="copy(k.prompt)" />
        </div>
      </section>

      <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
        <NuxtLink to="/knowledge" class="text-primary">
          {{ k.toKb }}
        </NuxtLink>
        <NuxtLink to="/settings#s-public" class="text-primary">
          {{ k.toKeys }}
        </NuxtLink>
      </div>
    </div>
  </AppCard>
</template>
