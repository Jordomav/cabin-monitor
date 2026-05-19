import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '@/utils/api'

export const useAuthStore = defineStore('auth', () => {
  const authenticated = ref(false)
  const checking = ref(true)
  const loginError = ref('')

  // On boot, probe a session-protected endpoint to see if the cookie is still
  // valid (7-day session) so a returning user skips the login screen.
  async function checkSession() {
    checking.value = true
    try {
      await api.get('/api/status')
      authenticated.value = true
    } catch {
      authenticated.value = false
    } finally {
      checking.value = false
    }
  }

  async function login(password) {
    loginError.value = ''
    try {
      await api.post('/auth/login', { password })
      authenticated.value = true
      return true
    } catch (err) {
      authenticated.value = false
      loginError.value =
        err.status === 401 ? 'Incorrect password' : 'Login failed — server unreachable'
      return false
    }
  }

  async function logout() {
    try {
      await api.post('/auth/logout')
    } finally {
      authenticated.value = false
    }
  }

  return { authenticated, checking, loginError, checkSession, login, logout }
})
