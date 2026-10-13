import { LlmAdapter } from '@deepseek-ai/dsh-llm'
class Delegating extends LlmAdapter {
  async *stream(options) {
    // Tool results are first-class tool-role messages in 0.1.7, not content blocks.
    const result = options.messages.findLast(message => message.role === 'tool')
    if (!result) {
      const hint = options.messages.flatMap(m => m.content).some(b => b.type === 'text' && (b.text.includes('Workspace-chain hint:') || b.text.includes('工作区引用能力')))
      if (!hint) throw new Error('workspace hint was not injected into the real model request')
      if (options.tools?.some(tool => tool.name === 'delegate_workspace')) throw new Error('delegation leaked into request tools')
      if (options.system?.includes('delegate_workspace')) throw new Error('delegation leaked into system prefix')
      const handoff = options.messages.flatMap(m => m.content).find(b => b.type === 'text' && b.text.includes('工作区引用能力'))
      if (handoff) {
        if (handoff.text.includes('Deferred tool:') || handoff.text.includes('用户本次任务：')) throw new Error('reference produced an execution instruction')
        if (!options.messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('给他发送一个你好')))) throw new Error('explicit user request missing')
      } else if (!options.messages.some(m => m.content.some(b => b.type === 'text' && b.text.includes('Deferred tool: delegate_workspace')))) throw new Error('late SDK invocation hint missing')
      const args = JSON.stringify({ target: 'b', task: handoff ? '你好' : 'Report your workspace and process state' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'delegate-1', name: 'delegate_workspace', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'delegate-1', name: 'delegate_workspace', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = `Integrated child result: ${result.content.filter(b => b.type === 'text').map(b => b.text).join('')}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export const inject = ['llm']
export function apply(ctx) {
  // Supply the language needed to render the existing SDK in both mode.
  // Native delegation must never execute a run_code program in these tests.
  ctx.provide('codeRuntime', {
    language: 'typescript', isolation: 'fixture',
    async run() { throw new Error('Unexpected run_code invocation') },
  })
  // `both` tool presentation needs a ctx.ptcRuntime in 0.1.7; the fake only
  // has to satisfy schema wiring — run_code must never execute in these tests.
  ctx.provide('ptcRuntime', {
    language: 'typescript', isolation: 'fixture',
    async run() { throw new Error('Unexpected run_code invocation') },
  })
  ctx.llm.registerAdapter(['mock'], new Delegating())
}
