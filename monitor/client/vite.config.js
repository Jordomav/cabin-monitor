import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

// Dev: Vite serves the app and proxies API + WS to the Node server on :3000.
// Build: output goes straight into monitor/server/public so the Node server
// serves the production bundle (replaces the Milestone 1 placeholder).
const SERVER = 'http://localhost:3000'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    proxy: {
      '/api': { target: SERVER, changeOrigin: true },
      '/auth': { target: SERVER, changeOrigin: true },
      '/command': { target: SERVER, changeOrigin: true },
      '/push': { target: SERVER, changeOrigin: true },
      '/ws': { target: SERVER, ws: true, changeOrigin: true }
    }
  },
  build: {
    outDir: fileURLToPath(new URL('../server/public', import.meta.url)),
    emptyOutDir: true
  }
})
