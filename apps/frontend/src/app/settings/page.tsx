import { PageHeader } from '../_chrome/page-header'
import { Button } from '../../ui/button'
import { useTheme, type Theme } from '../../lib/theme'
import { Pill } from '../../ui/pill'
import { useEffect, useState } from 'react'
import { ApiError, getBridgeConfig } from '../../lib/rpc'

export function SettingsPage() {
  const { theme, setTheme } = useTheme()

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
            Pick a theme for this workspace. <code className="ab-mono">System</code>{' '}
            follows your OS preference.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
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
      </div>

      <div className="ab-card ab-card-pad ab-form-section">
        <div className="ab-section-head">
          <div className="ab-section-title">Master key</div>
          <div className="ab-section-sub">
            Used to encrypt API keys + secrets at rest in the local SQLite
            store.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Pill kind="success" dot>
            Configured
          </Pill>
          <span className="ab-field-help">
            Rotation flow lands in a follow-up. For now treat the env var as
            the source of truth.
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
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '160px 1fr',
          gap: '8px 16px',
          fontSize: 13,
          alignItems: 'center',
        }}
      >
        <span style={{ color: 'var(--text-muted)' }}>Frontend version</span>
        <span className="ab-mono">{buildVersion}</span>

        <span style={{ color: 'var(--text-muted)' }}>Build mode</span>
        <span className="ab-mono">{buildMode}</span>

        <span style={{ color: 'var(--text-muted)' }}>API endpoint</span>
        <span className="ab-mono" style={{ wordBreak: 'break-all' }}>
          {(import.meta.env.VITE_API_URL as string | undefined)?.trim() ||
            '(default — http://127.0.0.1:3001)'}
        </span>

        <span style={{ color: 'var(--text-muted)' }}>Bridge runtime</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {bridgeReady === null ? (
            <Pill kind="neutral">Checking…</Pill>
          ) : bridgeReady ? (
            <Pill kind="success" dot>
              Ready
            </Pill>
          ) : (
            <Pill kind="warn" dot>
              Not ready
            </Pill>
          )}
          {bridgeMsg && (
            <span className="ab-field-help" style={{ margin: 0 }}>
              {bridgeMsg}
            </span>
          )}
        </span>
      </div>
      <div
        style={{
          display: 'flex',
          gap: 10,
          marginTop: 14,
          flexWrap: 'wrap',
        }}
      >
        <a
          href="https://github.com/anthropics/agent-bridge/issues"
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
