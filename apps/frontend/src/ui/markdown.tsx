/**
 * Minimal markdown renderer — handles headings, bold/italic/code,
 * links, ordered + unordered lists, paragraphs, fenced code blocks.
 * Intentionally not a full implementation. Used for skill body preview.
 */

import { useMemo } from 'react'

type Token =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'p'; text: string }
  | { kind: 'ul'; items: string[] }
  | { kind: 'ol'; items: string[] }
  | { kind: 'pre'; text: string }
  | { kind: 'hr' }

function tokenise(src: string): Token[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const out: Token[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (line.startsWith('```')) {
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        buf.push(lines[i]!)
        i++
      }
      i++ // skip closing ```
      out.push({ kind: 'pre', text: buf.join('\n') })
      continue
    }
    if (/^#{1,3} /.test(line)) {
      const m = line.match(/^(#{1,3}) (.+)$/)!
      out.push({
        kind: 'heading',
        level: m[1]!.length as 1 | 2 | 3,
        text: m[2]!,
      })
      i++
      continue
    }
    if (line.trim() === '---' || line.trim() === '***') {
      out.push({ kind: 'hr' })
      i++
      continue
    }
    if (/^\s*[-*] /.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*] /.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*[-*] /, ''))
        i++
      }
      out.push({ kind: 'ul', items })
      continue
    }
    if (/^\s*\d+\. /.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\. /.test(lines[i]!)) {
        items.push(lines[i]!.replace(/^\s*\d+\. /, ''))
        i++
      }
      out.push({ kind: 'ol', items })
      continue
    }
    if (line.trim() === '') {
      i++
      continue
    }
    // Paragraph — accumulate until blank line.
    const buf = [line]
    i++
    while (
      i < lines.length &&
      lines[i]!.trim() !== '' &&
      !/^#{1,3} |^\s*[-*] |^\s*\d+\. |^```/.test(lines[i]!)
    ) {
      buf.push(lines[i]!)
      i++
    }
    out.push({ kind: 'p', text: buf.join(' ') })
  }
  return out
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** Render inline span: **bold**, *italic*, `code`, [link](url). */
function renderInline(text: string): string {
  let s = escapeHtml(text)
  s = s.replace(
    /`([^`]+)`/g,
    '<code style="font-family: var(--font-mono); font-size: 0.9em; background: var(--surface-hi); padding: 1px 5px; border-radius: 4px;">$1</code>',
  )
  s = s.replace(
    /\*\*([^*]+)\*\*/g,
    '<strong style="font-weight: 600">$1</strong>',
  )
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer" style="color: var(--accent-300); text-decoration: underline">$1</a>',
  )
  return s
}

export function Markdown({ source }: { source: string }) {
  const tokens = useMemo(() => tokenise(source), [source])
  return (
    <div
      className="ab-md"
      style={{
        fontSize: 13,
        lineHeight: 1.65,
        color: 'var(--text)',
      }}
    >
      {tokens.map((t, i) => {
        switch (t.kind) {
          case 'heading': {
            const size = { 1: 18, 2: 16, 3: 14 }[t.level]
            return (
              <div
                key={i}
                style={{
                  fontSize: size,
                  fontWeight: 600,
                  letterSpacing: '-0.01em',
                  margin: '14px 0 6px',
                }}
                dangerouslySetInnerHTML={{ __html: renderInline(t.text) }}
              />
            )
          }
          case 'p':
            return (
              <p
                key={i}
                style={{ margin: '0 0 8px' }}
                dangerouslySetInnerHTML={{ __html: renderInline(t.text) }}
              />
            )
          case 'ul':
            return (
              <ul
                key={i}
                style={{
                  margin: '0 0 8px',
                  paddingLeft: 18,
                }}
              >
                {t.items.map((it, j) => (
                  <li
                    key={j}
                    dangerouslySetInnerHTML={{ __html: renderInline(it) }}
                  />
                ))}
              </ul>
            )
          case 'ol':
            return (
              <ol
                key={i}
                style={{
                  margin: '0 0 8px',
                  paddingLeft: 22,
                }}
              >
                {t.items.map((it, j) => (
                  <li
                    key={j}
                    dangerouslySetInnerHTML={{ __html: renderInline(it) }}
                  />
                ))}
              </ol>
            )
          case 'pre':
            return (
              <pre
                key={i}
                style={{
                  margin: '0 0 8px',
                  padding: '10px 12px',
                  background: 'var(--surface-hi)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--radius)',
                  fontFamily: 'var(--font-mono)',
                  fontSize: 12,
                  whiteSpace: 'pre-wrap',
                  overflowX: 'auto',
                }}
              >
                {t.text}
              </pre>
            )
          case 'hr':
            return (
              <hr
                key={i}
                style={{
                  border: 'none',
                  borderTop: '1px solid var(--border)',
                  margin: '12px 0',
                }}
              />
            )
        }
      })}
    </div>
  )
}
