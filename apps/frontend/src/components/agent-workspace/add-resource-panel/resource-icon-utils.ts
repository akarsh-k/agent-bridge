import type { ToolKind } from '@agent-bridge/shared'

export type ResourceIconKind =
  | 'skill'
  | 'repo'
  | 'github'
  | 'llm'
  | 'mcp'
  | ToolKind

export function repoIconKind(remoteUrl: string): ResourceIconKind {
  return remoteUrl.toLowerCase().includes('github.com') ? 'github' : 'repo'
}
