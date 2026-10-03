/**
 * Message source kind for hints this plugin injects. dsh-llm's
 * MessageSourceMap is merge-extensible: every producer declares its own
 * `kind` in its own module, and there is no shared catch-all `plugin` kind
 * (the string `plugin` was removed upstream in 0.1.7). The `plugin` field
 * below is this plugin's own discriminator on the kind, kept so recorded
 * context stays attributable even when this module is not imported.
 */
import type { ContextForm } from '@deepseek-ai/dsh-llm'

/** Producer source of every workspace-chain hint message. */
export interface WorkspaceChainMessageSource {
  kind: 'workspace-chain'
  /** This plugin's package identity; distinguishes collaborations under one kind. */
  plugin: 'workspace-chain'
  /** Instructions the model is expected to follow while a delegation is offered. */
  form: ContextForm
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'workspace-chain': WorkspaceChainMessageSource
  }
}

/** The shared source stamp every workspace-chain hint message carries. */
export const workspaceChainSource: WorkspaceChainMessageSource = {
  kind: 'workspace-chain', plugin: 'workspace-chain', form: 'instructions',
}