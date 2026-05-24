/**
 * Library → Files. Workspace-wide list of knowledge documents the
 * operator has uploaded. Files attached here become available for
 * agents to read via `search_knowledge` once an agent picks them up
 * in the Resources panel.
 *
 * UI structure (top to bottom):
 *
 *   ┌─ PageHeader ────────────────── [Upload file] [⋯ overflow] ┐
 *   │  Subtitle prose.                                            │
 *   └─────────────────────────────────────────────────────────────┘
 *   ┌─ Stats strip: FILES · CHUNKS · STORAGE · IN FLIGHT · FAILED ┐
 *   ┌─ Toolbar: [All] [In flight] [Ready] [Errors] ─── [search]   ┐
 *   ┌─ List card OR drop-zone empty state ────────────────────────┐
 *   │  ▌ FileRow with status pill, chunk count, time, retry,      │
 *   │    inline progress bar on in-flight, danger stripe on err.  │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * A full-page drag overlay snaps into view whenever the OS drags a
 * file across the window — the operator can drop anywhere on the page
 * to upload, not just on the empty state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  FILE_KINDS,
  fileStreamId,
  type FileIngestStatus,
  type FileResponse,
} from '@agent-bridge/shared'
import { useWorkspace } from '../../../lib/workspace-context'
import { useSSE } from '../../../lib/use-sse'
import { PageHeader } from '../../_chrome/page-header'
import { Button } from '../../../ui/button'
import { Pill, type PillKind } from '../../../ui/pill'
import { RowMenu } from '../../../ui/row-menu'
import {
  CloseIcon,
  FileIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
} from '../../../ui/icons'
import { confirmDialog } from '../../../ui/dialog-store'
import { LibraryAttachNote } from '../../../ui/library-attach-note'
import { toast } from '../../../ui/toast-store'
import { ApiError } from '../../../lib/rpc'

const STATUS_PILL: Record<
  FileIngestStatus,
  { kind: PillKind; label: string; dot?: boolean }
> = {
  pending: { kind: 'neutral', label: 'Pending', dot: true },
  extracting: { kind: 'warn', label: 'Extracting', dot: true },
  chunking: { kind: 'warn', label: 'Chunking', dot: true },
  embedding: { kind: 'warn', label: 'Embedding', dot: true },
  describing: { kind: 'warn', label: 'Describing', dot: true },
  ready: { kind: 'success', label: 'Ready' },
  error: { kind: 'danger', label: 'Error' },
}

const IN_FLIGHT_STATUSES: ReadonlySet<FileIngestStatus> = new Set([
  'pending',
  'extracting',
  'chunking',
  'embedding',
  'describing',
])

const ACCEPT_ATTR =
  FILE_KINDS.map((k) => `.${k}`).join(',') + ',text/plain,text/markdown'

type FilterKey = 'all' | 'inflight' | 'ready' | 'error'

const FILTERS: ReadonlyArray<{ key: FilterKey; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'inflight', label: 'In flight' },
  { key: 'ready', label: 'Ready' },
  { key: 'error', label: 'Errors' },
]

export function FilesPage() {
  const { files, uploadFile, patchFile, removeFile, reingestFile, refreshFile } =
    useWorkspace()
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = useState(false)
  const [reembedding, setReembedding] = useState(false)
  const [filter, setFilter] = useState<FilterKey>('all')
  const [query, setQuery] = useState('')

  // ─── Stats (computed from the live `files` list) ───────────────────
  const stats = useMemo(() => {
    let inflight = 0
    let ready = 0
    let errored = 0
    let totalChunks = 0
    let totalBytes = 0
    for (const f of files) {
      if (IN_FLIGHT_STATUSES.has(f.ingestStatus)) inflight += 1
      if (f.ingestStatus === 'ready') ready += 1
      if (f.ingestStatus === 'error') errored += 1
      totalChunks += f.chunksDone
      totalBytes += f.bytes
    }
    return {
      total: files.length,
      inflight,
      ready,
      errored,
      totalChunks,
      totalBytes,
    }
  }, [files])

  const filterCounts = useMemo<Record<FilterKey, number>>(
    () => ({
      all: stats.total,
      inflight: stats.inflight,
      ready: stats.ready,
      error: stats.errored,
    }),
    [stats],
  )

  // ─── Visible list (filter + search) ────────────────────────────────
  const visibleFiles = useMemo(() => {
    const q = query.trim().toLowerCase()
    return files.filter((f) => {
      if (filter === 'inflight' && !IN_FLIGHT_STATUSES.has(f.ingestStatus))
        return false
      if (filter === 'ready' && f.ingestStatus !== 'ready') return false
      if (filter === 'error' && f.ingestStatus !== 'error') return false
      if (q) {
        return (
          f.name.toLowerCase().includes(q) ||
          f.description.toLowerCase().includes(q) ||
          f.filename.toLowerCase().includes(q)
        )
      }
      return true
    })
  }, [files, filter, query])

  // ─── Upload paths (button + drop) ──────────────────────────────────
  const runUpload = useCallback(
    async (file: File): Promise<void> => {
      setUploading(true)
      try {
        const result = await uploadFile({ file })
        if (result.duplicate) {
          toast.info(
            `Already uploaded as "${result.file.name}" — surfacing the existing copy.`,
          )
        } else {
          toast.success(`Uploaded "${result.file.name}"`)
        }
      } catch (err) {
        toast.error(
          err instanceof ApiError
            ? err.message
            : err instanceof Error
              ? err.message
              : 'Upload failed',
        )
      } finally {
        setUploading(false)
      }
    },
    [uploadFile],
  )

  const onPickFile = (): void => {
    inputRef.current?.click()
  }
  const onFileChosen = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    await runUpload(file)
  }

  // ─── Page-wide drag-and-drop ───────────────────────────────────────
  // Counter pattern: track dragenter / dragleave with a depth counter
  // so the overlay doesn't flicker as the cursor moves over child
  // elements (each child fires its own enter/leave pair).
  const [dragging, setDragging] = useState(false)
  const dragDepthRef = useRef(0)
  useEffect(() => {
    const onEnter = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      dragDepthRef.current += 1
      if (dragDepthRef.current === 1) setDragging(true)
    }
    const onLeave = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
      if (dragDepthRef.current === 0) setDragging(false)
    }
    const onDrop = (): void => {
      dragDepthRef.current = 0
      setDragging(false)
    }
    window.addEventListener('dragenter', onEnter)
    window.addEventListener('dragleave', onLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onEnter)
      window.removeEventListener('dragleave', onLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [])

  const onPageDragOver = (e: React.DragEvent<HTMLDivElement>): void => {
    if (!hasFiles(e.nativeEvent)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const onPageDrop = async (
    e: React.DragEvent<HTMLDivElement>,
  ): Promise<void> => {
    if (!hasFiles(e.nativeEvent)) return
    e.preventDefault()
    setDragging(false)
    dragDepthRef.current = 0
    const dropped = Array.from(e.dataTransfer.files)
    // Multi-file drop: upload them sequentially so a single 429 from
    // the embedder doesn't burn through the whole batch in parallel.
    for (const file of dropped) {
      await runUpload(file)
    }
  }

  // ─── Row actions ───────────────────────────────────────────────────
  const onRemove = async (f: FileResponse): Promise<void> => {
    if (
      !(await confirmDialog({
        title: `Delete "${f.name}"?`,
        body:
          'Removes the file from this workspace and detaches it from every agent ' +
          'that referenced it. Cannot be undone.',
        confirmLabel: 'Delete file',
        destructive: true,
      }))
    ) {
      return
    }
    try {
      await removeFile(f.id)
      toast.success('File deleted')
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Delete failed',
      )
    }
  }

  const onReingest = async (f: FileResponse): Promise<void> => {
    try {
      await reingestFile(f.id)
      toast.success('Reingest queued')
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Reingest failed',
      )
    }
  }

  const onReembedAll = async (): Promise<void> => {
    if (
      !(await confirmDialog({
        title: `Re-embed all ${files.length} file(s)?`,
        body:
          'Clears every chunk and re-runs extraction → chunking → embedding ' +
          'against the active embedding provider. Use this after switching ' +
          'embedding models. Queries against these files will return nothing ' +
          'until each file finishes re-embedding.',
        confirmLabel: 'Re-embed all',
        kind: 'warning',
      }))
    ) {
      return
    }
    setReembedding(true)
    try {
      const res = await fetch(`/api/files/re-embed-all`, { method: 'POST' })
      if (!res.ok) throw new Error(`Re-embed failed (${res.status})`)
      const body = (await res.json()) as { ok: boolean; queued: number }
      toast.success(`Re-embed queued for ${body.queued} file(s)`)
      for (const f of files) void refreshFile(f.id)
    } catch (err) {
      toast.error(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Re-embed failed',
      )
    } finally {
      setReembedding(false)
    }
  }

  // ─── Header overflow menu items (workspace-level destructive ops) ──
  const overflowItems = useMemo(
    () => [
      {
        label: reembedding ? 'Re-embedding…' : 'Re-embed all files',
        onClick: () => void onReembedAll(),
        disabled: files.length === 0 || reembedding || uploading,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files.length, reembedding, uploading],
  )

  return (
    <div
      className="ab-page"
      onDragOver={onPageDragOver}
      onDrop={(e) => void onPageDrop(e)}
    >
      <PageHeader
        title="Files"
        subtitle="Knowledge documents you've uploaded locally. Attach them to an agent in its Resources panel so the agent can search them via search_knowledge."
        actions={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button
              variant="primary"
              leading={<PlusIcon strokeWidth={2.4} />}
              onClick={onPickFile}
              disabled={uploading}
            >
              {uploading ? 'Uploading…' : 'Upload file'}
            </Button>
            <RowMenu items={overflowItems} />
          </div>
        }
      />

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT_ATTR}
        onChange={(e) => void onFileChosen(e)}
        style={{ display: 'none' }}
      />

      <LibraryAttachNote subject="file" />

      {files.length > 0 && <StatsStrip stats={stats} />}

      {files.length > 0 && (
        <Toolbar
          filter={filter}
          counts={filterCounts}
          onFilterChange={setFilter}
          query={query}
          onQueryChange={setQuery}
        />
      )}

      {files.length === 0 ? (
        <EmptyDropZone
          uploading={uploading}
          isDragging={dragging}
          onClick={onPickFile}
        />
      ) : visibleFiles.length === 0 ? (
        <div className="ab-card ab-files-no-match">
          No files match this view.
          <button onClick={() => { setFilter('all'); setQuery('') }}>
            Clear filters
          </button>
        </div>
      ) : (
        <div className="ab-card ab-list-card">
          {visibleFiles.map((f) => (
            <FileRow
              key={f.id}
              file={f}
              onRemove={() => void onRemove(f)}
              onReingest={() => onReingest(f)}
              onRefresh={() => void refreshFile(f.id)}
              onPatch={(patch) =>
                patchFile(f.id, patch)
                  .then(() => {
                    /* discard the FileResponse; the provider already
                     * mirrored the row into workspace state. The caller
                     * only needs to know the round-trip finished. */
                  })
                  .catch((err) => {
                    toast.error(
                      err instanceof ApiError
                        ? err.message
                        : err instanceof Error
                          ? err.message
                          : 'Save failed',
                    )
                  })
              }
            />
          ))}
        </div>
      )}

      {dragging && <DropOverlay />}
    </div>
  )
}

