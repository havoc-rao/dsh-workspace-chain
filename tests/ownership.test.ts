import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalTolerant, ownerMatches, resolvePathOwners, type OwnerWorkspace } from '../src/ownership.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function tree(): Promise<{ a: string; b: string; file: string; nested: string }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'chain-ownership-')))
  roots.push(root)
  const a = join(root, 'workspace-a'); await mkdir(a)
  const b = join(root, 'workspace-b'); await mkdir(b)
  const nested = join(a, 'nested'); await mkdir(nested)
  const file = join(b, 'src', 'main.ts'); await mkdir(join(b, 'src')); await writeFile(file, 'ok')
  return { a, b, file, nested }
}
const workspace = (id: string, title: string, path: string, sessionIds: string[] = []): OwnerWorkspace => ({ id, title, path, sessionIds })

describe('canonicalTolerant', () => {
  it('resolves existing paths and re-joins the remainder of not-yet-created targets', async () => {
    const { a, file } = await tree()
    expect(canonicalTolerant(a)).toBe(a)
    expect(canonicalTolerant(file)).toBe(file)
    expect(canonicalTolerant(join(a, 'new', 'file.ts'))).toBe(join(a, 'new', 'file.ts'))
  })
  it('leaves relative or undecodable segments untouched rather than throwing', () => {
    expect(canonicalTolerant('relative/path')).toBe('relative/path')
  })
})

describe('ownerMatches', () => {
  it('is boundary-safe: inside or equal matches, siblings and prefixes do not', async () => {
    const { a, b } = await tree()
    expect(ownerMatches(a, a)).toBe(true)
    expect(ownerMatches(a, join(a, 'src', 'x.ts'))).toBe(true)
    expect(ownerMatches(a, `${a}x`)).toBe(false)
    expect(ownerMatches(a, b)).toBe(false)
    expect(ownerMatches(a, join(b, 'src'))).toBe(false)
  })
})

describe('resolvePathOwners', () => {
  it('lists the registry workspace and the configured target containing the path', async () => {
    const { a, b, file } = await tree()
    const result = resolvePathOwners({
      path: file, workspaces: [workspace('wa', 'A', a), workspace('wb', 'B', b)], targets: [{ name: 'tb', cwd: b }], nativeAvailable: true,
    })
    expect(result.path).toBe(file)
    expect(result.exists).toBe(true)
    // Registry workspace wins the dedupe by root; the target for the same root is not repeated.
    expect(result.owners).toEqual([{ kind: 'workspace', id: 'wb', name: 'B', root: b, delegatable: true }])
  })
  it('marks a configured-only root as a target owner', async () => {
    const { a, b, file } = await tree()
    const result = resolvePathOwners({ path: file, workspaces: [workspace('wa', 'A', a)], targets: [{ name: 'tb', cwd: b }], nativeAvailable: true })
    expect(result.owners).toEqual([{ kind: 'target', id: 'tb', name: 'tb', root: b, delegatable: true }])
  })
  it('resolves current by the requesting session and keeps it out of external owners', async () => {
    const { a, b, file } = await tree()
    const result = resolvePathOwners({
      path: file, sessionId: 'session-in-a',
      workspaces: [workspace('wa', 'A', a, ['session-in-a']), workspace('wb', 'B', b, ['session-in-b'])],
      targets: [], nativeAvailable: true,
    })
    expect(result.current).toEqual({ kind: 'workspace', id: 'wa', name: 'A', root: a, delegatable: true })
    expect(result.owners).toEqual([{ kind: 'workspace', id: 'wb', name: 'B', root: b, delegatable: true }])
  })
  it('reports the current workspace as the owner when the path lies inside it', async () => {
    const { a } = await tree()
    const inside = join(a, 'src', 'x.ts')
    const result = resolvePathOwners({
      path: inside, sessionId: 'session-in-a',
      workspaces: [workspace('wa', 'A', a, ['session-in-a'])], targets: [], nativeAvailable: true,
    })
    expect(result.current).toEqual({ kind: 'workspace', id: 'wa', name: 'A', root: a, delegatable: true })
    expect(result.owners).toEqual([{ kind: 'workspace', id: 'wa', name: 'A', root: a, delegatable: true }])
  })
  it('returns no owners for unregistered paths and reports existence faithfully', async () => {
    const { a, file } = await tree()
    const other = join(a, '..', 'unregistered-project', 'x.ts')
    const result = resolvePathOwners({ path: other, workspaces: [workspace('wa', 'A', a)], targets: [], nativeAvailable: false })
    expect(result.owners).toEqual([])
    expect(result.exists).toBe(false)
    expect(result.current).toBeUndefined()
    expect(canonicalTolerant(join(file, '..', 'missing.ts'))).toBe(join(file, '..', 'missing.ts'))
  })
  it('drops the delegatable flag for registry workspaces without the native session API', async () => {
    const { b, file } = await tree()
    const result = resolvePathOwners({ path: file, workspaces: [workspace('wb', 'B', b)], targets: [], nativeAvailable: false })
    expect(result.owners).toEqual([{ kind: 'workspace', id: 'wb', name: 'B', root: b, delegatable: false }])
  })
})