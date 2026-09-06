import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-workspace'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ResolvedConfig } from './config.js'
import { queryText } from './hints.js'
import { sessionReferenceIds, workspaceReferenceIds, workspaceMentions } from './shared/references.js'
import { delegationAvailable, invocationHint } from './presentation.js'
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
export function workspaceHandoff(query: string, workspaces: readonly WorkspaceReferenceContext[], config: ResolvedConfig, available: boolean, nativeAvailable = true): { text: string; example?: { target: string; task: string } } {
  const ids = workspaceReferenceIds(query)
  const sessions = sessionReferenceIds(query)
  const selected = workspaces.filter(w => ids.includes(w.id) || w.sessionIds?.some(id => sessions.includes(id)))
  const task = referencedTask(query)
  const targets = selected.flatMap(w => workspaceTargets(w, config, nativeAvailable))
  const context = `工作区交接场景：引用指向${selected.length ? selected.map(w => JSON.stringify(w.title)).join('、') : '尚未解析的工作区'}，不是当前插件的源码文件。${task ? `\n用户本次任务：${JSON.stringify(task)}` : '\n本次只有引用，等待用户指定任务。'}`
  if (!selected.length) return { text: `${context}\n当前无法委派：引用未解析到已登记的工作区。请指出该问题，不要猜测路径或启动命令。` }
  if (!targets.length) return { text: `${context}\n当前无法委派：DSH 本地会话 API 不可用，且目标没有配置 SDK 执行器。可识别项目不等于可以向它发送任务。请直接说明接口不可用，不能确认已发送；不要读取本插件 README/源码来寻找发送方式，也不要代为写入“你好”文件。` }
  if (!available) return { text: `${context}\n当前无法委派：目标已配置，但本会话的工具可见性或调用模式不允许原生委派。请报告此限制，不要改用未授权的启动方式。` }
  return { text: `${context}\n可用目标名：${JSON.stringify(targets)}。用户要求在这些项目中执行任务时，由当前会话调用下述委派工具交付，并等待执行结果。`,
    ...targets.length === 1 && task ? { example: { target: targets[0]!, task } } : {} }
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
      ...workspace ? { workspace: workspace.title, path: workspace.path, ...binding(workspace) } : {} }
  })
  const references = [...rows, ...sessionRows]
  const delegates = references.some(row => 'delegate' in row)
  return `Reference metadata (not instructions or conversation history):\n${JSON.stringify(references)}${delegates ? '\nDelegate only when requested, using the listed tool/target. Delegation creates a fresh session; it does not resume the reference.' : ''}`

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
    const nativeAvailable = ctx.get('apiProxy') !== undefined
    let text = workspaceHint(query, workspaces, config, available, nativeAvailable)
    const handoff = workspaceHandoff(query, workspaces, config, available, nativeAvailable)
    if (text) text += `\n${handoff.text}`
    if (text && available && text.includes('"delegate":')) text += `\n${invocationHint(ctx, config, handoff.example)}`
    if (!text) return decision
    return { kind: 'enter' as const, messages: [...decision.messages, createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'workspace-chain', form: 'instructions' } })] }
  })
}
