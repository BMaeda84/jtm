import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  server: {
    https: true,
    host: true,
    port: 3000,
  },
  plugins: [
    basicSsl(),
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024, // 30MB — covers ONNX WASM
        globIgnores: ['**/*.wasm'],                       // still skip WASM from precache (too large for SW)
      },
      manifest: {
        name: 'JTM - Comunicação',
        short_name: 'JTM',
        description: 'Comunicação aumentativa para pessoas com dificuldades de fala',
        theme_color: '#1D4ED8',
        background_color: '#F8FAFC',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
})
