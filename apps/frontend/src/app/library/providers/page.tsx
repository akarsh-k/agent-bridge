import { useState } from 'react'
import { useWorkspace } from '../../../lib/workspace-context'
import { Link } from '../../../lib/link'
import { PageHeader } from '../../_chrome/page-header'
import { Button } from '../../../ui/button'
import { Pill } from '../../../ui/pill'
import { EmptyState } from '../../../ui/empty'
import { RowMenu } from '../../../ui/row-menu'
import { ChevronRightIcon, PlusIcon, ProvidersIcon } from '../../../ui/icons'
import { ProviderCreateSheet } from '../../../features/library/provider-create-sheet'
import { confirmDialog } from '../../../ui/dialog-store'
import { toast } from '../../../ui/toast-store'
import { ApiError } from '../../../lib/rpc'
import { useDefaultProviderId } from '../../../lib/use-default-provider'

export function ProvidersPage() {
  const { llmProviders, removeLlmProvider } = useWorkspace()
  const { defaultProviderId } = useDefaultProviderId()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [sheetDefaultRole, setSheetDefaultRole] = useState<
    'chat' | 'embedding'
  >('chat')

  const hasChat = llmProviders.some((p) => p.role === 'chat')
  const hasEmbedding = llmProviders.some((p) => p.role === 'embedding')
  const missingRole: 'chat' | 'embedding' | null =
    llmProviders.length === 0
      ? null
      : !hasChat
        ? 'chat'
        : !hasEmbedding
          ? 'embedding'
          : null

  const openSheet = (defaultRole: 'chat' | 'embedding' = 'chat') => {
    setSheetDefaultRole(defaultRole)
    setSheetOpen(true)
  }

  const remove = async (id: string, label: string) => {
    if (
      !(await confirmDialog({
        title: `Delete provider "${label}"?`,
        body: 'Agents using it will lose their model assignment. This cannot be undone.',
        confirmLabel: 'Delete provider',
        destructive: true,
      }))
    ) {
      return
    }
    try {
      await removeLlmProvider(id)
      toast.success('Provider deleted')
    } catch (e) {
      toast.error(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Delete failed',
      )
    }
  }

  return (
    <div className="ab-page">
      <PageHeader
        title="LLM providers"
        subtitle="Connect Anthropic, OpenAI, or any OpenAI-compatible endpoint. Coding-helper agents need both a chat provider (answers each turn) and an embedding provider (powers code search)."
        actions={
          <Button
            variant="primary"
            leading={<PlusIcon strokeWidth={2.4} />}
            onClick={() => openSheet('chat')}
          >
            New provider
          </Button>
        }
      />

      {missingRole && (
        <div role="status" className="ab-alert ab-alert-warn">
          <span className="ab-alert-dot" aria-hidden="true" />
          <div className="ab-alert-body">
            <div className="ab-alert-title">
              {missingRole === 'chat'
                ? 'No chat provider yet'
                : 'No embedding provider yet'}
            </div>
            <div className="ab-alert-sub">
              {missingRole === 'chat'
                ? 'Agents need a chat provider to answer turns. Add one to wire your first agent up.'
                : 'Coding-helper agents need a workspace-wide embedding provider to search code. Without one, inspector tools fall back to keyword-only search.'}
            </div>
          </div>
          <Button variant="secondary" onClick={() => openSheet(missingRole)}>
            {missingRole === 'chat'
              ? 'Add chat provider'
              : 'Add embedding provider'}
          </Button>
        </div>
      )}

      {llmProviders.length === 0 ? (
        <EmptyState
          glyph={<ProvidersIcon />}
          title="No providers yet"
          body="Add a provider to give your agents a brain. Anthropic, OpenAI, and OpenAI-compatible endpoints are all supported. Coding-helper agents need both a chat provider and an embedding provider."
          action={
            <Button
              variant="primary"
              leading={<PlusIcon strokeWidth={2.4} />}
              onClick={() => openSheet('chat')}
            >
              Add your first provider
            </Button>
          }
        />
      ) : (
        <div className="ab-card ab-list-card">
          {llmProviders.map((p) => (
            <Link
              className="ab-list-row is-link"
              to={`/library/providers/${p.id}`}
              key={p.id}
            >
              <div className="ab-glyph ab-glyph-violet ab-glyph-sm">
                {p.label.charAt(0).toUpperCase()}
              </div>
              <div className="ab-list-row-head">
                <div className="ab-list-row-title">{p.label}</div>
                <div className="ab-list-row-sub">
                  <span className="ab-mono">{p.kind}</span>
                  {p.defaultModel && (
                    <>
                      {' · '}
                      <span className="ab-mono">{p.defaultModel}</span>
                    </>
                  )}
                </div>
              </div>
              <div className="ab-list-row-meta">
                {defaultProviderId === p.id && (
                  <Pill kind="accent">Default</Pill>
                )}
                <Pill kind={p.role === 'embedding' ? 'accent' : 'neutral'}>
                  {p.role === 'embedding' ? 'Embedding · workspace' : 'Chat'}
                </Pill>
                {!p.defaultModel && <Pill kind="warn">No model</Pill>}
                <Pill kind={p.apiKey.set ? 'success' : 'warn'}>
                  {p.apiKey.set ? 'Key set' : 'No key'}
                </Pill>
                <Pill kind="neutral">
                  {p.models?.models.length ?? 0} models
                </Pill>
                <RowMenu
                  items={[
                    {
                      label: 'Delete provider',
                      destructive: true,
                      onClick: () => void remove(p.id, p.label),
                    },
                  ]}
                />
                <span className="ab-row-affordance" aria-hidden="true">
                  <ChevronRightIcon />
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
      <ProviderCreateSheet
        open={sheetOpen}
        defaultRole={sheetDefaultRole}
        onClose={() => setSheetOpen(false)}
      />
    </div>
  )
}
