<script setup lang="ts">
import t from '~~/i18n/zh-CN'

const { state, connected, connect, disconnect } = useLive()
const trend = useSpeedTrend()
onMounted(() => {
  connect()
  trend.start()
})
onBeforeUnmount(() => {
  trend.stop()
  disconnect()
})

const route = useRoute()
// Nothing configured yet: send the user to the setup wizard once per visit.
const offeredSetup = useState('setup-offered', () => false)
watch(() => state.value?.firstRun, (first) => {
  if (first && !offeredSetup.value) {
    offeredSetup.value = true
    if (route.path !== '/setup') void navigateTo('/setup')
  }
}, { immediate: true })
</script>

<template>
  <div class="lw-shell text-default">
    <AppSidebar />
    <main class="lw-main">
      <div class="mx-auto flex max-w-[1120px] flex-col gap-[22px]">
        <div v-if="!connected && state" class="lw-card flex items-center gap-2.5 px-4 py-2.5 text-[13px] text-[var(--lw-warn)]" role="status">
          <span class="lw-live-dot is-off" />
          {{ t.layout.disconnected }}
        </div>
        <AppUpdatePrompt />
        <div class="min-w-0">
          <slot />
        </div>
      </div>
    </main>
    <LlamacppSwitchModal />
    <ModelStartFailureModal />
  </div>
</template>
