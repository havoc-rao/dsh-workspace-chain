import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PostToolDecision } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from '../src/config.js'
import { DENIAL_HINT_MARK, denialHintFor, mountDenialHints, type DenialHintInput } from '../src/denial-hint.js'
import type { OwnerWorkspace } from '../src/ownership.js'
import type { ResolvedConfig } from '../src/config.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function base(): Promise<{ a: string; b: string; config: ResolvedConfig }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'chain-denial-')))
  roots.push(root)
  const a = join(root, 'workspace-a'); await mkdir(a)
  const b = join(root, 'workspace-b'); await mkdir(b)
  const config = resolveConfig({ targets: {} })
  return { a, b, config }
}
const owner = (id: string, title: string, path: string, sessionIds: string[] = []): OwnerWorkspace => ({ id, title, path, sessionIds })
const denied = (name = 'edit') => ({
  name,
  args: { file_path: '/tmp/lost/file.ts' },
  isError: true,
  content: [{ type: 'text' as const, text: '[sandbox: file access denied under workspace-write mode]\n[sandbox: escalation available — retry this exact operation once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]' }],
  agentSessionId: 'session-a',
  delegationAvailable: true,
  toolName: 'delegate_workspace',
})

describe('denialHintFor', () => {
  it('hints delegation when the denied path belongs to another registered workspace', async () => {
    const { a, b, config } = await base()
    const hint = denialHintFor({
      ...denied(),
      args: { file_path: join(b, 'src', 'x.ts') },
      ownership: { config, workspaces: [owner('wa', 'A', a, ['session-a']), owner('wb', 'B', b)], nativeAvailable: true },
    })
    expect(hint).toContain(DENIAL_HINT_MARK)
    expect(hint).toContain('工作区 "B"')
    expect(hint).toContain('delegate_workspace')
    expect(hint).not.toContain('工作区 "A"')
  })
  it('stays silent for the current workspace, read tools, successes, and non-denial errors', async () => {
    const { a, config } = await base()
    const ownership = { config, workspaces: [owner('wa', 'A', a, ['session-a'])], nativeAvailable: true }
    expect(denialHintFor({ ...denied('edit'), args: { file_path: join(a, 'x.ts') }, ownership })).toBeUndefined()
    expect(denialHintFor({ ...denied('read'), ownership })).toBeUndefined()
    expect(denialHintFor({ ...denied(), isError: false, ownership })).toBeUndefined()
    expect(denialHintFor({ ...denied(), content: [{ type: 'text' as const, text: 'something else failed' }], ownership })).toBeUndefined()
    expect(denialHintFor({ ...denied(), args: { other: 1 }, ownership })).toBeUndefined()
  })
  it('drops the tool-name guidance when delegation is unreachable or the owner cannot be delegated to', async () => {
    const { a, b, config } = await base()
    const ownership = { config, workspaces: [owner('wa', 'A', a, ['session-a']), owner('wb', 'B', b)], nativeAvailable: false }
    const withoutTool = denialHintFor({ ...denied(), args: { file_path: join(b, 'src', 'x.ts') }, delegationAvailable: false, ownership })
    expect(withoutTool).toContain('工作区 "B"')
    expect(withoutTool).not.toContain('delegate_workspace')
    const unowned = denialHintFor({ ...denied(), args: { file_path: join(b, 'src', 'x.ts') }, ownership })
    expect(unowned).not.toContain('delegate_workspace')
  })
})

describe('mountDenialHints', () => {
  const capture = (workspaces: OwnerWorkspace[] = []) => {
    const events: Record<string, (...args: unknown[]) => unknown> = {}
    const ctx = {
      on: (name: string, cb: (...args: unknown[]) => unknown) => { events[name] = cb },
      get: (name: string) => name === 'sessionController' ? {} : name === 'workspaceRegistry' ? { list: () => workspaces } : undefined,
      tools: { get: () => ({}) },
    } as unknown as Context
    return { events, ctx }
  }
  it('attaches the plugin instruction to the denied mutation result', async () => {
    const { a, b, config } = await base()
    const { events, ctx } = capture([owner('wa', 'A', a, ['session-a']), owner('wb', 'B', b)])
    mountDenialHints(ctx, config)
    const handler = events['tools/post-execute']!
    const next = vi.fn(async (): Promise<PostToolDecision> => ({ kind: 'accept' }))
    const decision = await handler(
      { name: 'edit', arguments: { file_path: join(b, 'src', 'x.ts') }, agent: { id: 'session-a' } },
      { isError: true, content: [{ type: 'text', text: '[sandbox: file access denied under workspace-write mode]' }] },
      next,
    ) as PostToolDecision
    expect(next).toHaveBeenCalledTimes(1)
    expect(decision.additionalContexts?.[0]?.source).toMatchObject({ kind: 'workspace-chain', plugin: 'workspace-chain', form: 'instructions' })
    const text = decision.additionalContexts![0]!.content.filter(b => b.type === 'text').map(b => b.text).join('')
    expect(text).toContain('工作区 "B"')
    expect(text).toContain('delegate_workspace')
  })
  it('does not duplicate an existing workspace-chain hint on the same result', async () => {
    const { a, b, config } = await base()
    const { events, ctx } = capture([owner('wa', 'A', a, ['session-a']), owner('wb', 'B', b), owner('wc', 'C', join(a, '..', 'workspace-c'))])
    mountDenialHints(ctx, config)
    const handler = events['tools/post-execute']!
    const existing = createUserMessage({ content: [{ type: 'text', text: `${DENIAL_HINT_MARK}\nalready there` }], source: { kind: 'workspace-chain', plugin: 'workspace-chain', form: 'instructions' } })
    const next = vi.fn(async (): Promise<PostToolDecision> => ({ kind: 'accept', additionalContexts: [existing] }))
    const decision = await handler(
      { name: 'write', arguments: { file_path: join(b, 'src', 'x.ts') }, agent: { id: 'session-a' } },
      { isError: true, content: [{ type: 'text', text: '[sandbox: file access denied under workspace-write mode]' }] },
      next,
    ) as PostToolDecision
    expect(decision.additionalContexts).toEqual([existing])
  })
  it('passes the decision through unchanged for unrelated calls', async () => {
    const { config } = await base()
    const { events, ctx } = capture()
    mountDenialHints(ctx, config)
    const handler = events['tools/post-execute']!
    const next = vi.fn(async (): Promise<PostToolDecision> => ({ kind: 'accept' }))
    const decision = await handler(
      { name: 'read', arguments: { file_path: '/tmp/lost/file.ts' }, agent: { id: 'session-a' } },
      { isError: false, content: [{ type: 'text', text: 'ok' }] },
      next,
    ) as PostToolDecision
    expect(decision).toEqual({ kind: 'accept' })
  })
})