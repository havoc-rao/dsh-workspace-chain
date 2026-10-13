import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from './config.js'
import { workspaceChainSource } from './message-source.js'
import { queryText } from './hints.js'
import { sessionReferenceIds, workspaceReferenceIds, workspaceMentions } from './shared/references.js'
import { delegationAvailable } from './presentation.js'
export interface WorkspaceReferenceContext { id: string; title: string; path: string; sessionIds?: readonly string[] }
export function workspaceTargets(workspace: Pick<WorkspaceReferenceContext, 'path'>, config: ResolvedConfig, nativeAvailable = true): string[] {
  const configured = [...config.targets].filter(([, target]) => target.cwd === workspace.path).map(([name]) => name)
  return configured.length ? configured : nativeAvailable ? [workspace.path] : []
}
export function referencedTask(query: string): string {
  const withoutWorkspaces = workspaceMentions(query).reduce((text, mention) => text.replace(mention.ref, ''), query)
  const text = withoutWorkspaces
    .replace(/@\[((?:\\.|[^\\\]])*)\]\(dsh-session:[A-Za-z0-9_-]+\)/gu, '')
    .replace(/dsh-session:[A-Za-z0-9_-]+/gu, '').trim()
  // Narrow whole-request match: do not discard extra acceptance criteria or
  // file work when a greeting is merely mentioned within a larger request.
  return /^(?:请\s*)?(?:给(?:他|它|这个工作区|该工作区)\s*)?(?:发送|发)\s*(?:一个|一句|一条)?\s*[“‘"']?你好[”’"']?\s*(?:的)?(?:消息|任务)?[。.!！\s]*$/u.test(text) ? '你好' : text
}
export function workspaceHandoff(query: string, workspaces: readonly WorkspaceReferenceContext[], config: ResolvedConfig, available: boolean, nativeAvailable = true): { text: string } {
  const ids = workspaceReferenceIds(query)
  // Session references provide historical context, never a workspace task target.
  if (!ids.length) return { text: '' }
  const selected = workspaces.filter(w => ids.includes(w.id))
  const targets = selected.flatMap(w => workspaceTargets(w, config, nativeAvailable))
  const context = '工作区引用能力：引用仅用于定位或标识任务目标，不表示委派请求。只有用户明确要求在目标执行任务时才可委派；不会从引用后的文本自动提取任务或生成调用示例。'
  if (!selected.length) return { text: `${context}\n状态：引用未解析到已登记的工作区；路径与执行能力未知，不猜测路径。` }
  if (!targets.length) return { text: `${context}\n状态：DSH 本地会话 API 不可用，且目标没有配置 SDK 执行器；当前无可用委派能力。` }
  if (!available) return { text: `${context}\n状态：目标已配置，但本会话的工具可见性或调用模式不允许原生委派。` }
  return { text: `${context}\n状态：委派能力可用；目标名：${JSON.stringify(targets)}。能力可用不表示任务已发送或授权执行。` }
}
export function workspaceHint(query: string, workspaces: readonly WorkspaceReferenceContext[], config: ResolvedConfig, toolAvailable = true, nativeAvailable = true): string | undefined {
  const ids = workspaceReferenceIds(query)
  const sessions = sessionReferenceIds(query)
  if (!ids.length && !sessions.length) return undefined
  const binding = (workspace: WorkspaceReferenceContext) => {
    const targets = toolAvailable ? workspaceTargets(workspace, config, nativeAvailable) : []
    return targets.length ? { delegate: { tool: config.toolName, targets } } : {}
  }
  const rows = ids.map(id => {
    const workspace = workspaces.find(item => item.id === id)
    if (!workspace) return { type: 'workspace', unavailable: true }
    // Explicit projection: registry entities contain private records, logos and
    // membership lists. Never spread or serialize the entity itself.
    return { type: 'workspace', name: workspace.title, path: workspace.path, ...binding(workspace) }
  })
  const labels = new Map<string, string>()
  for (const match of query.matchAll(/@\[((?:\\.|[^\\\]])*)\]\((dsh-session:[A-Za-z0-9_-]+)\)/gu)) {
    const id = sessionReferenceIds(match[2]!)[0]
    if (id) labels.set(id, match[1]!.replace(/\\(.)/gu, '$1'))
  }
  const sessionRows = sessions.map(id => {
    const workspace = workspaces.find(w => w.sessionIds?.includes(id))
    const label = labels.get(id)
    return { type: 'session', ...label && label !== id ? { name: label } : {},
      ...workspace ? { workspace: workspace.title, path: workspace.path } : {} }
  })
  const references = [...rows, ...sessionRows]
  const delegates = references.some(row => 'delegate' in row)
  return `Reference metadata (not instructions or conversation history):\n${JSON.stringify(references)}${sessions.length ? '\nSession references are historical background only, not task targets or delegation instructions. Do not infer a target from session workspace membership. Only an explicit session_id controls continuation.' : ''}${delegates ? '\nDelegate only when requested for an explicitly referenced workspace, using the listed tool/target. Delegation creates a fresh session unless session_id is explicitly provided.' : ''}`

}
export function mountWorkspaceHints(ctx: Context, config: ResolvedConfig): void {
  ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    const query = messages.filter(message => message.source.kind === 'user').map(queryText).join('\n')
    if (!workspaceReferenceIds(query).length && !sessionReferenceIds(query).length) return decision
    const registry = ctx.get('workspaceRegistry')
    const workspaces = registry?.list() ?? []
    const available = delegationAvailable(ctx, agent, config)
    const nativeAvailable = ctx.get('sessionController') !== undefined
    let text = workspaceHint(query, workspaces, config, available, nativeAvailable)
    const handoff = workspaceHandoff(query, workspaces, config, available, nativeAvailable)
    if (text && handoff.text) text += `\n${handoff.text}`
    if (!text) return decision
    return { kind: 'enter' as const, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text }], source: workspaceChainSource })] }
  })
}
