import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { renderToolsSdk, renderToolsSdkPy } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ResolvedConfig } from './config.js'

// Code-only scopes reject direct native names at the executor boundary.
const codeOnlyScopes = new WeakSet<object>()
export function delegationAvailable(ctx: Context, agent: Agent, config: ResolvedConfig): boolean {
  return ctx.tools.get(config.toolName, agent) !== undefined && !codeOnlyScopes.has(agent)
}
export function invocationHint(_ctx: Context, config: ResolvedConfig, example?: { target: string; task: string }): string {
  const call = { name: config.toolName, arguments: { target: example?.target ?? 'TARGET', task: example?.task ?? 'TASK', run_in_background: false } }
  return `Deferred tool: ${config.toolName}\n这是当前宿主已注册的工作区委派能力，工具声明在本条上下文提供，未列在顶层 tools 中。当前会话负责交接任务和汇总结果，目标工作区的新会话负责执行。\n可以发送消息、让目标 agent 分析项目或按用户要求修改并验证代码；具体操作受目标 runtime 的能力与权限约束。仅引用工作区不触发执行。用户明确要求发送或执行任务时，通过原生 tool-call 调用此工具，不要为寻找发送方式而读取当前插件源码，也不要把“发送你好”做成创建或修改文件。\n调用示例（不是向用户输出的 JSON）：\n${JSON.stringify(call)}\n参数：target 为已披露的工作区绝对路径或显式配置的 SDK 目标名；task 为交给目标 agent 的任务原文及必要上下文；run_in_background 默认 false。前台结果返回后再确认已交付；后台只返回 jobId，需用 job_output 收取结果后才能宣称完成。默认通过 DSH 本地 session API 在目标工作区新建会话，使用宿主新会话的默认模型及当前会话的 preset，不恢复已有 session/fork。若模型接口拒绝该工具调用，如实报告调用失败，不伪造成功，也不自行用 shell 启动替代进程。`
}

/** Keep the capability executable while excluding it from request-prefix projections. */
export function mountPresentation(ctx: Context, config: ResolvedConfig): void {
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (context.scope) {
      if (assembly.tools.length > 0 && assembly.tools.every(tool => tool.name === 'run_code')) codeOnlyScopes.add(context.scope)
      else codeOnlyScopes.delete(context.scope)
    }
    const schemas = ctx.tools.schemas(context.scope)
    const own = schemas.find(schema => schema.name === config.toolName)
    if (!own) return assembly
    const render = ctx.get('codeRuntime')?.language === 'python' ? renderToolsSdkPy : renderToolsSdk
    const sdkSchemas = schemas.filter(schema => schema.name !== 'run_code').map(schema => ({
      ...schema, output: ctx.tools.get(schema.name, context.scope)!.output.schema,
    }))
    const fullSdk = render(sdkSchemas)
    const baseSdk = render(sdkSchemas.filter(schema => schema.name !== config.toolName))
    return { ...assembly,
      tools: assembly.tools.filter(tool => tool.name !== config.toolName),
      sections: assembly.sections.map(section => {
        // Respect another plugin's custom SDK section rather than rewrite arbitrary text.
        if (section.name !== 'tools:sdk') return section
        if (section.text !== fullSdk) throw new Error('workspace-chain cannot preserve a customized tools:sdk prefix')
        return { ...section, text: baseSdk }
      }),
    }
  })
}
