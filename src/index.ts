import type { Context } from '@deepseek-ai/cordis'
import * as SdkProvider from '@deepseek-ai/dsh-subagent-dsh-sdk'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { resolveConfig, type Config } from './config.js'
import { createDelegationTool } from './tool.js'
import { mountHints } from './hints.js'
import { mountCatalog } from './catalog.js'
import { mountWorkspaceHints } from './workspace-hints.js'
import { mountPresentation } from './presentation.js'
export { Config } from './config.js'
export { classifyDelegation, composeTask, newDelegationId, writeDelegationRecord, appendProgress, progressSummary, finalizeRecord }
  from './delegation-record.js'
export type { DelegationRecord, DelegationStatus, DelegationMode, DelegationDiagnostic, ClassificationInput } from './delegation-record.js'
export { DelegationFailure } from './tool.js'
export const name = 'workspace-chain'
export const inject = ['agents', 'tools', 'subagents', 'systemPrompt']
export async function apply(ctx: Context, input: Config): Promise<void> {
  const config = resolveConfig(input)
  mountCatalog(ctx, config)
  if (config.promptEnabled) mountWorkspaceHints(ctx, config)
  for (const target of config.targets.values()) {
    await ctx.plugin(SdkProvider, {
      providerName: target.providerName, command: target.command, args: target.args,
      cwd: target.cwd, env: target.env, provider: target.provider, model: target.model,
      ...target.maxTokens === undefined ? {} : { maxTokens: target.maxTokens },
    })
  }
  ctx.tools.register(createDelegationTool(ctx, config))
  mountPresentation(ctx, config)
  if (config.promptEnabled) mountHints(ctx, config)
}
