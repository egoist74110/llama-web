<script setup lang="ts">
import { t } from '../composables/useLocale'
</script>

<template>
  <UBadge color="warning" variant="subtle" size="xs" class="font-normal">
    {{ t.common.experimental }}
  </UBadge>
</template>
