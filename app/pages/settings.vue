<script setup lang="ts">
import t from '~~/i18n/zh-CN'

const route = useRoute()
const { load, loadError, doc } = useSettings()
onMounted(load)

// Section directory: anchors inside the page, the active one follows the scroll position.
const all = [
  { id: 's-dirs', label: t.settings.dirs.title, needsDoc: true },
  { id: 's-system', label: t.settings.system.title, needsDoc: true },
  { id: 's-llama', label: t.llamacpp.title, needsDoc: true },
  { id: 's-defaults', label: t.settings.defaults.title, needsDoc: true },
  { id: 's-image', label: t.settings.image.title, needsDoc: true },
  { id: 's-server', label: t.settings.server.title, needsDoc: true },
  { id: 's-public', label: t.publicAccess.title, needsDoc: true },
  { id: 's-about', label: t.appUpdate.title, needsDoc: false },
  { id: 's-import', label: t.import.title, needsDoc: false },
]
// About and import work without the settings document, so they are always listed.
const sections = computed(() => all.filter(s => !s.needsDoc || doc.value))
const active = ref(all[0]!.id)
let observer: IntersectionObserver | null = null
// After a click the smooth scroll passes other sections; keep the clicked one highlighted meanwhile.
let lockUntil = 0

function observe() {
  observer?.disconnect()
  const root = document.querySelector('.lw-main')
  const seen = new Set<string>()
  observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) seen.add(e.target.id)
      else seen.delete(e.target.id)
    }
    if (Date.now() < lockUntil) return
    const first = sections.value.find(s => seen.has(s.id))
    if (first) active.value = first.id
  }, { root: root instanceof HTMLElement && root.scrollHeight > root.clientHeight ? root : null, rootMargin: '0px 0px -60% 0px' })
  for (const s of sections.value) {
    const el = document.getElementById(s.id)
    if (el) observer.observe(el)
  }
}
// The cards only exist once the settings document has loaded.
watch(doc, async () => {
  await nextTick()
  observe()
  goToHash()
}, { immediate: true })
onBeforeUnmount(() => observer?.disconnect())

function go(id: string) {
  active.value = id
  lockUntil = Date.now() + 900
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// The route may arrive before the async settings cards exist, or change on this same page.
function goToHash() {
  const id = route.hash.slice(1)
  if (sections.value.some(s => s.id === id)) go(id)
}
watch(() => route.hash, async () => { await nextTick(); goToHash() })
</script>

<template>
  <div class="flex flex-col gap-[18px]">
    <PageHeader :title="t.settings.title" :subtitle="t.settings.subtitle" />

    <div class="flex flex-wrap items-start gap-6">
      <nav :aria-label="t.settings.toc" class="flex max-w-full flex-[1_0_180px] flex-col gap-px lg:sticky lg:top-0 lg:max-w-[220px]">
        <a
          v-for="s in sections"
          :key="s.id"
          :href="`#${s.id}`"
          class="lw-sub-link"
          :class="{ 'is-active': active === s.id }"
          :aria-current="active === s.id ? 'true' : undefined"
          @click.prevent="go(s.id)"
        >{{ s.label }}</a>
      </nav>
      <div class="flex min-w-0 flex-[999_1_520px] flex-col gap-4">
        <AppCard v-if="loadError" :title="t.settings.loadFailed">
          <p class="text-sm text-error">
            {{ loadError }}
          </p>
        </AppCard>
        <div v-else-if="!doc" class="flex flex-col gap-4">
          <USkeleton class="h-28 w-full rounded-[14px]" />
          <USkeleton class="h-40 w-full rounded-[14px]" />
        </div>
        <template v-else>
          <SettingsDirs id="s-dirs" />
          <SettingsSystem id="s-system" />
          <SettingsLlamacpp id="s-llama" />
          <SettingsDefaults id="s-defaults" />
          <SettingsImage id="s-image" />
          <SettingsServer id="s-server" />
          <SettingsPublicAccess id="s-public" />
        </template>
        <SettingsAbout id="s-about" />
        <ImportCard id="s-import" @imported="load" />
      </div>
    </div>
  </div>
</template>
