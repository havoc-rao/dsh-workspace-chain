/** Headless runtime services; transports, model adapters and executors are composed in YAML. */
import type { Context } from '@deepseek-ai/cordis'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import Llm from '@deepseek-ai/dsh-llm'
import Sessions from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Jobs from '@deepseek-ai/dsh-jobs-local'
import * as Retry from '@deepseek-ai/dsh-llm-retry'
export const name = 'workspace-child-runtime'
export function apply(ctx: Context): void {
  ctx.plugin(Timer)
  ctx.plugin(Llm)
  ctx.plugin(Sessions)
  ctx.plugin(Projections)
  ctx.plugin(Agents)
  ctx.plugin(SystemPrompt, { persona: 'You are a coding agent. Complete the delegated task in your working directory and report the result.' })
  ctx.plugin(Tools)
  ctx.plugin(Jobs)
  ctx.plugin(Retry)
  ctx.plugin(AgentLoop)
}