// ─── Stats strip ──────────────────────────────────────────────────────

interface StatsValues {
  total: number
  inflight: number
  ready: number
  errored: number
  totalChunks: number
  totalBytes: number
}

function StatsStrip({ stats }: { stats: StatsValues }) {
  return (
    <ul className="ab-files-stats">
      <Stat label="Files" value={formatCount(stats.total)} />
      <Stat label="Chunks" value={formatCount(stats.totalChunks)} />
      <Stat label="Storage" value={formatBytes(stats.totalBytes)} />
      {stats.inflight > 0 && (
        <Stat
          label="In flight"
          value={formatCount(stats.inflight)}
          tone="warn"
        />
      )}
      {stats.errored > 0 && (
        <Stat
          label="Failed"
          value={formatCount(stats.errored)}
          tone="danger"
        />
      )}
    </ul>
  )
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'warn' | 'danger'
}) {
  const valueClass =
    tone === 'warn'
      ? 'ab-files-stat-value is-warn'
      : tone === 'danger'
        ? 'ab-files-stat-value is-danger'
        : 'ab-files-stat-value'
  return (
    <li className="ab-files-stat">
      <span className="ab-files-stat-label">{label}</span>
      <span className={valueClass}>{value}</span>
    </li>
  )
}

// ─── Toolbar (filter chips + search) ──────────────────────────────────

