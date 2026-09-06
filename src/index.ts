import type { Context } from '@deepseek-ai/cordis'
import * as SdkProvider from '@deepseek-ai/dsh-subagent-dsh-sdk'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { resolveConfig, type Config } from './config.js'
import { workspacePrompt } from './prompt.js'
import { createDelegationTool } from './tool.js'
import { mountHints } from './hints.js'
import { mountCatalog } from './catalog.js'
export { Config } from './config.js'
export const name = 'workspace-chain'
export const inject = ['agents', 'tools', 'subagents', 'systemPrompt']
export async function apply(ctx: Context, input: Config): Promise<void> {
  const config = resolveConfig(input)
  mountCatalog(ctx, config)
  if (!config.targets.size) return
  for (const target of config.targets.values()) {
    await ctx.plugin(SdkProvider, {
      providerName: target.providerName, command: target.command, args: target.args,
      cwd: target.cwd, env: target.env, provider: target.provider, model: target.model,
      ...target.maxTokens === undefined ? {} : { maxTokens: target.maxTokens },
    })
  }
  ctx.tools.register(createDelegationTool(ctx, config))
  if (config.promptEnabled) mountHints(ctx, config)
  if (config.promptEnabled) ctx.systemPrompt.section({
    name: `deployment:workspace-chain:${config.toolName}`, order: 117, text: workspacePrompt(config),
  })
}
