<script setup lang="ts">
defineProps<{ title: string, subtitle?: string }>()
</script>

<template>
  <div>
    <h1 class="text-xl font-semibold text-highlighted">
      {{ title }}
    </h1>
    <p v-if="subtitle" class="mt-1 text-sm text-muted">
      {{ subtitle }}
    </p>
  </div>
</template>
