import { mkdtemp, mkdir, readFile, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const root = await realpath(await mkdtemp(join(tmpdir(), 'workspace-chain-install-')))
const profile = join(root, 'profiles', 'chain-smoke')
await mkdir(profile, { recursive: true })
await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'chain-install-smoke', private: true, dsh: { profile: { bundles: [] } } }, null, 2))
await writeFile(join(profile, 'pnpm-workspace.yaml'), await readFile('pnpm-workspace.yaml', 'utf8'))
const archive = resolve(process.argv[2] ?? 'dsh-workspace-chain-0.1.0.tgz')
const result = spawnSync('dsh', ['plugin', '--profile', 'chain-smoke', 'add', `file:${archive}`, '--offline'], { env: { ...process.env, DSH_HOME: root }, encoding: 'utf8' })
if (result.status !== 0) { process.stderr.write(result.stdout + result.stderr); process.exit(result.status ?? 1) }
const manifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8'))
if (!manifest.dsh.profile.bundles.includes('dsh-workspace-chain')) throw new Error('CLI did not reconcile the plugin bundle')
const entry = join(profile, 'node_modules', 'dsh-workspace-chain', 'lib', 'index.js')
const loaded = await import(entry)
if (loaded.default !== undefined || !loaded.inject?.includes('tools')) throw new Error('Plugin metadata was lost')
const { boot } = await import('@deepseek-ai/dsh-app-boot')
const composition = join(root, 'empty.yml')
await writeFile(composition, JSON.stringify([
  { name: join(profile, 'node_modules', 'dsh-workspace-chain', 'lib', 'child-runtime.js') },
  { name: import.meta.resolve('@deepseek-ai/dsh-subagent') },
  { name: entry, config: { targets: {} } },
]))
const ctx = await boot('workspace-chain-install-smoke', composition)
try {
  if (!ctx.tools.get('delegate_workspace')) throw new Error('Empty target catalog did not register the local delegation tool')
} finally { await ctx.fiber.dispose() }
console.log(`Packed plugin installed, bundle reconciled, and empty-target composition booted: ${profile}`)
