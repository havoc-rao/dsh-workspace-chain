import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'

// rc hosts intentionally no longer export the legacy SDK renderers.
vi.mock('@deepseek-ai/dsh-tools', () => ({ renderToolsSdk: undefined, renderToolsSdkPy: undefined }))

import { mountPresentation, delegationAvailable } from '../src/presentation.js'
import { resolveConfig } from '../src/config.js'

it('keeps provider-owned declarations untouched on rc hosts without assembly.tools', async () => {
  const on = vi.fn()
  const ctx = { on, tools: { get: () => ({}) } } as unknown as Context
  const config = resolveConfig({})
  mountPresentation(ctx, config)
  const listener = on.mock.calls[0]![1]
  const scope = {} as never
  const assembly = { sections: [], contexts: [], variables: {} }
  expect(await listener({}, { scope }, async () => assembly)).toBe(assembly)
  expect(delegationAvailable(ctx, scope, config)).toBe(true)
  const ptc = { ...assembly, sections: [{ name: 'tools:ptc-only', text: 'PTC only' }] }
  expect(await listener({}, { scope }, async () => ptc)).toBe(ptc)
  expect(delegationAvailable(ctx, scope, config)).toBe(false)
  await listener({}, { scope }, async () => assembly)
  expect(delegationAvailable(ctx, scope, config)).toBe(true)
})

it('rejects unsupported deferred declarations rather than silently changing visibility', () => {
  const on = vi.fn()
  expect(() => mountPresentation({ on } as unknown as Context, resolveConfig({ visibleTools: false })))
    .toThrow('visibleTools: false requires the legacy DSH presentation API')
  expect(on).not.toHaveBeenCalled()
})
