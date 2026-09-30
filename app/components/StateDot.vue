<script setup lang="ts">
// Status colour lives only here (dot) and in StateBadge.
const props = defineProps<{ state: string }>()
const cls = computed(() => ({
  ready: 'bg-success',
  loading: 'bg-warning animate-pulse',
  draining: 'bg-warning',
  unloading: 'bg-warning',
  failed: 'bg-error',
  crashed: 'bg-error',
}[props.state] ?? 'bg-dimmed'))
</script>

<template>
  <span class="inline-block size-2.5 shrink-0 rounded-full" :class="cls" />
</template>
