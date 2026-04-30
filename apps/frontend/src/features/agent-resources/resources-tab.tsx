/**
 * Resources tab — everything the agent USES: attached repos, MCP
 * connections, skills, and native tools. Composes the existing
 * ResourcesPanel (repos / MCPs / skills + edges + sheets) with
 * ToolsTab (native tool definitions). Lives at /agents/:id/resources.
 */

import { ResourcesPanel } from '../agent-builder/resources-panel'
import { ToolsTab } from '../agent-tools/tools-tab'

export function ResourcesTab({ agentId }: { agentId: string }) {
  return (
    <div>
      <ResourcesPanel agentId={agentId} />
      <ToolsTab agentId={agentId} />
    </div>
  )
}
