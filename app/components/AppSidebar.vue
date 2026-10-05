<script setup lang="ts">
// Left sidebar (decision 30): brand, navigation, the "now serving" card, connection status,
// llama.cpp version and the light / dark switch. Replaces the old top bar.
import t from '~~/i18n/zh-CN'

const { state, metrics, connected } = useLive()
const route = useRoute()
const L = t.layout

// The guide stays in the menu until the first model is added.
const showGuide = computed(() => !!state.value && state.value.models.length === 0)
const nav = computed(() => [
  ...(showGuide.value ? [{ to: '/setup', label: t.nav.guide, icon: 'i-lucide-compass', count: null }] : []),
  { to: '/', label: t.nav.overview, icon: 'i-lucide-layout-dashboard', count: null },
  { to: '/models', label: t.nav.models, icon: 'i-lucide-box', count: state.value?.models.length || null },
  { to: '/logs', label: t.nav.logs, icon: 'i-lucide-text', count: null },
  { to: '/settings', label: t.nav.settings, icon: 'i-lucide-sliders-horizontal', count: null },
])
const isActive = (to: string) => (to === '/' ? route.path === '/' : route.path.startsWith(to))

// The instance worth showing: generating > ready > loading > failed.
const top = computed(() => rankInstances(state.value, metrics.value)[0] ?? null)
const pill = computed(() => {
  const s = top.value?.inst.state
  if (!s) return { cls: 'lw-st-stopped', label: L.serving.idle }
  if (s === 'ready') return { cls: 'lw-st-ready', label: stateLabel(s) }
  if (s === 'failed' || s === 'crashed') return { cls: 'lw-st-failed', label: stateLabel(s) }
  return { cls: 'lw-st-loading', label: stateLabel(s) }
})
const big = computed(() => {
  const x = top.value
  if (!x) return { value: '–', unit: L.serving.waiting }
  if (x.inst.state === 'loading') {
    return { value: x.inst.progress === null ? '–' : `${x.inst.progress}%`, unit: L.serving.loading }
  }
  if (x.inst.state !== 'ready' && x.inst.state !== 'draining') return { value: '–', unit: stateLabel(x.inst.state) }
  const sp = instanceSpeed(metrics.value, x.model.id, x.inst.profile)
  const n = sp.generation === null ? '–' : sp.generation.toFixed(1)
  if (sp.phase === 'generating') return { value: n, unit: L.serving.generating }
  if (sp.phase === 'prompt') return { value: '…', unit: L.serving.prompt }
  return sp.generation === null ? { value: '–', unit: L.serving.waiting } : { value: n, unit: L.serving.last }
})
const version = computed(() => state.value?.llamacpp.current || L.llamacppNone)
const runtimeUpdate = computed(() => {
  const c = state.value?.llamacpp.check
  return c?.state === 'checked' && c.available ? c.tag : null
})
const { view: appVersion, release: appRelease } = useAppUpdate()

const colorMode = useColorMode()
const modes = [
  { value: 'system', label: L.themeSystemShort },
  { value: 'light', label: L.themeLight },
  { value: 'dark', label: L.themeDark },
]
</script>

<template>
  <aside class="lw-side">
    <NuxtLink to="/" class="flex items-center gap-2.5 px-2 py-0.5">
      <span class="inline-flex size-[30px] items-center justify-center rounded-[9px] bg-[var(--lw-accent)] text-white">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 13h3.5l2.2-6 3.6 11 2.3-5H20" /></svg>
      </span>
      <span class="flex flex-col leading-tight">
        <span class="text-[15px] font-semibold">{{ t.app.title }}</span>
        <span class="text-xs text-dimmed">{{ t.app.subtitle }}</span>
      </span>
    </NuxtLink>

    <nav :aria-label="L.mainNav" class="grid grid-flow-col auto-cols-fr gap-1 min-[820px]:flex min-[820px]:flex-col min-[820px]:gap-0.5">
      <NuxtLink
        v-for="n in nav"
        :key="n.to"
        :to="n.to"
        class="lw-nav-item justify-center min-[820px]:justify-start"
        :class="{ 'is-active': isActive(n.to) }"
        :aria-current="isActive(n.to) ? 'page' : undefined"
      >
        <UIcon :name="n.icon" class="lw-nav-icon size-[17px] shrink-0" />
        <span class="min-[820px]:flex-1">{{ n.label }}</span>
        <span v-if="n.count" class="lw-num hidden text-xs text-dimmed min-[820px]:inline">{{ n.count }}</span>
      </NuxtLink>
    </nav>

    <div class="hidden flex-1 min-[820px]:block" />

    <div class="lw-card flex flex-col gap-2 px-3 pb-2.5 pt-3">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs text-dimmed">{{ L.serving.title }}</span>
        <span class="lw-st" :class="pill.cls">{{ pill.label }}</span>
      </div>
      <span class="truncate text-[13px] font-semibold">{{ top ? top.model.name : L.noModel }}</span>
      <div class="flex items-baseline gap-1.5">
        <span class="lw-num font-mono text-xl font-medium text-[var(--lw-accent-ink)]">{{ big.value }}</span>
        <span class="text-xs text-dimmed">{{ big.unit }}</span>
      </div>
    </div>

    <div class="flex flex-col gap-2.5 px-1.5">
      <div class="flex items-center justify-between gap-2 text-xs text-dimmed">
        <span class="inline-flex items-center gap-[7px]">
          <span class="lw-live-dot" :class="{ 'is-off': !connected }" />
          {{ connected ? L.connected : L.disconnectedShort }}
        </span>
      </div>
      <div class="flex flex-wrap items-center gap-2 text-xs text-dimmed">
        <span class="font-mono">{{ L.llamacpp }} {{ version }}</span>
        <NuxtLink v-if="runtimeUpdate" to="/settings#s-llama" class="text-primary">{{ fmt(t.llamacpp.update.available, { tag: runtimeUpdate }) }}</NuxtLink>
      </div>
      <div v-if="appVersion" class="flex flex-wrap items-center gap-2 text-xs text-dimmed">
        <span class="font-mono">{{ t.app.title }} v{{ appVersion.current }}</span>
        <NuxtLink v-if="appRelease && appVersion.skipped !== appRelease.version" to="/settings#s-about" class="text-primary">{{ fmt(t.appUpdate.inlineAvailable, { version: appRelease.version }) }}</NuxtLink>
      </div>
      <div class="lw-seg w-full" role="group" :aria-label="L.theme">
        <button
          v-for="m in modes"
          :key="m.value"
          type="button"
          class="flex-1"
          :class="{ on: colorMode.preference === m.value }"
          :aria-pressed="colorMode.preference === m.value"
          @click="colorMode.preference = m.value"
        >
          {{ m.label }}
        </button>
      </div>
    </div>
  </aside>
</template>
