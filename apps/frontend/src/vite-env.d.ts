/// <reference types="vite/client" />

/**
 * The raw shape of `import.meta.env` as exposed by Vite. Every entry here
 * MUST start with `VITE_` (see `vite.config.ts#envPrefix`) — anything else
 * in the repo-root `.env` stays server-side and is not inlined into the
 * client bundle.
 */
interface ImportMetaEnv {
  readonly VITE_API_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
