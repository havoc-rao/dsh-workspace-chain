import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { createDelegationModelsTool, resolveDelegationModel } from '../src/model-selection.js'

function fixture(catalog: Record<string, { id: string; name: string }[]> = {
  alpha: [{ id: 'unique-model', name: 'Unique Model' }, { id: 'shared-model', name: 'Shared Model' }],
  beta: [{ id: 'shared-model', name: 'Shared Model' }],
}) {
  const listProviders = vi.fn(() => Object.keys(catalog).map(id => ({ id, name: `Provider ${id}` })))
  const listModels = vi.fn(async (provider: string) => catalog[provider]!.map(model => ({ ...model, provider })))
  const ctx = { llm: { listProviders, listModels } } as unknown as Context
  const exec = {} as ToolRunContext
  return { ctx, exec, listProviders, listModels }
}

describe('resolveDelegationModel', () => {
  it('resolves a unique exact model ID after inspecting all providers', async () => {
    const f = fixture()
    await expect(resolveDelegationModel(f.ctx, 'unique-model')).resolves.toEqual({ provider: 'alpha', model: 'unique-model' })
    expect(f.listProviders).toHaveBeenCalledOnce()
    expect(f.listModels.mock.calls).toEqual([['alpha'], ['beta']])
  })

  it.each(['missing', 'Unique Model', 'UNIQUE-MODEL', 'unique', ' unique-model '])('rejects unknown IDs and non-exact match %s', async model => {
    await expect(resolveDelegationModel(fixture().ctx, model)).rejects.toThrow('Unknown model_id')
  })

  it('rejects a model ID advertised by multiple providers with disambiguation guidance', async () => {
    await expect(resolveDelegationModel(fixture().ctx, 'shared-model')).rejects.toThrow(/Ambiguous.*alpha.*beta.*provider_id/)
  })

  it('disambiguates using only the requested provider catalog', async () => {
    const f = fixture()
    await expect(resolveDelegationModel(f.ctx, 'shared-model', 'beta')).resolves.toEqual({ provider: 'beta', model: 'shared-model' })
    expect(f.listModels.mock.calls).toEqual([['beta']])
  })

  it('does not fall back to another provider when the selected provider lacks the model', async () => {
    const f = fixture()
    await expect(resolveDelegationModel(f.ctx, 'unique-model', 'beta')).rejects.toThrow('Unknown model_id')
    expect(f.listModels.mock.calls).toEqual([['beta']])
  })

  it.each(['missing', 'Provider alpha', ''])('rejects an unknown exact provider filter %s', async provider => {
    const f = fixture()
    await expect(resolveDelegationModel(f.ctx, 'unique-model', provider)).rejects.toThrow('Unknown provider_id')
    expect(f.listModels).not.toHaveBeenCalled()
  })

  it('rejects an empty provider catalog', async () => {
    await expect(resolveDelegationModel(fixture({}).ctx, 'missing')).rejects.toThrow('Unknown model_id')
  })

  it('fails closed if another provider errors rather than selecting a partial unique match', async () => {
    const f = fixture()
    f.listModels.mockImplementation(async provider => {
      if (provider === 'beta') throw new Error('catalog offline')
      return [{ provider, id: 'unique-model', name: 'Unique Model' }]
    })
    await expect(resolveDelegationModel(f.ctx, 'unique-model')).rejects.toThrow(/provider "beta".*catalog offline/)
    await expect(resolveDelegationModel(f.ctx, 'unique-model', 'alpha')).resolves.toEqual({ provider: 'alpha', model: 'unique-model' })
  })

  it('propagates selected provider errors with the original cause', async () => {
    const f = fixture()
    const cause = new Error('provider failed')
    f.listModels.mockRejectedValue(cause)
    await expect(resolveDelegationModel(f.ctx, 'shared-model', 'beta')).rejects.toMatchObject({ cause })
  })

  it('propagates provider enumeration errors', async () => {
    const f = fixture()
    f.listProviders.mockImplementation(() => { throw new Error('registry failed') })
    await expect(resolveDelegationModel(f.ctx, 'unique-model')).rejects.toThrow('registry failed')
    expect(f.listModels).not.toHaveBeenCalled()
  })
})

describe('list_workspace_models', () => {
  it('defines a discovery tool with an optional provider filter and no custom output schema', async () => {
    const f = fixture()
    const tool = createDelegationModelsTool(f.ctx)
    expect(tool.name).toBe('list_workspace_models')
    expect(tool.description).toMatch(/before passing model_id.*provider_id.*delegate_workspace/)
    expect(tool.parameters).toMatchObject({ properties: { provider_id: { type: 'string' } } })
    expect(tool.parameters.required ?? []).not.toContain('provider_id')
    expect(tool.output?.schema).toEqual({ type: 'string' })
    const result = await tool.execute({}, f.exec)
    expect(typeof result).toBe('string')
    expect(JSON.parse(result as string)).toEqual([
      { id: 'alpha', name: 'Provider alpha', models: [{ id: 'unique-model', name: 'Unique Model' }, { id: 'shared-model', name: 'Shared Model' }] },
      { id: 'beta', name: 'Provider beta', models: [{ id: 'shared-model', name: 'Shared Model' }] },
    ])
  })

  it('filters discovery by exact provider ID', async () => {
    const f = fixture()
    const result = await createDelegationModelsTool(f.ctx).execute({ provider_id: 'beta' }, f.exec)
    expect(JSON.parse(result as string)).toEqual([{ id: 'beta', name: 'Provider beta', models: [{ id: 'shared-model', name: 'Shared Model' }] }])
    expect(f.listModels.mock.calls).toEqual([['beta']])
  })

  it('rejects unknown providers', async () => {
    const f = fixture()
    await expect(createDelegationModelsTool(f.ctx).execute({ provider_id: 'missing' }, f.exec)).rejects.toThrow('Unknown provider_id')
    expect(f.listModels).not.toHaveBeenCalled()
  })

  it('does not return a partial catalog on provider failure', async () => {
    const f = fixture()
    f.listModels.mockRejectedValueOnce(new Error('catalog failed'))
    await expect(createDelegationModelsTool(f.ctx).execute({}, f.exec)).rejects.toThrow('catalog failed')
  })

  it('returns an empty JSON list when no providers are registered', async () => {
    const f = fixture({})
    await expect(createDelegationModelsTool(f.ctx).execute({}, f.exec)).resolves.toBe('[]')
  })
})
