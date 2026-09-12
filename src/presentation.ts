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
  const declaration = config.visibleTools
    ? `${config.toolName} 已注册在顶层 tools 中，与其他工具一样直接按函数名调用即可。`
    : `这是当前宿主已注册的工作区委派能力，工具声明在本条上下文提供，未列在顶层 tools 中；通过原生 tool-call 调用此工具，不要为寻找发送方式而读取当前插件源码，也不要把“发送你好”做成创建或修改文件。`
  return `Deferred tool: ${config.toolName}\n${declaration}当前会话负责交接任务和汇总结果，目标工作区的新会话负责执行。\n可以发送消息、让目标 agent 分析项目或按用户要求修改并验证代码；具体操作受目标 runtime 的能力与权限约束。仅引用工作区不触发执行。用户明确要求发送或执行任务时调用此工具。\n调用示例（不是向用户输出的 JSON）：\n${JSON.stringify(call)}\n参数：target 为已披露的工作区绝对路径或显式配置的 SDK 目标名；task 为交给目标 agent 的任务原文及必要上下文；run_in_background 默认 false。前台结果返回后再确认已交付；后台只返回 jobId，需用 job_output 收取结果后才能宣称完成。默认通过 DSH 本地 session API 在目标工作区新建会话，使用宿主新会话的默认模型及当前会话的 preset；传 session_id 时改为回复已发布的同一会话（见下文），不创建新会话。若模型接口拒绝该工具调用，如实报告调用失败，不伪造成功，也不自行用 shell 启动替代进程。
任务拆分与并行：同一请求可拆成多个互不依赖的子任务时，对可并行的部分（例如只等对方返回一个 key / 契约名，或改动互不干扰的多个工作区）用 run_in_background: true 挂后台，继续处理其他事情，最后统一用 job_output 收取结果并整合；只有下一步必须依赖其结果时才前台等待（run_in_background: false）。不要在前台空等一个可以并行完成的任务。
超时是活动感知的，不是硬上限：目标会话有产出（本地 agent 运行中、会话日志写入、进度 checkpoints 更新）时，等待会自动顺延（每轮 timeoutExtensionMs，上限 maxTimeoutExtensions 轮）；只有对方长时间无任何产出时才按 timeout 结算。等待期间可用 job_output 观察运行中摘要。
 回到已发布的会话：每次本地委派在创建前就已确定会话 ID（后台响应与委派记录从调用时起就携带 sessionId），超时/失败后会话仍由宿主保留。要继续该会话时，把上次返回的 sessionId 作为 session_id 参数再次调用 delegate_workspace，任务会直接送进同一会话（上下文保留），而不是另起新会话。也可以不传 session_id：任务文本中若带有会话引用（dsh-session 引用，@ 插入的 chip），执行层会把它解析为发送目标，把任务送进被引用的会话（仅本地工作区目标；被引用会话必须存在且属于目标工作区；引用多个会话时需显式传 session_id）。两个来源冲突时显式 session_id 优先。`
}

/**
 * Presentation policy: in visible mode (`visibleTools`, the default) the tool
 * stays in the session's top-level schema and `tools:sdk` section, so every
 * model can call it as an ordinary tool. In deferred mode the tool is kept
 * executable while excluded from the schema, and the injected hint carries the
 * declaration instead; only the code-only-scope marker is maintained in both.
 */
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
    if (config.visibleTools) return assembly
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
