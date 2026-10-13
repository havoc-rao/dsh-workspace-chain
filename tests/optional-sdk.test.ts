import type { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'

// Model the real Loader failure on newer hosts: the legacy SDK provider imports
// resolveChildCwd from a subagent package which no longer exports it.
vi.mock('@deepseek-ai/dsh-subagent-dsh-sdk', () => {
  throw new SyntaxError("The requested module '@deepseek-ai/dsh-subagent' does not provide an export named 'resolveChildCwd'")
})

afterEach(() => vi.resetModules())

function fixture() {
  const register = vi.fn()
  const plugin = vi.fn()
  const ctx = { on: vi.fn(), inject: vi.fn(), tools: { register }, plugin } as unknown as Context
  return { ctx, register, plugin }
}

it('imports and registers local delegation without loading an incompatible SDK backend', async () => {
  const chain = await import('../src/index.js')
  const { ctx, register, plugin } = fixture()
  await chain.apply(ctx, { targets: {} })
  expect(register).toHaveBeenCalledOnce()
  expect(register.mock.calls[0]![0].name).toBe('delegate_workspace')
  expect(plugin).not.toHaveBeenCalled()
})

it('does not silently replace a configured SDK backend when its import fails', async () => {
  const chain = await import('../src/index.js')
  const { ctx, register, plugin } = fixture()
  // Vitest wraps a throwing module factory; its cause retains the actual
  // module-linking failure which must still reject activation.
  await expect(chain.apply(ctx, { targets: { sdk: { cwd: process.cwd() } } })).rejects.toMatchObject({
    cause: expect.objectContaining({ message: expect.stringContaining('resolveChildCwd') }),
  })
  expect(register).not.toHaveBeenCalled()
  expect(plugin).not.toHaveBeenCalled()
})
