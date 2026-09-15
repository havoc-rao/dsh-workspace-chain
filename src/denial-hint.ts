/**
 * Cross-workspace denial hint: when a filesystem mutation (`edit`/`write`)
 * is blocked by the file sandbox (`[sandbox: file access denied …]`) and the
 * target path lies inside ANOTHER registered workspace, attach a plugin
 * instruction to the tool result (`additionalContexts`). The agent loop
 * ferries it into the next request, so the model sees — in the same regular
 * injection form the workspace hints already use — that the denied edit can
 * be delegated to the owning workspace instead of forcing an escalation.
 *
 * The UI mirror lives in the client: the approval prompt for the escalated
 * retry renders an injected "path ownership" query (see
 * src/client/EscalationDelegation.tsx).
 */
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ResolvedConfig } from './config.js'
import { ownersFor, type OwnershipContext } from './ownership.js'
import { delegationAvailable } from './presentation.js'
import type {} from '@deepseek-ai/dsh-workspace'

/** The filesystem mutators whose sandbox denials carry the delegation hint. */
export const FS_MUTATORS: readonly string[] = ['edit', 'write']
/** Stable lead-in marking this hint family; used for result-level dedupe. */
export const DENIAL_HINT_MARK = 'workspace-chain:denial-delegate'

function textOf(content: readonly { type: string; text?: unknown }[]): string {
  return content.filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string).join('\n')
}

function filePathOf(args: unknown): string | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return undefined
  const value = (args as Record<string, unknown>).file_path
  return typeof value === 'string' && value.trim() ? value : undefined
}

export interface DenialHintInput {
  /** Wire tool name (`edit` / `write`, …). */
  name: string
  /** Parsed model arguments. */
  args: unknown
  /** Whether the call settled as an error. */
  isError: boolean
  /** The result's model-facing content. */
  content: readonly { type: string; text?: unknown }[]
  /** The calling agent's session id, when the call is agent-backed. */
  agentSessionId?: string
  /** Whether the delegation tool is reachable for the calling agent. */
  delegationAvailable: boolean
  /** Ownership facts (registry + targets + native availability). */
  ownership: OwnershipContext
  toolName: string
}

/** Compose the delegation tip for one denied mutation, or undefined when it does not apply. */
export function denialHintFor(input: DenialHintInput): string | undefined {
  if (!FS_MUTATORS.includes(input.name)) return undefined
  if (!input.isError) return undefined
  if (!textOf(input.content).includes('[sandbox: file access denied')) return undefined
  const path = filePathOf(input.args)
  if (path === undefined) return undefined
  const result = ownersFor(input.ownership, path, input.agentSessionId)
  const candidates = [...result.owners]
    .filter(owner => result.current === undefined || owner.root !== result.current.root)
    .sort((a, b) => b.root.length - a.root.length)
  const owner = candidates[0]
  if (owner === undefined) return undefined
  const reachable = input.delegationAvailable && owner.delegatable
  return `${DENIAL_HINT_MARK}\n编辑路径 ${JSON.stringify(result.path)} 已被文件沙箱拦截，且该路径位于当前会话之外的另一个已登记工作区：工作区 ${JSON.stringify(owner.name)}（${owner.root}）。当前工作区没有此路径的写入权限。`
    + (reachable
      ? ` 可将此编辑任务委派给该工作区：调用 ${input.toolName}(target=..., task=该编辑的完整内容与验收标准) 由目标工作区的新会话执行，或继续申请提权等待用户审批。`
      : ' 可将此编辑任务交给该工作区的新会话处理，或继续申请提权等待用户审批。')
}

/** Mount the post-execute listener; the host context owns fs tools for every agent. */
export function mountDenialHints(ctx: Context, config: ResolvedConfig): void {
  ctx.on('tools/post-execute', async (exec: ToolExecution, result: Readonly<ToolExecutionResult>, next: () => Promise<PostToolDecision>): Promise<PostToolDecision> => {
    const decision = await next()
    if (exec.agent === undefined) return decision
    const hint = denialHintFor({
      name: exec.name,
      args: exec.arguments,
      isError: result.isError,
      content: result.content,
      agentSessionId: exec.agent.id,
      delegationAvailable: delegationAvailable(ctx, exec.agent, config),
      ownership: {
        config,
        workspaces: ctx.get('workspaceRegistry')?.list() ?? [],
        nativeAvailable: ctx.get('sessionController') !== undefined,
      },
      toolName: config.toolName,
    })
    if (hint === undefined) return decision
    const already = decision.additionalContexts?.some(message =>
      message.source.kind === 'plugin' && message.source.plugin === 'workspace-chain'
      && message.content.some(block => block.type === 'text' && block.text.includes(DENIAL_HINT_MARK)))
    if (already) return decision
    return { ...decision, additionalContexts: [...decision.additionalContexts ?? [], createUserMessage({ content: [{ type: 'text', text: hint }], source: { kind: 'plugin', plugin: 'workspace-chain', form: 'instructions' } })] }
  })
}