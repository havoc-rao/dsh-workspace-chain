import { LlmAdapter } from '@deepseek-ai/dsh-llm'
class Delegating extends LlmAdapter {
  async *stream(options) {
    const result = options.messages.flatMap(message => message.content).filter(b => b.type === 'tool-result').at(-1)
    if (!result) {
      const hint = options.messages.flatMap(m => m.content).some(b => b.type === 'text' && b.text.includes('Workspace-chain hint:'))
      if (!hint) throw new Error('workspace hint was not injected into the real model request')
      if (!options.tools?.some(tool => tool.name === 'delegate_workspace')) throw new Error('delegation tool not in real model request')
      const args = JSON.stringify({ target: 'b', task: 'Report your workspace and process state' })
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
export function apply(ctx) { ctx.llm.registerAdapter(['mock'], new Delegating()) }
