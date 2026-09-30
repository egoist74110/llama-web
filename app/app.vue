<script setup lang="ts">
import t from '~~/i18n/zh-CN'

useHead({ title: t.app.title })
</script>

<template>
  <div>
    <NuxtRouteAnnouncer />
    <h1>{{ t.app.title }}</h1>
    <p>{{ t.app.subtitle }}</p>
  </div>
</template>
