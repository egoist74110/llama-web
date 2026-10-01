<script setup lang="ts">
import t from '~~/i18n/zh-CN'

const { load, loadError, doc } = useSettings()
onMounted(load)
</script>

<template>
  <div class="space-y-5">
    <PageHeader :title="t.settings.title" :subtitle="t.settings.subtitle" />

    <AppCard v-if="loadError" :title="t.settings.loadFailed">
      <p class="text-sm text-error">
        {{ loadError }}
      </p>
    </AppCard>
    <div v-else-if="!doc" class="space-y-4">
      <USkeleton class="h-28 w-full" />
      <USkeleton class="h-40 w-full" />
    </div>
    <template v-else>
      <SettingsDirs />
      <SettingsLlamacpp />
      <SettingsDefaults />
      <SettingsImage />
      <SettingsServer />
      <SettingsPublicAccess />
    </template>

    <ImportCard @imported="load" />
  </div>
</template>
