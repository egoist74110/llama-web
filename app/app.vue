<script setup lang="ts">
import t from '~~/i18n/zh-CN'

useHead({ title: t.app.title })
</script>

<template>
  <UApp>
    <NuxtRouteAnnouncer />
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
  </UApp>
</template>
