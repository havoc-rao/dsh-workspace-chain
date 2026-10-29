import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { resolveConfig, type Config } from './config.js'
import { createDelegationTool } from './tool.js'
import { createDelegationModelsTool } from './model-selection.js'
import { mountHints } from './hints.js'
import { mountCatalog } from './catalog.js'
import { mountDenialHints } from './denial-hint.js'
import { mountWorkspaceHints } from './workspace-hints.js'
import { mountPresentation } from './presentation.js'
export { Config } from './config.js'
export { classifyDelegation, composeTask, newDelegationId, writeDelegationRecord, appendProgress, progressSummary, finalizeRecord }
  from './delegation-record.js'
export type { DelegationRecord, DelegationStatus, DelegationMode, DelegationDiagnostic, ClassificationInput } from './delegation-record.js'
export { DelegationFailure } from './tool.js'
export const name = 'workspace-chain'
// Model discovery and explicit delegation routing share the host LLM registry.
// A type-only import does not grant access to this Cordis service at runtime.
export const inject = ['agents', 'tools', 'subagents', 'systemPrompt', 'llm']
export async function apply(ctx: Context, input: Config): Promise<void> {
  const config = resolveConfig(input)
  mountCatalog(ctx, config)
  if (config.promptEnabled) mountWorkspaceHints(ctx, config)
  // Local workspace delegation must not load the optional SDK backend: its
  // version-specific subagent imports can fail before this plugin registers
  // any tools on a newer host, even when no SDK targets are configured.
  const SdkProvider = config.targets.size
    ? await import('@deepseek-ai/dsh-subagent-dsh-sdk')
    : undefined
  for (const target of config.targets.values()) {
    await ctx.plugin(SdkProvider!, {
      providerName: target.providerName, profile: target.profile, patches: target.patches, dshHome: target.dshHome,
      cwd: target.cwd, env: target.env, provider: target.provider, model: target.model,
      ...target.dshBin === undefined ? {} : { dshBin: target.dshBin },
      ...target.maxTokens === undefined ? {} : { maxTokens: target.maxTokens },
    })
  }
  ctx.tools.register(createDelegationTool(ctx, config))
  ctx.tools.register(createDelegationModelsTool(ctx))
  mountPresentation(ctx, config)
  mountDenialHints(ctx, config)
  if (config.promptEnabled) mountHints(ctx, config)
}
