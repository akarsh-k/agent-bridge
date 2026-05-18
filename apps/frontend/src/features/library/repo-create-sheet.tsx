/**
 * "Add repository" side-sheet. Pipes through `createRepo`.
 */

import { useState } from 'react'
import {
  repoBranchValidationFailureSchema,
  repoCreateInputSchema,
} from '@agent-bridge/shared'
import { Sheet } from '../../ui/sheet'
import { Dropdown } from '../../ui/dropdown'
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
  // Populated after a failed submit when the backend reports the chosen
  // branch is missing on the remote. Switches the branch field from a
  // free-text input to a searchable dropdown. `null` while we haven't
  // yet validated; reset to `null` when the remote URL changes (a
  // different repo has a different branch set) or when the user opts
  // back into free-text mode.
  //
  // `truncated`/`total` come from the backend's MAX_BRANCHES_IN_DETAILS
  // cap — surfaced as a hint so a user whose desired branch lives past
  // the cap knows to type it manually via the escape hatch.
  const [branchPicker, setBranchPicker] = useState<{
    readonly branches: readonly string[]
    readonly truncated: boolean
    readonly total: number
  } | null>(null)

  const dirty =
    remoteUrl.length > 0 || branch !== 'main' || pat.length > 0
  const guardedClose = useDirtyClose(dirty && !busy, onClose)

  const onRemoteUrlChange = (next: string) => {
    setRemoteUrl(next)
    // The branch list belongs to the previous URL; invalidate it.
    if (branchPicker !== null) setBranchPicker(null)
  }

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
      if (e instanceof ApiError && e.code === 'validation_failed') {
        const detailsParse = repoBranchValidationFailureSchema.safeParse(
          e.details,
        )
        if (detailsParse.success) {
          const details = detailsParse.data
          if (details.kind === 'branch_not_found') {
            setBranchPicker({
              branches: details.branches,
              truncated: details.truncated,
              total: details.total,
            })
            // Pre-select the remote default so a single re-submit gets
            // the user unstuck.
            if (details.suggestedBranch) setBranch(details.suggestedBranch)
            else if (details.branches[0]) setBranch(details.branches[0])
            setErr(e.message)
            return
          }
          // repo_unreachable falls through to the generic err display.
        }
      }
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
          onChange={(e) => onRemoteUrlChange(e.target.value)}
          placeholder="https://github.com/you/your-repo.git"
          autoFocus
        />
      </div>
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="rc-branch">
          Branch
        </label>
        {branchPicker ? (
          <>
            <Dropdown
              value={branch}
              onChange={setBranch}
              options={branchPicker.branches.map((b) => ({
                value: b,
                label: b,
                monoLabel: true,
              }))}
              searchable
              searchPlaceholder="Search branches…"
            />
            {branchPicker.truncated && (
              <span className="ab-field-help">
                Showing {branchPicker.branches.length} of {branchPicker.total}{' '}
                branches. If yours isn't here, use “Type a different branch”
                below.
              </span>
            )}
            <button
              type="button"
              className="ab-field-help"
              onClick={() => setBranchPicker(null)}
              style={{
                background: 'none',
                border: 0,
                padding: 0,
                cursor: 'pointer',
                textAlign: 'left',
                textDecoration: 'underline',
              }}
            >
              Type a different branch instead
            </button>
          </>
        ) : (
          <input
            id="rc-branch"
            className="ab-input ab-mono"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
        )}
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
