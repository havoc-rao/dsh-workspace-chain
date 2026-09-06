import type { ResolvedConfig } from './config.js'
export function workspacePrompt(config: ResolvedConfig): string {
  const targets = [...config.targets].map(([name, target]) => `${JSON.stringify(name)}${target.purpose ? `: ${target.purpose}` : ''}`).join('\n')
  return `Available workspace agents:\n${targets}\nRead the current user query together with prior conversation context to identify requested work and the responsible target. UI references use @workspace/<target>. A mention alone is context, not an instruction to execute. When follow-up work belongs to one of these targets, call ${config.toolName} before finishing. Give each fresh session a standalone task with all required context and acceptance criteria. Independent delegations may be started together. Include relevant upstream results in each standalone task. After delegation, verify its outcome and integrate the result into your response to the original user request; collect background jobs before claiming completion.`
}
