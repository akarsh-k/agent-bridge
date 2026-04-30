/**
 * 30px brand-tinted tile used in resource list rows. Carries the
 * brand SVG inside, NOT a first-letter — first-letter glyphs in
 * library rows were explicitly called out as a polish failure.
 */

import { GithubMark, LinearMark, McpIcon, NotionMark } from './icons'

export type BrandKind = 'github' | 'linear' | 'notion' | 'mcp'

const meta: Record<BrandKind, { cls: string; mark: React.ComponentType }> = {
  github: { cls: 'ab-brand-github', mark: GithubMark },
  linear: { cls: 'ab-brand-linear', mark: LinearMark },
  notion: { cls: 'ab-brand-notion', mark: NotionMark },
  mcp: { cls: 'ab-brand-mcp', mark: McpIcon },
}

export function BrandGlyph({ kind }: { kind: BrandKind }) {
  const m = meta[kind]
  const Mark = m.mark
  return (
    <span className={`ab-brand-glyph ${m.cls}`}>
      <Mark />
    </span>
  )
}
