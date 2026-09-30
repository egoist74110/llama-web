<script setup lang="ts">
import t from '~~/i18n/zh-CN'
</script>

<template>
  <div class="space-y-5">
    <PagePlaceholder v-bind="t.placeholder.settings" />
    <ImportCard />
  </div>
</template>
