import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
)

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  envDir: repoRoot,
  // Only vars starting with this prefix are exposed to the client bundle.
  // Anything else in repo-root .env (POSTGRES_*, DATABASE_URL, etc.) stays server-side.
  // DO NOT widen this — see src/lib/env.ts for the validated surface.
  envPrefix: 'VITE_',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
