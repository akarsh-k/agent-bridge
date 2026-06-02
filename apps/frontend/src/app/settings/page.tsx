import { PageHeader } from '../_chrome/page-header'
import { Button } from '../../ui/button'
import { useTheme, useAccent, ACCENTS, type Theme } from '../../lib/theme'
import { Pill } from '../../ui/pill'
import { useEffect, useState, type CSSProperties } from 'react'
import { ApiError, getBridgeConfig } from '../../lib/rpc'

export function SettingsPage() {
  const { theme, setTheme } = useTheme()
  const { accent, setAccent } = useAccent()

  const opts: ReadonlyArray<{ value: Theme; label: string }> = [
    { value: 'system', label: 'System' },
    { value: 'light', label: 'Light' },
    { value: 'dark', label: 'Dark' },
  ]

  return (
    <div className="ab-page">
      <PageHeader
        title="Settings"
        subtitle="Workspace-level preferences. The master encryption key, data root, and theme live here."
      />

      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Appearance</div>
          <div className="ab-section-sub">
            Pick a theme for this workspace.{' '}
            <code className="ab-mono">System</code> follows your OS preference.
          </div>
        </div>
        <div className="ab-theme-row">
          {opts.map((o) => (
            <Button
              key={o.value}
              variant={theme === o.value ? 'primary' : 'secondary'}
              onClick={() => setTheme(o.value)}
            >
              {o.label}
            </Button>
          ))}
        </div>

        <div className="ab-appearance-accent">
          <div className="ab-field-label">Accent color</div>
          <div className="ab-accent-grid">
            {ACCENTS.map((a) => (
              <button
                key={a.key}
                type="button"
                className={`ab-accent-swatch${accent.key === a.key ? ' is-active' : ''}`}
                aria-pressed={accent.key === a.key}
                aria-label={a.label}
                onClick={() => setAccent(a.key)}
                style={{ '--sw': `oklch(0.66 ${a.c} ${a.h})` } as CSSProperties}
              >
                <span className="ab-accent-dot" aria-hidden="true" />
                {a.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Master key</div>
          <div className="ab-section-sub">
            Used to encrypt API keys + secrets at rest in the local SQLite
            store.
          </div>
        </div>
        <div className="ab-settings-key-row">
          <Pill kind="success">Configured</Pill>
          <span className="ab-field-help">
            Rotation flow lands in a follow-up. For now treat the env var as the
            source of truth.
          </span>
        </div>
      </div>

      <AboutCard />
    </div>
  )
}

function AboutCard() {
  const [bridgeReady, setBridgeReady] = useState<boolean | null>(null)
  const [bridgeMsg, setBridgeMsg] = useState<string | null>(null)
  const buildVersion =
    (import.meta.env.VITE_APP_VERSION as string | undefined) ?? 'dev'
  const buildMode = import.meta.env.MODE

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const cfg = await getBridgeConfig()
        if (!alive) return
        setBridgeReady(cfg.ready)
        setBridgeMsg(cfg.readyHint)
      } catch (err) {
        if (!alive) return
        setBridgeReady(false)
        setBridgeMsg(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Backend unreachable',
        )
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="ab-card ab-card-pad ab-form-section">
      <div className="ab-section-head">
        <div className="ab-section-title">About</div>
        <div className="ab-section-sub">
          Build + runtime info — useful when filing issues.
        </div>
      </div>
      <div className="ab-about-grid">
        <span className="ab-about-label">Frontend version</span>
        <span className="ab-mono">{buildVersion}</span>

        <span className="ab-about-label">Build mode</span>
        <span className="ab-mono">{buildMode}</span>

        <span className="ab-about-label">API endpoint</span>
        <span className="ab-mono ab-about-endpoint">
          {(import.meta.env.VITE_API_URL as string | undefined)?.trim() ||
            '(default: http://127.0.0.1:3001)'}
        </span>

        <span className="ab-about-label">Bridge runtime</span>
        <span className="ab-about-bridge-status">
          {bridgeReady === null ? (
            <Pill kind="neutral">Checking…</Pill>
          ) : bridgeReady ? (
            <Pill kind="success" dot>
              Ready
            </Pill>
          ) : (
            <Pill kind="warn">Not ready</Pill>
          )}
          {bridgeMsg && (
            <span className="ab-field-help ab-about-bridge-msg">
              {bridgeMsg}
            </span>
          )}
        </span>
      </div>
      <div className="ab-about-actions">
        <a
          href="https://github.com/akarsh-k/agent-bridge/issues"
          target="_blank"
          rel="noreferrer"
          className="ab-btn ab-btn-secondary"
        >
          File an issue
        </a>
        <Button variant="ghost" onClick={() => window.location.reload()}>
          Reload app
        </Button>
      </div>
    </div>
  )
}
