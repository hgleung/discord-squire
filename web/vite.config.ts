import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // Shared domain logic lives in ../lib, outside this package; let the dev
    // server read it.
    fs: { allow: ['..'] },
    // The local server owns the plan file. Proxying keeps the app same-origin
    // in dev, so there is no CORS setup and no host to configure in the client.
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        // Server-sent events must not be buffered by the proxy.
        configure: (proxy) => proxy.on('proxyRes', (res) => res.headers['x-accel-buffering'] = 'no'),
      },
    },
  },
})
