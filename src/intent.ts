import type { TargetSummary } from './shared/catalog.js'
import { mention } from './shared/catalog.js'

export interface WorkspaceIntent { targets: string[]; inherited: boolean; unknown: string[] }
function matches(text: string, name: string): boolean {
  if (/[\p{Script=Han}]/u.test(name)) return text.includes(name)
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(text)
}
/** Only caller-authored queries are passed here; tool results cannot forge UI selection. */
export function identifyIntent(query: string, previousQueries: readonly string[], catalog: readonly TargetSummary[]): WorkspaceIntent {
  // Native session wire labels are history metadata, not SDK names/aliases or
  // continuation requests. Do not let a quoted title select a workspace.
  query = query.replace(/@\[((?:\\.|[^\\\]])*)\]\(dsh-session:[A-Za-z0-9_-]+\)/gu, '')
    .replace(/dsh-session:[A-Za-z0-9_-]+/gu, '')
  const explicit = [...query.matchAll(/@workspace\/([^\s<>"'`]+)/g)].flatMap(match => {
    try { return [decodeURIComponent(match[1]!)] } catch { return [match[1]!] }
  })
  const known = new Set(catalog.map(t => t.name))
  const selected = catalog.filter(t => explicit.includes(t.name) || matches(query, t.name) || t.aliases.some(alias => matches(query, alias))).map(t => t.name)
  const unknown = explicit.filter(name => !known.has(name))
  if (selected.length || unknown.length) return { targets: selected, inherited: false, unknown }
  // Carry context only for an explicit continuation, never for an unrelated new query.
  if (/(继续|接着|上一个|刚才|那个项目|该项目|continue|go\s*on|same (?:project|workspace)|that (?:project|workspace))/iu.test(query)) {
    for (const previous of previousQueries.slice(-6).reverse()) {
      const found = identifyIntent(previous, [], catalog)
      if (found.targets.length) return { ...found, inherited: true }
    }
  }
  return { targets: [], inherited: false, unknown: [] }
}
export function intentHint(intent: WorkspaceIntent, toolName: string): string {
  if (intent.unknown.length) return `Unconfigured workspace references: ${intent.unknown.map(mention).join(', ')}. Ask the user to choose a configured target; do not guess a path or command.`
  return `Workspace-chain hint: ${intent.inherited ? 'The current query continues earlier work involving' : 'The current query references'} ${intent.targets.map(mention).join(', ')}. Interpret the current request together with the prior conversation and the targets' responsibilities. A workspace mention selects context; delegate only when the user requests work there. When delegating, call ${toolName} with a standalone task including relevant upstream results, files and acceptance criteria. After receiving the result, inspect its completion status, integrate it with your own work, and answer the original request. Collect background jobs with job_output before claiming completion. Do not automatically delegate the returned result again.`
}
