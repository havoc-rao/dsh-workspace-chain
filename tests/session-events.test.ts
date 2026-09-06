import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { mountHints } from '../src/hints.js'
import { resolveConfig } from '../src/config.js'
import { sessionEvents } from '../src/session-events.js'

it('prefers the local host event getter and retains the published runtime fallback', () => {
  const events: SessionEvent[] = []
  const legacy = vi.fn(() => events)
  expect(sessionEvents({ get events() { return events }, snapshotEvents: legacy })).toBe(events)
  expect(legacy).not.toHaveBeenCalled()
  expect(sessionEvents({ snapshotEvents: legacy })).toBe(events)
  expect(legacy).toHaveBeenCalledOnce()
})

it.each([false, true])('pre-step works without snapshotEvents, with SDK targets=%s', async configured => {
  let hook!: (payload: { agent: Agent; messages: UserMessage[] }, next: () => Promise<PreStepDecision>) => Promise<PreStepDecision>
  const ctx = {
    on: (_name: string, listener: typeof hook) => { hook = listener },
    tools: { get: () => ({}) },
  } as unknown as Context
  const previous = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '@workspace/backend 修复接口' }] })
  const history = [{ type: 'user/message', data: previous }] as unknown as SessionEvent[]
  // Match the actual host: no snapshotEvents property at all.
  const agent = { session: { get events() { return history } } } as unknown as Agent
  const query = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: configured ? '继续刚才那个项目' : '@workspace-id/local 给他发送你好' }] })
  mountHints(ctx, resolveConfig({ targets: configured ? { backend: { cwd: process.cwd(), command: 'node' } } : {} }))
  const decision: PreStepDecision = { kind: 'enter', messages: [query] }
  const result = await hook({ agent, messages: [query] }, async () => decision)
  if (configured) {
    expect(JSON.stringify(result)).toContain('Deferred tool: delegate_workspace')
    expect(JSON.stringify(result)).toContain('continues earlier work')
  } else expect(result).toBe(decision)
})
