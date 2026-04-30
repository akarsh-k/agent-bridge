/**
 * Memory tab — Mastra-backed agent memory configuration. Toggles
 * the memory engine on/off, then surfaces the three sub-systems:
 * `lastMessages` window, working-memory template, and
 * semantic-recall via embeddings.
 */

import { useMemo, useState } from 'react'
import { memoryScopes, type MemoryScope } from '@agent-bridge/shared'
import { useWorkspace } from '../../lib/workspace-context'
import { Button } from '../../ui/button'
import { Pill } from '../../ui/pill'
import { Dropdown, type DropdownOption } from '../../ui/dropdown'
import { toast } from '../../ui/toast-store'
import { ApiError } from '../../lib/rpc'

const SCOPE_OPTS: DropdownOption<MemoryScope>[] = memoryScopes.map((s) => ({
  value: s,
  label:
    s === 'thread'
      ? 'thread (this conversation only)'
      : 'resource (across conversations)',
}))

type LastMessagesMode = 'off' | 'count'

export function MemoryTab({ agentId }: { agentId: string }) {
  const { agents, llmProviders, patchAgent } = useWorkspace()
  const agent = agents.find((a) => a.id === agentId)

  const [seededFor, setSeededFor] = useState<string | null>(null)
  const [enabled, setEnabled] = useState(false)
  const [lastMode, setLastMode] = useState<LastMessagesMode>('count')
  const [lastN, setLastN] = useState(20)
  const [generateTitle, setGenerateTitle] = useState(false)

  // working memory
  const [wmEnabled, setWmEnabled] = useState(false)
  const [wmTemplate, setWmTemplate] = useState('')
  const [wmScope, setWmScope] = useState<MemoryScope>('thread')

  // semantic recall
  const [srEnabled, setSrEnabled] = useState(false)
  const [srTopK, setSrTopK] = useState(5)
  const [srMessageRange, setSrMessageRange] = useState(2)
  const [srScope, setSrScope] = useState<MemoryScope>('thread')

  const [busy, setBusy] = useState(false)

  if (agent && seededFor !== agent.id) {
    setSeededFor(agent.id)
    setEnabled(agent.memoryEnabled)
    const cfg = agent.memoryConfig ?? null
    if (cfg?.lastMessages === false) {
      setLastMode('off')
      setLastN(20)
    } else if (typeof cfg?.lastMessages === 'number') {
      setLastMode('count')
      setLastN(cfg.lastMessages)
    } else {
      setLastMode('count')
      setLastN(20)
    }
    setGenerateTitle(cfg?.generateTitle ?? false)
    setWmEnabled(cfg?.workingMemory?.enabled ?? false)
    setWmTemplate(cfg?.workingMemory?.template ?? '')
    setWmScope(cfg?.workingMemory?.scope ?? 'thread')
    setSrEnabled(cfg?.semanticRecall !== undefined)
    setSrTopK(cfg?.semanticRecall?.topK ?? 5)
    const range = cfg?.semanticRecall?.messageRange
    setSrMessageRange(typeof range === 'number' ? range : 2)
    setSrScope(cfg?.semanticRecall?.scope ?? 'thread')
  }

  const provider = useMemo(
    () =>
      agent?.llmProviderId
        ? llmProviders.find((p) => p.id === agent.llmProviderId)
        : null,
    [llmProviders, agent],
  )
  const semanticPossible = !!provider?.defaultEmbeddingModel

  if (!agent) return null

  const save = async () => {
    setBusy(true)
    try {
      const config: Record<string, unknown> = {}
      if (lastMode === 'off') config.lastMessages = false
      else config.lastMessages = lastN
      if (generateTitle) config.generateTitle = true
      if (wmEnabled) {
        const wm: Record<string, unknown> = { enabled: true, scope: wmScope }
        if (wmTemplate.trim()) wm.template = wmTemplate.trim()
        config.workingMemory = wm
      }
      if (srEnabled) {
        config.semanticRecall = {
          topK: srTopK,
          messageRange: srMessageRange,
          scope: srScope,
        }
      }

      await patchAgent(agent.id, {
        memoryEnabled: enabled,
        memoryConfig:
          enabled && Object.keys(config).length > 0
            ? (config as never)
            : null,
      })
      toast.success('Memory settings saved')
    } catch (e) {
      toast.error(
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
    <div>
      <div className="ab-card ab-card-pad ab-form-section">
        <div
          className="ab-section-head"
          style={{ display: 'flex', alignItems: 'center', gap: 12 }}
        >
          <div style={{ flex: 1 }}>
            <div className="ab-section-title">Memory engine</div>
            <div className="ab-section-sub">
              Long-term context layered on top of {agent.name}'s system prompt.
            </div>
          </div>
          <Pill kind={enabled ? 'success' : 'neutral'} dot>
            {enabled ? 'Enabled' : 'Disabled'}
          </Pill>
          <Button
            variant={enabled ? 'secondary' : 'primary'}
            onClick={() => setEnabled((v) => !v)}
          >
            {enabled ? 'Disable' : 'Enable memory'}
          </Button>
        </div>
      </div>

      <div
        className="ab-card ab-card-pad ab-form-section"
        style={enabled ? undefined : { opacity: 0.5, pointerEvents: 'none' }}
      >
        <div className="ab-section-head">
          <div className="ab-section-title">Recent messages</div>
          <div className="ab-section-sub">
            How many recent turns of the active thread to replay before each
            request. Higher = better continuity, larger context.
          </div>
        </div>
        <div className="ab-field-grid">
          <div className="ab-field">
            <span className="ab-field-label">Mode</span>
            <Dropdown<LastMessagesMode>
              value={lastMode}
              onChange={setLastMode}
              options={[
                { value: 'count', label: 'Replay last N messages' },
                { value: 'off', label: 'Off (cold start every turn)' },
              ]}
            />
          </div>
          <div className="ab-field">
            <label className="ab-field-label" htmlFor="mt-lastn">
              N
            </label>
            <input
              id="mt-lastn"
              className="ab-input ab-mono"
              type="number"
              min={0}
              max={1000}
              value={lastN}
              onChange={(e) => setLastN(Math.max(0, Number(e.target.value)))}
              disabled={lastMode === 'off'}
            />
          </div>
          <div className="ab-field ab-field-col">
            <label
              className="ab-field-label"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
            >
              <input
                type="checkbox"
                checked={generateTitle}
                onChange={(e) => setGenerateTitle(e.target.checked)}
              />
              Auto-generate thread titles
            </label>
            <span className="ab-field-help">
              Mastra summarises the thread into a short title once enough
              messages accumulate.
            </span>
          </div>
        </div>
      </div>

      <div
        className="ab-card ab-card-pad ab-form-section"
        style={enabled ? undefined : { opacity: 0.5, pointerEvents: 'none' }}
      >
        <div
          className="ab-section-head"
          style={{ display: 'flex', alignItems: 'center', gap: 12 }}
        >
          <div style={{ flex: 1 }}>
            <div className="ab-section-title">Working memory</div>
            <div className="ab-section-sub">
              A markdown scratchpad the agent maintains across turns —
              user preferences, project facts, anything worth keeping.
            </div>
          </div>
          <Button
            variant={wmEnabled ? 'secondary' : 'ghost'}
            onClick={() => setWmEnabled((v) => !v)}
          >
            {wmEnabled ? 'Disable' : 'Enable'}
          </Button>
        </div>
        {wmEnabled && (
          <div className="ab-field-grid">
            <div className="ab-field">
              <span className="ab-field-label">Scope</span>
              <Dropdown<MemoryScope>
                value={wmScope}
                onChange={setWmScope}
                options={SCOPE_OPTS}
              />
            </div>
            <div className="ab-field" />
            <div className="ab-field ab-field-col">
              <label className="ab-field-label" htmlFor="mt-tmpl">
                Template (markdown)
              </label>
              <textarea
                id="mt-tmpl"
                className="ab-textarea ab-mono"
                rows={6}
                value={wmTemplate}
                onChange={(e) => setWmTemplate(e.target.value)}
                placeholder="# User context&#10;- Name:&#10;- Role:&#10;# Project facts&#10;- "
              />
              <span className="ab-field-help">
                Optional starter shape. The agent fills these in over time.
              </span>
            </div>
          </div>
        )}
      </div>

      <div
        className="ab-card ab-card-pad ab-form-section"
        style={
          enabled && semanticPossible
            ? undefined
            : { opacity: 0.5, pointerEvents: 'none' }
        }
      >
        <div
          className="ab-section-head"
          style={{ display: 'flex', alignItems: 'center', gap: 12 }}
        >
          <div style={{ flex: 1 }}>
            <div className="ab-section-title">Semantic recall</div>
            <div className="ab-section-sub">
              Embed every assistant turn and retrieve the top-K most-similar
              chunks before answering. Requires an embedding model on the
              provider.
            </div>
          </div>
          {!semanticPossible && (
            <Pill kind="warn" dot>
              Provider has no embedding model
            </Pill>
          )}
          <Button
            variant={srEnabled ? 'secondary' : 'ghost'}
            onClick={() => setSrEnabled((v) => !v)}
            disabled={!semanticPossible}
          >
            {srEnabled ? 'Disable' : 'Enable'}
          </Button>
        </div>
        {srEnabled && (
          <div className="ab-field-grid">
            <div className="ab-field">
              <label className="ab-field-label" htmlFor="mt-topk">
                Top K
              </label>
              <input
                id="mt-topk"
                className="ab-input ab-mono"
                type="number"
                min={1}
                max={100}
                value={srTopK}
                onChange={(e) => setSrTopK(Math.max(1, Number(e.target.value)))}
              />
            </div>
            <div className="ab-field">
              <label className="ab-field-label" htmlFor="mt-range">
                Message range
              </label>
              <input
                id="mt-range"
                className="ab-input ab-mono"
                type="number"
                min={0}
                value={srMessageRange}
                onChange={(e) =>
                  setSrMessageRange(Math.max(0, Number(e.target.value)))
                }
              />
            </div>
            <div className="ab-field ab-field-col">
              <span className="ab-field-label">Scope</span>
              <Dropdown<MemoryScope>
                value={srScope}
                onChange={setSrScope}
                options={SCOPE_OPTS}
              />
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button variant="primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save memory settings'}
        </Button>
      </div>
    </div>
  )
}
