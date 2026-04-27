import { useCallback, useEffect, useRef, useState } from 'react'
import { repoCreateInputSchema } from '@agent-bridge/shared'
import { useWorkspace } from '../../../lib/workspace-context'
import { ApiError } from '../../../lib/rpc'
import { AddFormActions, ErrorText } from './form-atoms'

export function RepoNewForm({
  agentId,
  onCancel,
  onDone,
}: {
  readonly agentId: string
  readonly onCancel: () => void
  readonly onDone: () => void
}) {
  const { createRepo, attachRepo } = useWorkspace()
  const [remoteUrl, setRemoteUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [pat, setPat] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const urlRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    urlRef.current?.focus()
  }, [])

  const submit = useCallback(async () => {
    setErr(null)
    const parsed = repoCreateInputSchema.safeParse({
      remoteUrl: remoteUrl.trim(),
      branch: branch.trim() || undefined,
      gitPat: pat.trim()
        ? ({ action: 'set', plaintext: pat.trim() } as const)
        : undefined,
    })
    if (!parsed.success) {
      setErr(parsed.error.issues[0]?.message ?? 'Invalid repo')
      return
    }
    setBusy(true)
    try {
      const { repo } = await createRepo(parsed.data)
      await attachRepo(agentId, { repoId: repo.id })
      onDone()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to create repo',
      )
    } finally {
      setBusy(false)
    }
  }, [agentId, attachRepo, branch, createRepo, onDone, pat, remoteUrl])

  return (
    <form
      className="add-resource-form"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <label className="field">
        <span className="field-label">Remote URL</span>
        <input
          ref={urlRef}
          className="field-mono"
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
          placeholder="https://github.com/org/repo"
          maxLength={500}
          disabled={busy}
        />
      </label>
      <label className="field">
        <span className="field-label">Branch</span>
        <input
          className="field-mono"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          placeholder="main"
          maxLength={200}
          disabled={busy}
        />
      </label>
      <label className="field">
        <span className="field-label">Access token (optional)</span>
        <input
          type="password"
          className="field-mono"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          placeholder="ghp_..."
          disabled={busy}
          autoComplete="off"
        />
        <span className="field-hint">
          Stored encrypted at rest. Leave blank for public repos.
        </span>
      </label>
      <ErrorText message={err} />
      <AddFormActions
        submitLabel={busy ? 'Creating...' : 'Create and attach'}
        busy={busy}
        disabled={remoteUrl.trim().length === 0}
        onCancel={onCancel}
      />
    </form>
  )
}
