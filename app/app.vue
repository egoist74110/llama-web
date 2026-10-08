<script setup lang="ts">
import { getUiLocale, t } from './composables/useLocale'

// The title follows the interface language, so switching it renames the window without a reload.
useHead({ title: computed(() => t.app.title), htmlAttrs: { lang: computed(() => getUiLocale()) } })
</script>

<template>
  <UApp>
    <NuxtRouteAnnouncer />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
