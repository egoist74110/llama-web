<script setup lang="ts">
defineProps<{ title: string, subtitle?: string }>()
</script>

<template>
  <header class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="m-0 text-2xl font-semibold tracking-[-0.01em]">
        {{ title }}
      </h1>
      <p v-if="subtitle" class="mt-1 text-[13px] text-muted">
        {{ subtitle }}
      </p>
    </div>
    <slot name="actions" />
  </header>
</template>
