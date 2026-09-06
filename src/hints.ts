import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { ResolvedConfig } from './config.js'
import { identifyIntent, intentHint } from './intent.js'
import { delegationAvailable, invocationHint } from './presentation.js'
import { sessionEvents } from './session-events.js'
export function queryText(message: UserMessage): string {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}
export function mountHints(ctx: Context, config: ResolvedConfig): void {
  const catalog = [...config.targets].map(([name, t]) => ({ name, purpose: t.purpose ?? '', aliases: t.aliases ?? [] }))
  ctx.on('agent/pre-step', async ({ agent, messages }, next): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || !delegationAvailable(ctx, agent, config)) return decision
    const queries = messages.filter(m => m.source.kind === 'user')
    if (!queries.length) return decision
    const ids = new Set(queries.map(m => m.id))
    const previous = sessionEvents(agent.session).flatMap(event => event.type === 'user/message' && event.data.source.kind === 'user' && !ids.has(event.data.id) ? [queryText(event.data)] : [])
    const intent = identifyIntent(queries.map(queryText).join('\n'), previous, catalog)
    if (!intent.targets.length && !intent.unknown.length) return decision
    const hint = createUserMessage({ content: [{ type: 'text', text: intentHint(intent, config.toolName) + (intent.targets.length ? `\n${invocationHint(ctx, config)}` : '') }], source: { kind: 'plugin', plugin: 'workspace-chain', form: 'instructions' } })
    return { kind: 'enter', messages: [...decision.messages, hint] }
  })
}
