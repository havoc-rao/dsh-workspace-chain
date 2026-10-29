import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Read every selected catalog before resolving, so a failed catalog cannot hide ambiguity. */
async function delegationCatalog(ctx: Context, providerId?: string) {
  const providers = ctx.llm.listProviders()
  const selected = providerId === undefined ? providers : providers.filter(provider => provider.id === providerId)
  if (providerId !== undefined && selected.length === 0) {
    throw new Error(`Unknown provider_id ${JSON.stringify(providerId)}. Use list_workspace_models to discover provider IDs.`)
  }
  return Promise.all(selected.map(async provider => {
    try {
      const models = await ctx.llm.listModels(provider.id)
      return { id: provider.id, name: provider.name, models: models.map(model => ({ id: model.id, name: model.name })) }
    } catch (cause) {
      throw new Error(`Cannot list models for provider ${JSON.stringify(provider.id)}: ${String(cause)}`, { cause })
    }
  }))
}

/** Resolve only an exact advertised model ID, never a display name or a guessed alias. */
export async function resolveDelegationModel(ctx: Context, modelId: string, providerId?: string): Promise<{ provider: string; model: string }> {
  const catalog = await delegationCatalog(ctx, providerId)
  const matches = catalog.filter(provider => provider.models.some(model => model.id === modelId))
  if (matches.length === 0) {
    throw new Error(`Unknown model_id ${JSON.stringify(modelId)}${providerId === undefined ? '' : ` for provider ${JSON.stringify(providerId)}`}. Use list_workspace_models to discover exact model IDs.`)
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous model_id ${JSON.stringify(modelId)}: available from providers ${matches.map(provider => JSON.stringify(provider.id)).join(', ')}. Pass provider_id to disambiguate.`)
  }
  return { provider: matches[0]!.id, model: modelId }
}

export function createDelegationModelsTool(ctx: Context) {
  return defineTool({
    name: 'list_workspace_models',
    description: 'Discover registered provider IDs and their advertised model IDs before passing model_id and optional provider_id to delegate_workspace. Model IDs must match exactly; when multiple providers advertise the same model ID, pass provider_id to disambiguate. Returns a plain-text JSON list of providers and models.',
    parameters: {
      provider_id: { type: 'string', description: 'Optional exact provider ID; restrict discovery to this registered provider.' },
    },
    // Installed defineTool requires an output contract, even for plain text.
    output: {
      schema: { type: 'string' },
      render: (_args, text) => [{ type: 'text', text }],
    },
    async execute({ provider_id }) {
      return JSON.stringify(await delegationCatalog(ctx, provider_id), null, 2)
    },
  })
}
