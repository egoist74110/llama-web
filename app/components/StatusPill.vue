<script setup lang="ts">
// Status colour lives only on this pill, the dots and the bars. One pill for every instance state.
const props = defineProps<{ state: string }>()
const cls = computed(() => ({
  ready: 'lw-st-ready',
  loading: 'lw-st-loading',
  draining: 'lw-st-loading',
  unloading: 'lw-st-loading',
  failed: 'lw-st-failed',
  crashed: 'lw-st-failed',
}[props.state] ?? 'lw-st-stopped'))
</script>

<template>
  <span class="lw-st" :class="cls">{{ stateLabel(state) }}</span>
</template>
