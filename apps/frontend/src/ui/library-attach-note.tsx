/**
 * Quiet info note shown at the top of every workspace-library page
 * (Files, Repositories, MCP). Clarifies that adding to the library is
 * a workspace-level action — it makes the resource available, but
 * doesn't automatically grant any agent access to it. The operator
 * still has to attach it from the agent's Resources tab.
 *
 * Without this, the most common new-operator confusion is: "I added
 * the file / repo / MCP — why doesn't my agent see it?" The note
 * pre-empts the question.
 *
 * Visual: leans on the existing `.ab-alert` primitive (neutral tone,
 * so background blends with surrounding cards and the row never reads
 * as a warning). Single-line copy with parallel phrasing across the
 * three variants — only the noun + verb change.
 */

import type { ReactNode } from 'react'

export type LibrarySubject = 'file' | 'repo' | 'mcp'

const COPY: Record<
  LibrarySubject,
  { noun: string; verb: ReactNode; resourceSection: string }
> = {
  file: {
    noun: 'file',
    verb: 'attach the file',
    resourceSection: 'Files',
  },
  repo: {
    noun: 'repository',
    verb: 'attach the repo',
    resourceSection: 'Repositories',
  },
  mcp: {
    noun: 'connection',
    verb: 'enable its tools',
    resourceSection: 'MCP',
  },
}

export function LibraryAttachNote({
  subject,
}: {
  subject: LibrarySubject
}) {
  const { noun, verb, resourceSection } = COPY[subject]
  return (
    <div
      className="ab-alert"
      // Pull the note up slightly so it tucks under the page header
      // without an awkward gap, and trim the default 18px bottom
      // margin to 14 so it doesn't push the list too far down.
      style={{ marginTop: -6, marginBottom: 14 }}
      role="note"
    >
      <InfoIcon />
      <div className="ab-alert-body">
        <div className="ab-alert-sub">
          Adding a {noun} here makes it available across the workspace
          library. To use it inside an agent, open the agent and{' '}
          {verb} from its <strong>Resources</strong> tab →{' '}
          <strong>{resourceSection}</strong>.
        </div>
      </div>
    </div>
  )
}

function InfoIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{
        color: 'var(--accent-300, var(--accent-400))',
        flexShrink: 0,
      }}
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="8.01" />
      <line x1="12" y1="11" x2="12" y2="16" />
    </svg>
  )
}