function Toolbar({
  filter,
  counts,
  onFilterChange,
  query,
  onQueryChange,
}: {
  filter: FilterKey
  counts: Record<FilterKey, number>
  onFilterChange: (next: FilterKey) => void
  query: string
  onQueryChange: (next: string) => void
}) {
  return (
    <div className="ab-files-toolbar">
      <div className="ab-files-filter-row" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            role="tab"
            aria-selected={filter === f.key}
            onClick={() => onFilterChange(f.key)}
            className={`ab-files-chip ${filter === f.key ? 'is-active' : ''}`}
          >
            {f.label}
            <span className="ab-files-chip-count">{counts[f.key]}</span>
          </button>
        ))}
      </div>
      <div className="ab-files-search">
        <SearchIcon className="ab-files-search-icon" />
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search files…"
          aria-label="Search files"
        />
        {query && (
          <button
            className="ab-files-search-clear"
            onClick={() => onQueryChange('')}
            aria-label="Clear search"
          >
            <CloseIcon strokeWidth={2} style={{ width: 12, height: 12 }} />
          </button>
        )}
      </div>
    </div>
  )
}

// ─── Drop overlay (full-page) ─────────────────────────────────────────

function DropOverlay() {
  return (
    <div className="ab-files-drop-overlay">
      <div className="ab-files-drop-panel">
        <div className="ab-files-drop-panel-icon">
          <FileIcon style={{ width: 22, height: 22 }} />
        </div>
        <div className="ab-files-drop-panel-title">Drop to upload</div>
        <div className="ab-files-drop-panel-sub">
          Supported: <code>.md</code> · <code>.txt</code> · <code>.pdf</code>
        </div>
      </div>
    </div>
  )
}

