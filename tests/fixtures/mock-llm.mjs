import { LlmAdapter } from '@deepseek-ai/dsh-llm'
class Echo extends LlmAdapter {
  async *stream() {
    const text = JSON.stringify({ cwd: process.cwd(), home: process.env.DSH_HOME, ambientSecret: process.env.CHAIN_SECRET_TOKEN ?? null, explicit: process.env.CHAIN_EXPLICIT ?? null })
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 12 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
export const inject = ['llm']
export function apply(ctx) { ctx.llm.registerAdapter(['mock'], new Echo()) }
