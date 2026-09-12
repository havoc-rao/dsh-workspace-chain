import { realpathSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'

export interface Target {
  aliases?: string[]
  purpose?: string
  cwd: string
  command: string
  args?: string[]
  env?: Record<string, string>
  provider?: string
  model?: string
  maxTokens?: number
}
export interface Config {
  toolName?: string
  promptEnabled?: boolean
  defaultTimeoutMs?: number
  /** Per-round wait extension while the target session still shows activity. Default 120000 (2 min). */
  timeoutExtensionMs?: number
  /** Cap on extension rounds before a still-active delegation is settled as timeout. Default 10. */
  maxTimeoutExtensions?: number
  shareSessionStore?: boolean
  /** Write the delegation task book + progress checkpoints to <target>/.dsh/delegations/<id>/. Default true. */
  delegationRecords?: boolean
  /** Pin the created session's title (`项目/任务摘要`) via sessions.rename; local path only. Default true. */
  pinnedTitles?: boolean
  /**
   * Keep the delegation tool in the session's top-level schema and the
   * `tools:sdk` section, so every model sees it as a normal tool and can call
   * it directly. Default true. Set false to fall back to the deferred textual
   * declaration only (the tool is then registered but excluded from the
   * schema, and the model is expected to emit a native tool-call that the
   * host routes by name — some model loops do not accept out-of-schema calls).
   */
  visibleTools?: boolean
  targets?: Record<string, Target>
}
export const Config: z<Config> = z.object({
  toolName: z.string().default('delegate_workspace'),
  promptEnabled: z.boolean().default(true),
  defaultTimeoutMs: z.number().default(300_000),
  timeoutExtensionMs: z.number().default(120_000),
  maxTimeoutExtensions: z.number().default(10),
  shareSessionStore: z.boolean().default(true),
  delegationRecords: z.boolean().default(true),
  pinnedTitles: z.boolean().default(true),
  visibleTools: z.boolean().default(true),
  targets: z.dict(z.object({
    purpose: z.string(), aliases: z.array(z.string()).default([]), cwd: z.string().required(), command: z.string().required(),
    args: z.array(z.string()).default([]), env: z.dict(z.string()).default({}),
    provider: z.string().default('deepseek-official'), model: z.string().default('deepseek-v4-flash'),
    maxTokens: z.number(),
  })).default({}),
})
export interface ResolvedTarget extends Target {
  cwd: string
  args: string[]
  env: Record<string, string>
  provider: string
  model: string
  providerName: string
}
export interface ResolvedConfig {
  shareSessionStore: boolean
  toolName: string
  promptEnabled: boolean
  defaultTimeoutMs: number
  /** Per-round wait extension while the target session still shows activity. */
  timeoutExtensionMs: number
  /** Cap on extension rounds before a still-active delegation is settled as timeout. */
  maxTimeoutExtensions: number
  delegationRecords: boolean
  pinnedTitles: boolean
  /** Keep the tool in the top-level schema and the `tools:sdk` section. Default true. */
  visibleTools: boolean
  targets: Map<string, ResolvedTarget>
}
export function checkDirectory(path: string): string {
  const canonical = realpathSync(path)
  if (!statSync(canonical).isDirectory()) throw new Error(`workspace cwd is not a directory: ${path}`)
  return canonical
}
function nonempty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new TypeError(`${label} must be a non-empty string without NUL`)
}
export function resolveConfig(input: Config = {}): ResolvedConfig {
  const toolName = input.toolName ?? 'delegate_workspace'
  if (!/^[a-zA-Z0-9_-]+$/.test(toolName)) throw new TypeError('toolName must contain only letters, numbers, underscores or hyphens')
  const defaultTimeoutMs = input.defaultTimeoutMs ?? 300_000
  const timeoutExtensionMs = input.timeoutExtensionMs ?? 120_000
  const maxTimeoutExtensions = input.maxTimeoutExtensions ?? 10
  for (const ms of [defaultTimeoutMs, timeoutExtensionMs]) {
    if (!Number.isSafeInteger(ms) || ms <= 0 || ms > 2_147_483_647) throw new TypeError('defaultTimeoutMs/timeoutExtensionMs must be positive integers <= 2147483647')
  }
  if (!Number.isSafeInteger(maxTimeoutExtensions) || maxTimeoutExtensions <= 0 || maxTimeoutExtensions > 10_000) {
    throw new TypeError('maxTimeoutExtensions must be a positive integer <= 10000')
  }
  for (const key of ['promptEnabled', 'shareSessionStore', 'delegationRecords', 'pinnedTitles', 'visibleTools'] as const) {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new TypeError(`${key} must be boolean`)
  }
  if (input.targets !== undefined && (!input.targets || typeof input.targets !== 'object' || Array.isArray(input.targets))) throw new TypeError('targets must be a dictionary')
  const home = resolveDshHome()
  const targets = new Map<string, ResolvedTarget>()
  for (const [name, target] of Object.entries(input.targets ?? {})) {
    nonempty(name, 'target name')
    if (!target || typeof target !== 'object') throw new TypeError(`target ${name} must be an object`)
    nonempty(target.cwd, `target ${name} cwd`)
    nonempty(target.command, `target ${name} command`)
    if (target.purpose !== undefined && typeof target.purpose !== 'string') throw new TypeError(`target ${name} purpose must be a string`)
    if (target.args !== undefined && (!Array.isArray(target.args) || target.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) throw new TypeError(`target ${name} args must be strings without NUL`)
    if (target.env !== undefined && (!target.env || typeof target.env !== 'object' || Array.isArray(target.env))) throw new TypeError(`target ${name} env must be a dictionary`)
    const env = { ...target.env }
    for (const [key, value] of Object.entries(env)) {
      if (!key || /[=\0]/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new TypeError(`target ${name} has an invalid environment entry: ${key}`)
    }
    if (target.aliases !== undefined && (!Array.isArray(target.aliases) || target.aliases.some(a => typeof a !== 'string' || !a.trim()))) throw new TypeError(`target ${name} aliases must be non-empty strings`)
    const cwd = checkDirectory(resolve(target.cwd))
    // Omission would fall back to ~/.dsh and silently rejoin the parent store.
    const shared = input.shareSessionStore ?? true
    if (shared) {
      if (env.DSH_HOME !== undefined && resolveDshHome(env.DSH_HOME) !== home) throw new Error(`target ${name}: DSH_HOME conflicts with shareSessionStore`)
      env.DSH_HOME = home
    } else {
      env.DSH_HOME = resolveDshHome(env.DSH_HOME ?? join(cwd, '.dsh-workspace-chain'))
      if (env.DSH_HOME === home) throw new Error(`target ${name}: isolated DSH_HOME must differ from parent home`)
    }
    const provider = target.provider ?? 'deepseek-official'
    const model = target.model ?? 'deepseek-v4-flash'
    nonempty(provider, `target ${name} provider`)
    nonempty(model, `target ${name} model`)
    if (target.maxTokens !== undefined && (!Number.isSafeInteger(target.maxTokens) || target.maxTokens <= 0)) throw new TypeError(`target ${name} maxTokens must be a positive safe integer`)
    targets.set(name, { ...target, cwd, args: [...target.args ?? []], env, provider, model,
      providerName: `workspace-chain:${toolName}:${name}` })
  }
  return { shareSessionStore: input.shareSessionStore ?? true, toolName, promptEnabled: input.promptEnabled ?? true, defaultTimeoutMs, timeoutExtensionMs, maxTimeoutExtensions, delegationRecords: input.delegationRecords ?? true, pinnedTitles: input.pinnedTitles ?? true, visibleTools: input.visibleTools ?? true, targets }
}
