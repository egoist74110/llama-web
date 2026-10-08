<script setup lang="ts">
// The public access module (4-6): one card in three states — off (a sentence and a button),
// the guide (progress saved on the server), or the overview.
import { t } from '../composables/useLocale'
import type { PublicWizard } from '~~/server/core/config'

const p = t.publicAccess
const { doc, save, saving, load } = useSettings()
const { state } = useLive()
const cf = useCloudflareSetup()

const pub = computed(() => doc.value?.public)
onMounted(() => { if (!cf.info.value.loaded) void cf.loadInfo() })

// The listener status is part of the settings document; refresh it when the tunnel moves on.
watch(() => state.value?.tunnel.status.state, (now, before) => { if (before && now !== before) void load() })

async function start(mode: 'setup' | 'add') {
  if (!cf.info.value.loaded) await cf.loadInfo()
  const path: PublicWizard['path'] = mode === 'setup' && pub.value?.tunnelMode === 'quick' ? 'quick' : cf.info.value.hasToken ? 'api' : pub.value?.tunnel.hasToken ? 'manual' : 'api'
  const wizard: PublicWizard = { step: mode === 'setup' ? 'port' : 'path', mode, path, zoneId: '', subdomain: '', domain: '' }
  cf.plan.value = null
  await save('public-wizard', { public: { wizard } }, { quiet: true })
}
</script>

<template>
  <AppCard :title="p.title" :hint="p.hint">
    <p v-if="pub?.status.state === 'unavailable'" class="mb-4 flex gap-2 rounded-[10px] border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
      <UIcon name="i-lucide-triangle-alert" class="mt-0.5 size-4 shrink-0" />
      <span>{{ p.devMode }}</span>
    </p>
    <PublicWizard v-if="pub?.wizard" :key="`${pub.wizard.mode}`" />
    <PublicOverview v-else-if="pub?.enabled" @start="start" />
    <div v-else class="flex flex-wrap items-center justify-between gap-3">
      <p class="min-w-0 flex-1 basis-64 text-sm text-muted">
        {{ p.intro }}
      </p>
      <UButton size="sm" icon="i-lucide-globe" :loading="saving === 'public-wizard'" @click="start('setup')">
        {{ p.start }}
      </UButton>
    </div>
  </AppCard>
</template>
