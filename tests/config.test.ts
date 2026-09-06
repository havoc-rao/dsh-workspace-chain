import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig, Config } from '../src/config.js'
const roots: string[] = []
function directory() { const root = mkdtempSync(join(tmpdir(), 'chain-config-')); roots.push(root); return root }
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
describe('configuration', () => {
  it('accepts an empty allowlist and applies loader defaults', () => {
    expect(resolveConfig(Config({})).targets.size).toBe(0)
    expect(resolveConfig().defaultTimeoutMs).toBe(300000)
  })
  it('canonicalizes cwd and explicitly forwards shared home without ambient secrets', () => {
    const root = directory(); mkdirSync(join(root, 'project')); symlinkSync(join(root, 'project'), join(root, 'alias'))
    vi.stubEnv('DSH_HOME', join(root, 'home')); vi.stubEnv('SECRET_TOKEN', 'never-forward')
    const target = resolveConfig({ targets: { b: { cwd: join(root, 'alias'), command: 'node' } } }).targets.get('b')!
    expect(target.cwd).toMatch(/\/project$/)
    expect(target.env).toEqual({ DSH_HOME: join(root, 'home') })
  })
  it('uses a separate home when sharing is disabled and rejects a conflicting override', () => {
    const cwd = directory(); vi.stubEnv('DSH_HOME', join(cwd, 'parent'))
    const b = { cwd, command: 'node' }
    expect(resolveConfig({ shareSessionStore: false, targets: { b } }).targets.get('b')!.env.DSH_HOME).toMatch(/\.dsh-workspace-chain$/)
    expect(() => resolveConfig({ targets: { b: { ...b, env: { DSH_HOME: join(cwd, 'other') } } } })).toThrow('conflicts')
    expect(() => resolveConfig({ shareSessionStore: false, targets: { b: { ...b, env: { DSH_HOME: join(cwd, 'parent') } } } })).toThrow('differ')
  })
  it('rejects missing fields, nonexistent directories, files, malformed env and timeouts', () => {
    const cwd = directory(); writeFileSync(join(cwd, 'file'), '')
    for (const target of [{ cwd }, { command: 'node' }, { cwd: join(cwd, 'missing'), command: 'node' }, { cwd: join(cwd, 'file'), command: 'node' }, { cwd, command: 'node', env: { KEY: undefined } }]) {
      expect(() => resolveConfig({ targets: { b: target } } as never)).toThrow()
    }
    for (const ms of [0, -1, NaN, Infinity, 0.5, 2147483648]) expect(() => resolveConfig({ defaultTimeoutMs: ms })).toThrow()
  })
})
