/**
 * Edit-attached-repo side-sheet. tweaks role + description + aliases
 * for a repo already attached to this agent. The repo entry itself is
 * managed in Library; this only touches the per-agent attachment.
 *
 * Aliases are operator-curated extra names the inspector toolkit
 * uses to fuzzy-match an IDE coding agent's `repo_hint` /
 * `local_folder` (`docs/ARCHITECTURE.md` §10.3-10.4). Examples:
 * local folder names (`web-app`), short codes (`fe`, `bff`), legacy
 * names. The DTO trims / dedupes / lower-cases on save; we mirror
 * that in the chip-input so the operator sees what will land in the
 * DB before clicking Save.
 */

import { useState, type KeyboardEvent } from 'react'
import type { AttachedRepoResponse } from '@agent-bridge/shared'
import { Sheet } from '../../ui/sheet'
import { useWorkspace } from '../../lib/workspace-context'
import { ApiError } from '../../lib/rpc'
import { toast } from '../../ui/toast-store'
import { useDirtyClose } from '../../lib/use-dirty-close'

function shortRepoName(remoteUrl: string): string {
  const m = remoteUrl.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/)
  return m ? m[1]! : remoteUrl
}

const MAX_ALIASES = 20
const MAX_ALIAS_LEN = 60

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false
  }
  return true
}

