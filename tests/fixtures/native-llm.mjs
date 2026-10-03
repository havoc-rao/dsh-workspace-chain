import { LlmAdapter } from '@deepseek-ai/dsh-llm'
class NativeFixture extends LlmAdapter {
  async *stream(options) {
    const blocks = options.messages.flatMap(m => m.content)
    const result = options.messages.findLast(m => m.role === 'tool')
    const hint = blocks.find(b => b.type === 'text' && b.text.includes('Deferred tool: delegate_workspace'))
    // A received delegation envelope is a delivered task, not a new user request:
    // never re-delegate the returned result (mirrors the model guidance), so the
    // reference metadata injected for a delivered task cannot echo a fresh call.
    const delivered = blocks.some(b => b.type === 'text' && b.text.includes('请在当前工作区执行以下委派任务'))
    if (hint && !result && !delivered) {
      if (options.tools?.some(t => t.name === 'delegate_workspace') || options.system?.includes('delegate_workspace')) throw new Error('prefix changed')
      const match = hint.text.match(/\{"name":"delegate_workspace","arguments":.*\}/u)
      if (!match) throw new Error('missing concrete call')
      const call = JSON.parse(match[0])
      const args = JSON.stringify(call.arguments)
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: 'delegate-native', name: call.name, argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'delegate-native', name: call.name, arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const text = result ? `Integrated: ${JSON.stringify(result.content)}` : `Native completed: ${blocks.filter(b => b.type === 'text').map(b => b.text).join('')}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export const inject = ['llm']
export function apply(ctx) { ctx.llm.registerAdapter(['native-fixture'], new NativeFixture()) }
