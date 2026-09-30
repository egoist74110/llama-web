<script setup lang="ts">
const props = defineProps<{ state: string }>()
const color = computed(() => ({
  ready: 'success', loading: 'warning', draining: 'warning', unloading: 'warning', failed: 'error', crashed: 'error',
}[props.state] ?? 'neutral') as 'success' | 'warning' | 'error' | 'neutral')
</script>

<template>
  <UBadge :color="color" variant="subtle" size="sm">
    {{ stateLabel(state) }}
  </UBadge>
</template>
