<script setup>
import MainLogic from './components/MainLogic.vue'
</script>

<template>
  <div class="app-shell">
    <main class="app-main">
      <MainLogic />
    </main>
  </div>
</template>

<style scoped>
.app-shell {
  min-height: 100vh;
  background: #0b1112;
}

.app-main {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
</style>