// ─── Empty state (doubles as a drop zone) ─────────────────────────────

function EmptyDropZone({
  uploading,
  isDragging,
  onClick,
}: {
  uploading: boolean
  isDragging: boolean
  onClick: () => void
}) {
  return (
    <div
      className={`ab-files-empty ${isDragging ? 'is-dragover' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
    >
      <div className="ab-files-empty-glyph">
        <FileIcon style={{ width: 24, height: 24 }} />
      </div>
      <div>
        <div className="ab-files-empty-title">
          {uploading ? 'Uploading…' : 'Drop files here or click to browse'}
        </div>
        <div className="ab-files-empty-body" style={{ marginTop: 6 }}>
          Upload a markdown, text, or PDF file to make it searchable by
          your agents. We chunk it, embed it, and store everything
          locally — press <kbd>Esc</kbd> to cancel a drag.
        </div>
      </div>
    </div>
  )
}

// ─── Description editor ──────────────────────────────────────────────

const DESC_MAX = 500
const DESC_WARN_AT = 450

/**
 * Inline editor for the file's description. Renders a textarea that
 * auto-grows from 3 lines up to a fixed ceiling (CSS-controlled), a
 * counter, and Save / Cancel buttons.
 *
 * Save triggers when the operator clicks Save OR presses
 * Cmd/Ctrl + Enter OR the textarea blurs with changes. Plain Enter
 * inserts a newline (standard textarea behavior), Esc cancels.
 *
 * The editor commits its own draft locally and only calls `onSave`
 * with the trimmed final string — the parent doesn't need to mirror
 * keystrokes.
 */
function DescriptionEditor({
  initial,
  onSave,
  onCancel,
}: {
  initial: string
  onSave: (next: string) => void
  onCancel: () => void
}) {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLTextAreaElement | null>(null)

  // Focus + select-all on mount so re-edit lands the operator inside
  // the existing copy ready to overwrite or extend.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
    autosize(el)
  }, [])

  const commit = (): void => onSave(value.trim())

  return (
    <div className="ab-files-desc" onClick={(e) => e.stopPropagation()}>
      <textarea
        ref={ref}
        className="ab-files-desc-textarea"
        value={value}
        maxLength={DESC_MAX}
        rows={3}
        placeholder="Describe what's in this file so the agent knows when to search it. Mention topics, document type, and any keywords the agent should match on."
        onChange={(e) => {
          setValue(e.target.value)
          autosize(e.currentTarget)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            onCancel()
          } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault()
            commit()
          }
        }}
        onBlur={(e) => {
          // Blur via clicking Save/Cancel inside the editor shouldn't
          // double-fire — stopPropagation on the wrapper handles that.
          // Blur to anything else commits if the value changed.
          if (e.relatedTarget instanceof HTMLElement) {
            const inEditor = e.relatedTarget.closest('.ab-files-desc')
            if (inEditor) return
          }
          if (value.trim() !== initial.trim()) commit()
          else onCancel()
        }}
      />
      <div className="ab-files-desc-toolbar">
        <div className="ab-files-desc-hint">
          <kbd>⌘</kbd> <kbd>↵</kbd> save · <kbd>esc</kbd> cancel
          <span
            className={`ab-files-desc-count ${value.length >= DESC_WARN_AT ? 'is-warn' : ''}`}
          >
            {value.length} / {DESC_MAX}
          </span>
        </div>
        <div className="ab-files-desc-actions">
          <button
            type="button"
            className="ab-files-desc-btn is-ghost"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ab-files-desc-btn is-primary"
            onMouseDown={(e) => e.preventDefault()}
            onClick={commit}
            disabled={value.trim() === initial.trim()}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Resize a textarea to fit its content, capped by the CSS max-height.
 * Called on mount + every change so the editor grows naturally as the
 * operator types. Cheap — single reflow per keystroke.
 */
function autosize(el: HTMLTextAreaElement): void {
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

// ─── File row ─────────────────────────────────────────────────────────

function FileRow({
  file,
  onRemove,
  onReingest,
  onRefresh,
  onPatch,
}: {
  file: FileResponse
  onRemove: () => void
  /** Returns a Promise so callers that need to chain (e.g.
   *  `switchChunkingMode` patches first, then reingests) can await
   *  the round-trip and avoid the PATCH-vs-POST race where reingest
   *  might land server-side before the chunkingMode change does. */
  onReingest: () => Promise<void>
  /** Re-fetch this file's row from the backend. Triggered by ingest
   *  SSE events so the status pill + chunks_done stay current without
   *  polling. */
  onRefresh: () => void
  /** Same Promise contract as `onReingest` — see `switchChunkingMode`. */
  onPatch: (patch: {
    name?: string
    description?: string
    chunkingMode?: FileResponse['chunkingMode']
  }) => Promise<void>
}) {
  const sp = STATUS_PILL[file.ingestStatus]
  const inFlight = IN_FLIGHT_STATUSES.has(file.ingestStatus)
  const failed = file.ingestStatus === 'error'

  const [editingDescription, setEditingDescription] = useState(false)
  const [descDraft, setDescDraft] = useState(file.description)

  // ── Live ingest subscription (per-file SSE). Stays closed for
  //    terminal rows; useSSE(null) is a no-op. Refreshes the row on
  //    every `knowledge.ingest.*` event so the pill + progress bar
  //    follow the pipeline live without polling.
  const streamId = inFlight ? fileStreamId(file.id) : null
  const { events: ingestEvents } = useSSE(streamId, { cap: 32 })
  const lastEventTsRef = useRef<number>(0)
  // Latest-onRefresh ref. The parent passes `() => void refreshFile(f.id)`
  // inline, so onRefresh changes identity on every render. Putting it in
  // an effect dep array would cleanup+remount the SSE subscription
  // (closing + reopening the EventSource AND resetting `ingestEvents`)
  // on every parent re-render — which fires constantly as in-flight rows
  // refresh themselves. We mirror onRefresh into a ref instead and read
  // through that, so the effects depend only on real state changes.
  const onRefreshRef = useRef(onRefresh)
  useEffect(() => {
    onRefreshRef.current = onRefresh
  }, [onRefresh])

  useEffect(() => {
    if (ingestEvents.length === 0) return
    const latest = ingestEvents[ingestEvents.length - 1]
    if (!latest) return
    if (!latest.kind.startsWith('knowledge.ingest.')) return
    if (latest.ts <= lastEventTsRef.current) return
    lastEventTsRef.current = latest.ts
    onRefreshRef.current()
  }, [ingestEvents])

  // ── Backstop poll for in-flight rows. SSE is the primary update
  //    path, but the upload flow has a race window: the backend can
  //    publish the first `knowledge.ingest.*` events before the row's
  //    EventSource finishes connecting (Redis pub/sub doesn't buffer).
  //    Without a fallback the row reads `pending` forever even when
  //    the backend has long since reached `ready`. An 8s poll is slow
  //    enough that it doesn't matter in the normal SSE-works case
  //    (the SSE refresh fires within 1-2s and the row leaves the
  //    in-flight set, cleaning up this interval), and fast enough to
  //    not feel broken when SSE misses the window.
  useEffect(() => {
    if (!inFlight) return
    const handle = window.setInterval(() => onRefreshRef.current(), 8_000)
    return () => window.clearInterval(handle)
  }, [inFlight])

  // ── Latest embedding-step counters from the SSE stream so the row
  //    can show "12 / 45" instead of a vague spinner.
  const embedProgress = useMemo(() => {
    for (let i = ingestEvents.length - 1; i >= 0; i--) {
      const ev = ingestEvents[i]
      if (!ev || ev.kind !== 'knowledge.ingest.progress') continue
      const payload = ev.data as
        | { step?: string; chunksDone?: number; chunksTotal?: number }
        | null
      if (
        payload?.step === 'embedding' &&
        typeof payload.chunksDone === 'number' &&
        typeof payload.chunksTotal === 'number'
      ) {
        return { done: payload.chunksDone, total: payload.chunksTotal }
      }
    }
    return null
  }, [ingestEvents])

  // ── Description draft sync (when an external refresh changes
  //    persisted text while we're not actively editing).
  useEffect(() => {
    if (editingDescription) return
    let alive = true
    void (async () => {
      await Promise.resolve()
      if (!alive) return
      setDescDraft((prev) =>
        prev === file.description ? prev : file.description,
      )
    })()
    return () => {
      alive = false
    }
  }, [file.description, editingDescription])

  // ── Subtext: description when present + meaningful; otherwise the
  //    KB/format facts. Errors take their own dedicated render path
  //    so we don't cram a stack trace into the subtitle slot.
  const sub = useMemo(() => {
    if (file.description.trim() && !inFlight && !failed) {
      return file.description
    }
    return null
  }, [file.description, inFlight, failed])

  // ── Progress bar fill width. Concrete % when we have counts, slim
  //    indeterminate slide for the early steps (extract/chunk).
  const progressFill = embedProgress
    ? (embedProgress.done / Math.max(embedProgress.total, 1)) * 100
    : null

  const rowClass = [
    'ab-list-row',
    'is-edit',
    'is-files-row',
    failed ? 'is-files-error' : '',
    editingDescription ? 'is-files-editing' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={rowClass}>
      <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
        {file.kind.charAt(0).toUpperCase()}
      </div>
      <div className="ab-list-row-head">
        <div className="ab-list-row-title">{file.name}</div>
        {failed && file.ingestError ? (
          <div className="ab-files-error-text" title={file.ingestError}>
            {file.ingestError}
          </div>
        ) : editingDescription ? (
          <DescriptionEditor
            initial={descDraft}
            onSave={(next) => {
              setEditingDescription(false)
              setDescDraft(next)
              if (next !== file.description) onPatch({ description: next })
            }}
            onCancel={() => {
              setEditingDescription(false)
              setDescDraft(file.description)
            }}
          />
        ) : sub ? (
          <div
            className="ab-list-row-sub"
            style={{ cursor: 'text' }}
            onClick={() => setEditingDescription(true)}
            title="Click to edit description"
          >
            {sub}
          </div>
        ) : (
          <div
            className="ab-list-row-sub"
            style={{
              cursor: 'text',
              fontStyle: 'italic',
              opacity: 0.7,
            }}
            onClick={() => setEditingDescription(true)}
            title="Click to add a description"
          >
            {inFlight
              ? embedProgress
                ? `Embedding ${embedProgress.done} / ${embedProgress.total} chunks`
                : `${capitalize(file.ingestStatus)}…`
              : 'Add a description so agents know when to search this file'}
          </div>
        )}
        <RowMeta
          file={file}
          inFlight={inFlight}
          failed={failed}
          embedProgress={embedProgress}
        />
      </div>
      <div className="ab-list-row-meta">
        <Pill kind={sp.kind} dot={sp.dot}>
          {sp.label}
        </Pill>
        {failed && (
          <button
            className="ab-files-retry"
            onClick={(e) => {
              e.stopPropagation()
              onReingest()
            }}
            title="Re-run the ingest pipeline against this file"
          >
            <RefreshIcon style={{ width: 11, height: 11 }} />
            Retry
          </button>
        )}
        <RowMenu
          items={[
            {
              label: 'Edit description',
              onClick: () => setEditingDescription(true),
              disabled: editingDescription,
            },
            { label: 'Reingest', onClick: onReingest },
            {
              label:
                file.chunkingMode === 'hierarchical'
                  ? 'Switch to flat chunking'
                  : 'Switch to hierarchical chunking',
              onClick: () => void switchChunkingMode(file, onPatch, onReingest),
            },
            {
              label: 'Delete file',
              destructive: true,
              onClick: onRemove,
            },
          ]}
        />
      </div>

      {inFlight && (
        <div className="ab-files-progress" aria-hidden="true">
          {progressFill !== null ? (
            <div
              className="ab-files-progress-fill"
              style={{ width: `${progressFill}%` }}
            />
          ) : (
            <div className="ab-files-progress-fill is-indeterminate" />
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Microdata strip under the description: kind · size · pages ·
 * chunks · relative time. Each fact is its own span so the row wraps
 * cleanly on narrow viewports (the meta line drops onto a second
 * row of the same flex container rather than getting cut off).
 */
function RowMeta({
  file,
  inFlight,
  failed,
  embedProgress,
}: {
  file: FileResponse
  inFlight: boolean
  failed: boolean
  embedProgress: { done: number; total: number } | null
}) {
  const parts: string[] = []
  parts.push(file.kind.toUpperCase())
  parts.push(formatBytes(file.bytes))
  if (file.pageCount != null) parts.push(`${file.pageCount}p`)
  if (file.ingestStatus === 'ready' && file.chunksDone > 0) {
    parts.push(`${file.chunksDone} chunks`)
  }
  if (inFlight && embedProgress) {
    parts.push(`${embedProgress.done} / ${embedProgress.total}`)
  }
  // Only surface the chunking mode when it's non-default — operators
  // who haven't switched should see a clean meta line. Hierarchical
  // mode gets a tiny "HIER" marker so they can spot it when scanning.
  if (file.chunkingMode === 'hierarchical') parts.push('HIER')
  // Skip the relative time on failure — the retry button already
  // earns that slot, and the time would dilute the danger signal.
  if (!failed) {
    const ts = Date.parse(file.updatedAt || file.createdAt)
    if (Number.isFinite(ts)) parts.push(formatRelative(ts))
  }

  return (
    <div className="ab-files-row-meta" title={file.filename}>
      {parts.map((p, i) => (
        <span key={i} style={{ display: 'inline-flex', gap: 6 }}>
          {i > 0 && <span className="ab-files-row-meta-sep">·</span>}
          {p}
        </span>
      ))}
    </div>
  )
}

// ─── Chunking-mode switch ─────────────────────────────────────────────

/**
 * Flip a file between `flat` and `hierarchical` chunking. The mode
 * change ONLY takes effect on the next ingest — existing chunks were
 * sliced under the old mode — so we (a) walk the operator through
 * what the change means via confirmDialog, (b) PATCH the row, and
 * (c) trigger a reingest so the new chunks land immediately. If the
 * operator cancels the dialog, nothing happens.
 *
 * Hierarchical mode is most useful for long structured documents
 * (legal contracts, technical specs, research papers) where the
 * right phrase needs surrounding section context. For short
 * topical PDFs the flat mode is fine and cheaper.
 */
async function switchChunkingMode(
  file: FileResponse,
  onPatch: (patch: {
    name?: string
    description?: string
    chunkingMode?: FileResponse['chunkingMode']
  }) => Promise<void>,
  onReingest: () => Promise<void>,
): Promise<void> {
  const next: FileResponse['chunkingMode'] =
    file.chunkingMode === 'hierarchical' ? 'flat' : 'hierarchical'
  const goingHier = next === 'hierarchical'
  const ok = await confirmDialog({
    title: `Switch "${file.name}" to ${next} chunking?`,
    body: goingHier
      ? 'Hierarchical chunking slices the document into large parent buckets (~1500 tokens, keyed by section heading) and smaller children (~400 tokens) that get embedded. Retrieval matches children precisely but returns the parent text as the snippet, so the LLM sees the right phrase with its surrounding context. Best for long structured documents. Ingest is slightly slower and storage is ~1.5x. Switching requires reingesting the file now.'
      : 'Flat chunking slices the document into ~800-token chunks, each embedded directly. Retrieval returns the exact matched chunk as the snippet. Cheaper and faster than hierarchical; best for short topical documents. Switching requires reingesting the file now.',
    confirmLabel: `Switch + reingest`,
    kind: 'warning',
  })
  if (!ok) return
  // CRITICAL ordering: await the PATCH before the reingest. Both are
  // separate HTTP requests with no server-side ordering guarantee —
  // if reingest landed first, `ingestKnowledgeFile` would read the
  // OLD `files.chunking_mode` from the DB and produce chunks with
  // the wrong layout. Awaiting the PATCH response ensures the DB has
  // the new mode before reingest reads it.
  await onPatch({ chunkingMode: next })
  await onReingest()
}

// ─── Utilities ─────────────────────────────────────────────────────────

function hasFiles(e: DragEvent | React.DragEvent['nativeEvent']): boolean {
  const dt = e.dataTransfer
  if (!dt) return false
  // dragenter on chromium sometimes reports types only (no items),
  // so check both. The `Files` type is the one OS-level drags use.
  if (dt.types && Array.from(dt.types).includes('Files')) return true
  return dt.items != null && dt.items.length > 0
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function formatCount(n: number): string {
  if (n < 1000) return n.toString()
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

function formatRelative(ts: number): string {
  if (!Number.isFinite(ts)) return ''
  const diff = Date.now() - ts
  if (diff < 0) return 'just now'
  const s = Math.round(diff / 1000)
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return `${d}d ago`
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1)
}
