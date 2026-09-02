<script setup>
import ArbitrageDashboard from './components/ArbitrageDashboard.vue'
</script>

<template>
  <div class="app-container">
    <header class="navbar">
      <div class="nav-brand">
        <span class="brand-mark">A</span>
        <span class="brand-name">ARBITRAGE / LAB</span>
      </div>
      <span class="nav-meta">PAPER MODE <span class="status-dot"></span></span>
    </header>

    <main class="main-content">
      <ArbitrageDashboard />
    </main>
  </div>
</template>

<style scoped>
.app-container {
  min-height: 100vh;
  background: var(--bg);
  color: var(--text-h);
  font-family: var(--sans);
}

.navbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 14px 32px;
  background: var(--code-bg);
  border-bottom: 1px solid var(--border);
  box-shadow: var(--shadow);
}

.nav-brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-h);
}

.brand-icon {
  font-size: 22px;
}

.main-content {
  padding-top: 10px;
}
</style>
