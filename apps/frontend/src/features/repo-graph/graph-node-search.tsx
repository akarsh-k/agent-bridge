/**
 * GraphNodeSearch — autocomplete combobox that lets the operator
 * find a specific node by name (or file path), gitnexus-style.
 *
 * Behaviour:
 *   - User types into the input.
 *   - A popover renders the top N matches against the current graph
 *     payload — case-insensitive substring on node `name` then on
 *     `filePath`. Name matches rank above path matches; matches on
 *     a name prefix rank above mid-string matches.
 *   - Up/Down arrow keys move the highlight; Enter picks; Esc closes
 *     the popover and clears the active highlight. Mouse click picks.
 *   - Picking a row calls `onSelect(nodeId)`, which the modal wires
 *     to its `selectedNodeId` state — that drives the existing
 *     focus mode in the Sigma canvas (selected node bumped, 1-hop
 *     neighbours kept bright, everything else dimmed) AND opens the
 *     details panel. Same effect a canvas-click would produce.
 *   - On pick, the input clears so the user can search again. The
 *     side panel + canvas state now reflect the choice.
 *
 * Why an autocomplete instead of a free-text filter:
 *   - The old filter hid everything that didn't match and expanded
 *     by one hop to keep context — a fine retrieval pattern, but
 *     it left the user with a sparse soup of disconnected matches
 *     that didn't read as "I found my thing".
 *   - The autocomplete answers a different question: "show me
 *     exactly this node, in context." It's what gitnexus does, and
 *     it composes cleanly with the existing click-to-focus flow.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { RepoGraph, RepoGraphNode, RepoGraphNodeKind } from '@agent-bridge/shared'

const MAX_RESULTS = 20

const KIND_LABEL: Record<RepoGraphNodeKind, string> = {
  function: 'Function',
  method: 'Method',
  class: 'Class',
  file: 'File',
  folder: 'Folder',
  process: 'Process',
  community: 'Community',
}

interface GraphNodeSearchProps {
  graph: RepoGraph | null
  onSelect: (nodeId: string) => void
}

interface Match {
  node: RepoGraphNode
  /** Lower-is-better rank. Drives the result ordering. */
  score: number
}

export function GraphNodeSearch({ graph, onSelect }: GraphNodeSearchProps) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(0)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const matches = useMemo<readonly Match[]>(() => {
    if (!graph) return []
    const term = query.trim().toLowerCase()
    if (term.length === 0) return []
    const out: Match[] = []
    for (const n of graph.nodes) {
      const name = n.name.toLowerCase()
      const path = (n.filePath ?? '').toLowerCase()
      let score: number | null = null
      // Name prefix is the strongest signal. Mid-name comes next.
      // Path contains is the fallback — folks searching "utils/api"
      // mean "the file at that path", not a symbol that happens to
      // be named that.
      if (name.startsWith(term)) score = 0
      else if (name.includes(term)) score = 1
      else if (path.includes(term)) score = 2
      if (score === null) continue
      // Secondary sort by name length so the most exact match floats
      // up among same-score hits ("Product" before "ProductCard").
      score = score * 1000 + Math.min(name.length, 999)
      out.push({ node: n, score })
      if (out.length > 200) break // hard cap before sort; cheap safety
    }
    out.sort((a, b) => a.score - b.score)
    return out.slice(0, MAX_RESULTS)
  }, [graph, query])

  // Re-anchor the active row to the top whenever the match set
  // changes so the user's keyboard nav doesn't point at empty space.
  // Adjust-state-during-render (React 19 idiom) instead of an effect
  // — same pattern used in NodeDetailsPanel.
  const [seenMatches, setSeenMatches] = useState(matches)
  if (seenMatches !== matches) {
    setSeenMatches(matches)
    setActiveIndex(0)
  }

  // Close the popover when the user clicks outside.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const showPopover = open && query.trim().length > 0

  const choose = (m: Match): void => {
    onSelect(m.node.id)
    setQuery('')
    setOpen(false)
    // Defocus the input so the global Esc handler (the modal's
    // close-on-Escape) takes over again — otherwise typing
    // resumes here without the user expecting it.
    inputRef.current?.blur()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (!showPopover) {
      // Open on first keystroke if there's something to show. The
      // change handler also opens, but the ArrowDown case below
      // needs the popover to be open to do anything useful.
      if (e.key === 'ArrowDown' && matches.length > 0) setOpen(true)
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, matches.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      const pick = matches[activeIndex]
      if (pick) {
        e.preventDefault()
        e.stopPropagation()
        choose(pick)
      }
    } else if (e.key === 'Escape') {
      // Stop the modal's outer Esc handler from also firing — the
      // first Esc should JUST close the popover; a second Esc (with
      // no popover open) closes the modal as before.
      if (open) {
        e.stopPropagation()
        setOpen(false)
      }
    }
  }

  return (
    <div ref={rootRef} className="graph-node-search">
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showPopover}
        aria-controls="graph-node-search-listbox"
        autoComplete="off"
        spellCheck={false}
        className="graph-node-search-input"
        placeholder="Search symbols, files…"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          if (!open) setOpen(true)
        }}
        onFocus={() => {
          if (query.trim().length > 0) setOpen(true)
        }}
        onKeyDown={onKeyDown}
        aria-label="Search nodes by name or file path"
      />
      {showPopover && (
        <div
          className="graph-node-search-popover"
          role="listbox"
          id="graph-node-search-listbox"
        >
          {matches.length === 0 ? (
            <div className="graph-node-search-empty">
              No nodes match <span className="ab-mono">"{query.trim()}"</span>
            </div>
          ) : (
            <>
              <div className="graph-node-search-meta">
                {matches.length === MAX_RESULTS
                  ? `Showing first ${MAX_RESULTS} of many — refine to narrow.`
                  : `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`}
              </div>
              <ul className="graph-node-search-list">
                {matches.map((m, i) => (
                  <li key={m.node.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={i === activeIndex}
                      className={
                        'graph-node-search-row' +
                        (i === activeIndex ? ' is-active' : '')
                      }
                      onMouseEnter={() => setActiveIndex(i)}
                      onClick={() => choose(m)}
                    >
                      <span
                        className={`graph-node-search-dot graph-node-icon-${m.node.kind}`}
                        aria-hidden
                      />
                      <span className="graph-node-search-name">
                        {renderHighlighted(m.node.name, query)}
                      </span>
                      <span className="graph-node-search-kind">
                        {KIND_LABEL[m.node.kind]}
                      </span>
                      {m.node.filePath && (
                        <span className="graph-node-search-path">
                          {m.node.filePath}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Wrap matching substrings in a <mark> so the user can see WHY a row
 * surfaced. Case-insensitive; if the query doesn't appear in the
 * given string (e.g. it matched the file path instead), returns the
 * plain string. No regex — substring math only, so special characters
 * in the query don't blow up.
 */
function renderHighlighted(text: string, query: string): React.ReactNode {
  const q = query.trim()
  if (q.length === 0) return text
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return text
  return (
    <>
      {text.slice(0, idx)}
      <mark className="graph-node-search-hit">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  )
}