function EditForm({
  agentId,
  attachment,
  onClose,
}: {
  agentId: string
  attachment: AttachedRepoResponse
  onClose: () => void
}) {
  const { patchAttachedRepo } = useWorkspace()
  const [role, setRole] = useState(attachment.role ?? '')
  const [description, setDescription] = useState(attachment.description ?? '')
  const [aliases, setAliases] = useState<string[]>(attachment.aliases ?? [])
  const [aliasDraft, setAliasDraft] = useState('')
  const [aliasErr, setAliasErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const dirty =
    role !== (attachment.role ?? '') ||
    description !== (attachment.description ?? '') ||
    !arraysEqual(aliases, attachment.aliases ?? []) ||
    aliasDraft.trim().length > 0
  const guardedClose = useDirtyClose(dirty && !busy, onClose)

  /**
   * Commit the current draft (and any comma-separated values inside
   * it) to the alias list. Mirrors the DTO normalisation: trim,
   * lowercase, dedupe, enforce per-entry length and total count.
   * Returns false on any rejection so the caller can leave the draft
   * alone and surface the error.
   */
  const commitAliasDraft = (input: string): boolean => {
    const fragments = input
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    if (fragments.length === 0) {
      setAliasDraft('')
      setAliasErr(null)
      return true
    }
    const next = [...aliases]
    for (const raw of fragments) {
      const lowered = raw.toLowerCase()
      if (lowered.length > MAX_ALIAS_LEN) {
        setAliasErr(`"${raw}" exceeds ${MAX_ALIAS_LEN} characters`)
        return false
      }
      if (next.includes(lowered)) continue // silent dedupe
      if (next.length >= MAX_ALIASES) {
        setAliasErr(`at most ${MAX_ALIASES} aliases per repo`)
        return false
      }
      next.push(lowered)
    }
    setAliases(next)
    setAliasDraft('')
    setAliasErr(null)
    return true
  }

  const removeAlias = (target: string) => {
    setAliases((prev) => prev.filter((a) => a !== target))
    setAliasErr(null)
  }

  const onAliasKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault()
      commitAliasDraft(aliasDraft)
      return
    }
    // Backspace on an empty input pops the last chip. common
    // chip-input idiom that lets the operator correct typos without
    // reaching for the mouse.
    if (e.key === 'Backspace' && aliasDraft.length === 0 && aliases.length > 0) {
      e.preventDefault()
      const last = aliases[aliases.length - 1]
      if (last !== undefined) {
        setAliases((prev) => prev.slice(0, -1))
        setAliasDraft(last)
      }
    }
  }

  const submit = async () => {
    // Auto-commit any pending draft so the operator doesn't lose the
    // last chip they typed but didn't press Enter on.
    if (aliasDraft.trim().length > 0) {
      const ok = commitAliasDraft(aliasDraft)
      if (!ok) return
    }
    setBusy(true)
    setErr(null)
    try {
      await patchAttachedRepo(agentId, attachment.repo.id, {
        role: role.trim() || null,
        description: description.trim() || null,
        aliases,
      })
      toast.success('Attachment updated')
      onClose()
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Save failed',
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet
      open
      onClose={guardedClose}
      title="Edit role"
      subtitle={`Role + description for ${shortRepoName(attachment.repo.remoteUrl)} on this agent.`}
      primaryLabel="Save changes"
      onPrimary={submit}
      primaryBusy={busy}
    >
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="ear-role">
          Role
        </label>
        <input
          id="ear-role"
          className="ab-input"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          placeholder="e.g. backend, docs, infra"
          autoFocus
        />
        <span className="ab-field-help">
          Hint that helps the agent reason about which repo to consult.
        </span>
      </div>
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="ear-desc">
          Description
        </label>
        <textarea
          id="ear-desc"
          className="ab-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this repo gives the agent visibility into."
        />
      </div>
      <div className="ab-field">
        <label className="ab-field-label" htmlFor="ear-aliases">
          Aliases
        </label>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 6,
            padding: aliases.length > 0 ? '8px 8px 4px' : 0,
            border: aliases.length > 0 ? '1px solid var(--border)' : 'none',
            borderRadius: 'var(--radius)',
            background: aliases.length > 0 ? 'var(--surface)' : 'transparent',
            marginBottom: aliases.length > 0 ? 6 : 0,
          }}
        >
          {aliases.map((alias) => (
            <span
              key={alias}
              className="ab-pill ab-pill-accent"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
            >
              {alias}
              <button
                type="button"
                aria-label={`Remove alias ${alias}`}
                onClick={() => removeAlias(alias)}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  padding: 0,
                  font: 'inherit',
                  fontSize: '14px',
                  lineHeight: 1,
                  opacity: 0.7,
                }}
              >
                ×
              </button>
            </span>
          ))}
        </div>
        <input
          id="ear-aliases"
          className="ab-input"
          value={aliasDraft}
          onChange={(e) => {
            setAliasDraft(e.target.value)
            if (aliasErr) setAliasErr(null)
          }}
          onKeyDown={onAliasKeyDown}
          onBlur={() => {
            if (aliasDraft.trim().length > 0) commitAliasDraft(aliasDraft)
          }}
          placeholder={
            aliases.length === 0
              ? 'web-app, fe, client'
              : `add another (${MAX_ALIASES - aliases.length} left)`
          }
          disabled={aliases.length >= MAX_ALIASES}
        />
        {aliasErr ? (
          <span
            className="ab-field-help"
            role="alert"
            style={{ color: 'var(--danger)' }}
          >
            {aliasErr}
          </span>
        ) : (
          <span className="ab-field-help">
            Add anything a coding agent might use to refer to this repo -
            local folder names (e.g. <code>web-app</code>), short codes
            (<code>fe</code>, <code>bff</code>), legacy names. The toolkit
            fuzzy-matches against these. Press Enter or comma to add.
          </span>
        )}
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

export function EditAttachedRepoSheet({
  open,
  agentId,
  attachment,
  onClose,
}: {
  open: boolean
  agentId: string
  attachment: AttachedRepoResponse | null
  onClose: () => void
}) {
  const [openCount, setOpenCount] = useState(0)
  const [prevOpen, setPrevOpen] = useState(open)
  if (prevOpen !== open) {
    setPrevOpen(open)
    if (open) setOpenCount((c) => c + 1)
  }
  if (!open || !attachment) {
    return (
      <Sheet open={false} onClose={onClose} title="Edit role">
        <></>
      </Sheet>
    )
  }
  return (
    <EditForm
      key={`${openCount}:${attachment.repo.id}`}
      agentId={agentId}
      attachment={attachment}
      onClose={onClose}
    />
  )
}
