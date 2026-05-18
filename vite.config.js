import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import basicSsl from '@vitejs/plugin-basic-ssl'

// No build para o GitHub Pages (CI=true), os assets são servidos sob o caminho /jtm/
const base = process.env.GITHUB_ACTIONS ? '/jtm/' : '/'

export default defineConfig({
  base,
  build: {
    // O polyfill de modulepreload injeta um <script> inline que a CSP bloqueia.
    // Navegadores modernos (Chrome 66+, Firefox 115+, Safari 17+) suportam
    // <link rel="modulepreload"> nativamente — o polyfill não é necessário.
    modulePreload: { polyfill: false },
  },
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
        maximumFileSizeToCacheInBytes: 30 * 1024 * 1024,
        globIgnores: ['**/*.wasm'],
      },
      manifest: {
        name: 'JTM - Comunicação',
        short_name: 'JTM',
        description: 'Comunicação aumentativa para pessoas com dificuldades de fala',
        theme_color: '#1D4ED8',
        background_color: '#F8FAFC',
        display: 'standalone',
        start_url: base,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
        ],
      },
    }),
  ],
})
