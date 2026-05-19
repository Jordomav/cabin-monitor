<script setup>
import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useAuthStore } from '@/stores/authStore'

const auth = useAuthStore()
const { loginError } = storeToRefs(auth)

const password = ref('')
const submitting = ref(false)

async function onSubmit() {
  if (submitting.value) return
  submitting.value = true
  await auth.login(password.value)
  password.value = ''
  submitting.value = false
}
</script>

<template>
  <div class="min-h-screen flex items-center justify-center p-6">
    <form
      class="w-full max-w-xs bg-base-card border border-base-line rounded-2xl p-6 space-y-4"
      @submit.prevent="onSubmit"
    >
      <div class="text-center">
        <div class="text-3xl">🏠</div>
        <h1 class="text-lg font-semibold mt-1">CABIN Base Monitor</h1>
        <p class="text-sm text-gray-400">Enter dashboard password</p>
      </div>

      <input
        v-model="password"
        type="password"
        autocomplete="current-password"
        placeholder="Password"
        class="w-full px-3 py-3 rounded-lg bg-base-bg border border-base-line
               text-base outline-none focus:border-emerald-500"
      />

      <p v-if="loginError" class="text-sm text-red-400 text-center">
        {{ loginError }}
      </p>

      <button
        type="submit"
        :disabled="submitting || !password"
        class="w-full py-3 rounded-lg bg-emerald-600 font-medium
               disabled:opacity-50 active:bg-emerald-700"
      >
        {{ submitting ? 'Signing in…' : 'Sign in' }}
      </button>
    </form>
  </div>
</template>
