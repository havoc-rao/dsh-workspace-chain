// Resolve shared package identities exactly as the selected host does, without
// installing dependencies or modifying either profile.
import { registerHooks, createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'

const host = process.argv[2]
if (!host) throw new Error('Usage: node scripts/check-host-compat.mjs <harness-checkout>')
const requireHost = createRequire(resolve(host, 'apps/cli/package.json'))
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('@deepseek-ai/')) {
    return { url: pathToFileURL(requireHost.resolve(specifier)).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
} })
const { Context } = await import('@deepseek-ai/cordis')
const { default: SystemPrompt } = await import('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = await import('@deepseek-ai/dsh-tools')
const native = await import('@deepseek-ai/dsh-tool-executor-native')
const chain = await import('../lib/index.js')
const ctx = new Context()
try {
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(native)
  // The local plugin only needs these services at execution time. This smoke
  // verifies real host imports, registration and provider-owned assembly.
  await chain.apply(ctx, { promptEnabled: false })
  assert(ctx.tools.get('delegate_workspace'))
  const assembly = await ctx.systemPrompt.assemble({})
  assert(assembly.tools.some(tool => tool.name === 'delegate_workspace'))
  console.log('HOST COMPAT PASS: plugin imported, tool registered, native prompt assembled')
} finally {
  await ctx.fiber.dispose()
}
