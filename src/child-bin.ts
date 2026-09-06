#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const name = 'dsh-workspace-child'
installFailLoud(name)
loadEnv(name)
const requested = process.env.DSH_CORDIS_CONFIG || process.argv[2]
const configPath = requested ? resolveConfigPath(requested, undefined) : fileURLToPath(new URL('../src/child.cordis.yml', import.meta.url))
if (!existsSync(configPath)) throw new Error(`Child configuration does not exist: ${configPath}`)
// Default composition resolves from this package; custom compositions own their dependencies.
const ctx = await boot(name, configPath, undefined, undefined, requested ? undefined : import.meta.url)
let exiting = false
async function stop(code: number) {
  if (exiting) return
  exiting = true
  try { await ctx.fiber.dispose() } finally { process.exit(code) }
}
process.stdin.on('end', () => { void stop(0) })
process.on('SIGTERM', () => { void stop(0) })
process.on('SIGINT', () => { void stop(130) })
