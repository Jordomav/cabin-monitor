<script setup>
import { useBaseStore } from '@/stores/baseStore'

const base = useBaseStore()

// alert.time is CC:Tweaked-relative (not wall-clock), so it is not displayed
// as a timestamp — order + severity colour only.
function levelClass(level) {
  switch ((level || '').toUpperCase()) {
    case 'CRIT':
    case 'CRITICAL':
      return 'border-red-500 text-red-300'
    case 'WARN':
    case 'WARNING':
      return 'border-amber-500 text-amber-300'
    default:
      return 'border-gray-600 text-gray-300'
  }
}
</script>

<template>
  <section class="bg-base-card border border-base-line rounded-2xl p-4">
    <h2 class="text-sm font-semibold text-gray-300">🔔 ALERTS</h2>

    <ul v-if="base.recentAlerts.length" class="mt-3 space-y-2">
      <li
        v-for="(a, i) in base.recentAlerts"
        :key="i"
        class="border-l-2 pl-3 text-sm"
        :class="levelClass(a.level)"
      >
        {{ a.message }}
      </li>
    </ul>

    <p v-else class="text-sm text-gray-500 mt-3">No alerts.</p>
  </section>
</template>
