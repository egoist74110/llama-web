<script setup lang="ts">
import t from '~~/i18n/zh-CN'

const { state, connected, connect, disconnect } = useLive()
onMounted(connect)
onBeforeUnmount(disconnect)

const route = useRoute()
// Nothing configured yet: send the user to the setup wizard once per visit.
const offeredSetup = useState('setup-offered', () => false)
watch(() => state.value?.firstRun, (first) => {
  if (first && !offeredSetup.value) {
    offeredSetup.value = true
    if (route.path !== '/setup') void navigateTo('/setup')
  }
}, { immediate: true })
const nav = [
  { to: '/', label: t.nav.overview, icon: 'i-lucide-layout-dashboard' },
  { to: '/models', label: t.nav.models, icon: 'i-lucide-boxes' },
  { to: '/logs', label: t.nav.logs, icon: 'i-lucide-scroll-text' },
  { to: '/settings', label: t.nav.settings, icon: 'i-lucide-settings' },
]
const isActive = (to: string) => (to === '/' ? route.path === '/' : route.path.startsWith(to))

// Top bar summary: the model that is serving (or the first one that is not stopped).
const headline = computed(() => {
  const s = state.value
  if (!s) return null
  const all = s.models.flatMap(m => m.instances.map(i => ({ m, i })))
  return all.find(x => x.i.state === 'ready') ?? all[0] ?? null
})
const version = computed(() => state.value?.llamacpp.current || t.layout.llamacppNone)

const colorMode = useColorMode()
const modes = [
  { label: t.layout.themeSystem, value: 'system', icon: 'i-lucide-monitor' },
  { label: t.layout.themeLight, value: 'light', icon: 'i-lucide-sun' },
  { label: t.layout.themeDark, value: 'dark', icon: 'i-lucide-moon' },
]
const themeMenu = computed(() => [modes.map(m => ({
  label: m.label,
  icon: m.icon,
  type: 'checkbox' as const,
  checked: colorMode.preference === m.value,
  onUpdateChecked: () => { colorMode.preference = m.value },
}))])
</script>

<template>
  <div class="flex min-h-dvh flex-col bg-default text-default">
    <header class="sticky top-0 z-20 flex h-14 items-center gap-4 border-b border-default bg-default/90 px-4 backdrop-blur">
      <NuxtLink to="/" class="flex items-center gap-2 font-semibold text-highlighted">
        <UIcon name="i-lucide-cpu" class="size-5 text-primary" />
        {{ t.app.title }}
      </NuxtLink>
      <div class="ml-2 flex min-w-0 flex-1 items-center gap-2 text-sm">
        <template v-if="headline">
          <StateDot :state="headline.i.state" />
          <span class="truncate font-medium text-highlighted">{{ headline.m.name }}</span>
          <span class="hidden text-muted sm:inline">{{ stateLabel(headline.i.state) }}</span>
        </template>
        <span v-else class="truncate text-muted">{{ t.layout.noModel }}</span>
      </div>
      <span class="hidden text-xs text-muted md:inline">{{ t.layout.llamacpp }} {{ version }}</span>
      <UTooltip :text="connected ? t.layout.connected : t.layout.disconnected">
        <span class="inline-block size-2 rounded-full" :class="connected ? 'bg-success' : 'bg-error animate-pulse'" />
      </UTooltip>
      <UDropdownMenu :items="themeMenu">
        <UButton color="neutral" variant="ghost" size="sm" icon="i-lucide-sun-moon" :aria-label="t.layout.theme" />
      </UDropdownMenu>
    </header>

    <div v-if="!connected && state" class="border-b border-default bg-warning/10 px-4 py-2 text-xs text-warning">
      {{ t.layout.disconnected }}
    </div>

    <div class="flex flex-1 flex-col md:flex-row">
      <nav class="flex gap-1 border-b border-default p-2 md:w-52 md:flex-col md:border-b-0 md:border-r md:p-3">
        <NuxtLink
          v-for="n in nav"
          :key="n.to"
          :to="n.to"
          class="flex flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors md:flex-none md:justify-start"
          :class="isActive(n.to) ? 'bg-primary/10 font-medium text-primary' : 'text-muted hover:bg-elevated hover:text-highlighted'"
        >
          <UIcon :name="n.icon" class="size-4" />
          {{ n.label }}
        </NuxtLink>
      </nav>
      <main class="mx-auto w-full min-w-0 max-w-5xl flex-1 px-4 py-6 md:px-8">
        <slot />
      </main>
    </div>
  </div>
</template>
