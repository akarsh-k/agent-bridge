/**
 * "Add repository" side-sheet. Pipes through `createRepo`.
 */

import { useState } from 'react'
import { repoCreateInputSchema } from '@agent-bridge/shared'
import { Sheet } from '../../ui/sheet'
import { useWorkspace } from '../../lib/workspace-context'
import { toast } from '../../ui/toast-store'
import { ApiError } from '../../lib/rpc'
import { useDirtyClose } from '../../lib/use-dirty-close'

function RepoCreateForm({ onClose }: { onClose: () => void }) {
  const { createRepo } = useWorkspace()
  const [remoteUrl, setRemoteUrl] = useState('')
  const [branch, setBranch] = useState('main')
  const [pat, setPat] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const dirty =
    remoteUrl.length > 0 || branch !== 'main' || pat.length > 0
  const guardedClose = useDirtyClose(dirty && !busy, onClose)

  const submit = async () => {
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
      const { repo, existed } = await createRepo(parsed.data)
      toast.success(
        existed
          ? `Already tracking ${shortRepoName(repo.remoteUrl)}`
          : `Cloning ${shortRepoName(repo.remoteUrl)}…`,
      )
      onClose()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to add repo',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open
      onClose={guardedClose}
      title="Add repository"
      subtitle="Clone a Git repo so your agents can read it. We index files and (optionally) generate a wiki + knowledge graph."
      primaryLabel="Clone repository"
      onPrimary={submit}
      primaryBusy={busy}
      primaryDisabled={!remoteUrl.trim()}
    >
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="rc-url">
          Remote URL
        </label>
        <input
          id="rc-url"
          className="ab-input ab-mono"
          value={remoteUrl}
          onChange={(e) => setRemoteUrl(e.target.value)}
          placeholder="https://github.com/you/your-repo.git"
          autoFocus
        />
      </div>
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="rc-branch">
          Branch
        </label>
        <input
          id="rc-branch"
          className="ab-input ab-mono"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
        />
      </div>
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="rc-pat">
          Git PAT (private repos only)
        </label>
        <input
          id="rc-pat"
          className="ab-input ab-mono"
          type="password"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          placeholder="ghp_…"
        />
        <span className="ab-field-help">
          Encrypted at rest with your master key.
        </span>
      </div>
      {err && (
        <div
          className="ab-field-help"
          style={{ color: 'var(--danger)' }}
          role="alert"
        >
          {err}
        </div>
      )}
    </Sheet>
  )
}

function shortRepoName(remoteUrl: string): string {
  const m = remoteUrl.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/)
  return m ? m[1]! : remoteUrl
}

export function RepoCreateSheet({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  const [openCount, setOpenCount] = useState(0)
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setOpenCount((c) => c + 1)
  }
  if (!open) {
    return (
      <Sheet open={false} onClose={onClose} title="Add repository">
        <></>
      </Sheet>
    )
  }
  return <RepoCreateForm key={openCount} onClose={onClose} />
}
