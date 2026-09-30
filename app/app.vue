<script setup lang="ts">
import t from '~~/i18n/zh-CN'

useHead({ title: t.app.title })
</script>

<template>
  <div>
    <NuxtRouteAnnouncer />
    <NuxtPage />
  </div>
</template>

<style>
:root {
  color-scheme: light dark;
  --bg: #f6f7f9; --panel: #fff; --text: #1f2328; --muted: #5b6470; --line: #e3e6ea; --accent: #3b6fd8;
  --ok: #2f8a57; --warn: #b7791f; --bad: #c0392b;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #1b1d21; --panel: #23262b; --text: #d7dbe0; --muted: #8e96a1; --line: #33373e; --accent: #7aa2f0;
    --ok: #5fbf8a; --warn: #d9a74a; --bad: #e06c5f;
  }
}
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.6 system-ui, 'Segoe UI', 'Microsoft YaHei UI', sans-serif; }
</style>
