<script setup lang="ts">
defineProps<{ title: string, subtitle: string, body: string }>()
</script>

<template>
  <div class="space-y-5">
    <PageHeader :title="title" :subtitle="subtitle" />
    <AppCard :title="title">
      <p class="text-sm text-muted">
        {{ body }}
      </p>
    </AppCard>
  </div>
</template>
