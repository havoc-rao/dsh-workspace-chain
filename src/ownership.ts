/**
 * Path-ownership lookup: given an absolute path (typically the `file_path` of
 * an edit/write call the file sandbox denied), answer which registered
 * workspace owns it — the registry entities (`workspaceRegistry.list()`) and
 * the explicitly configured SDK targets (`config.targets`). This is the
 * server-side authority behind both the automatic denial hint (upsreamed to
 * the model exactly like the other workspace-chain hints) and the
 * `ownerOf` RPC the approval-prompt button queries.
 *
 * Matching is canonical-path containment: workspace roots are canonical at
 * registration time (registry: `fs.realpath`; targets: `resolveConfig`), and
 * the query path is canonicalized through the deepest existing ancestor so a
 * not-yet-created write target still resolves. A path nested under a root
 * (or equal to it) is owned by that workspace.
 */
import { existsSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, sep } from 'node:path'
import type { ResolvedConfig } from './config.js'
import type { OwnerOfResult, PathOwnerView } from './shared/catalog.js'
import type {} from '@deepseek-ai/dsh-workspace'

/** A minimal view of one registry workspace entry (kept projection-safe). */
export interface OwnerWorkspace { id: string; title: string; path: string; sessionIds?: readonly string[] }

/** One configured SDK target projected to the owner shape. */
export interface OwnerTarget { name: string; cwd: string }

/** Canonicalize a path tolerantly: realpath the deepest existing ancestor and re-join the remainder. */
export function canonicalTolerant(path: string): string {
  if (!isAbsolute(path)) return path
  let head = path
  const tail: string[] = []
  for (;;) {
    try {
      const canonical = realpathSync(head)
      return join(canonical, ...tail)
    } catch {
      const parent = dirname(head)
      if (parent === head) return path
      tail.unshift(head.slice(parent.length + 1))
      head = parent
    }
  }
}

/** Whether `root` (canonical) contains `target` (canonical), boundary-safe. */
export function ownerMatches(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)
}

export interface OwnershipInput {
  /** Canonical request path (call `canonicalTolerant` first). */
  path: string
  /** Registry workspaces, in registry order. */
  workspaces: readonly OwnerWorkspace[]
  /** Configured SDK targets. */
  targets: readonly OwnerTarget[]
  /** Whether the native session API (`sessionController`) is mounted. */
  nativeAvailable: boolean
  /** The requesting session id, when known (resolves the `current` owner). */
  sessionId?: string
}

/** Resolve every registered root containing `path`, plus the requesting session's own owner. */
export function resolvePathOwners(input: OwnershipInput): OwnerOfResult {
  const owners: PathOwnerView[] = []
  const roots = new Set<string>()
  const add = (view: PathOwnerView): void => {
    if (roots.has(view.root)) return
    roots.add(view.root)
    owners.push(view)
  }
  for (const workspace of input.workspaces) {
    if (!ownerMatches(workspace.path, input.path)) continue
    add({ kind: 'workspace', id: workspace.id, name: workspace.title || workspace.path, root: workspace.path, delegatable: input.nativeAvailable })
  }
  for (const target of input.targets) {
    if (!ownerMatches(target.cwd, input.path)) continue
    add({ kind: 'target', id: target.name, name: target.name, root: target.cwd, delegatable: true })
  }
  let current: PathOwnerView | undefined
  if (input.sessionId !== undefined) {
    const sessionId: string = input.sessionId
    const workspace = input.workspaces.find(w => w.sessionIds?.includes(sessionId))
    if (workspace) {
      current = { kind: 'workspace', id: workspace.id, name: workspace.title || workspace.path, root: workspace.path, delegatable: input.nativeAvailable }
      // The current owner is reported separately even when the path is
      // outside it; it only enters `owners` when it actually contains it.
    }
  }
  return { path: input.path, exists: existsSync(input.path), owners, ...current !== undefined ? { current } : {} }
}

/** The option set both call sites (denial hint + RPC) need. */
export interface OwnershipContext { config: ResolvedConfig; workspaces: readonly OwnerWorkspace[]; nativeAvailable: boolean }

export function ownersFor(ctx: OwnershipContext, path: string, sessionId?: string): OwnerOfResult {
  return resolvePathOwners({
    path: canonicalTolerant(path),
    workspaces: ctx.workspaces,
    targets: [...ctx.config.targets].map(([name, t]) => ({ name, cwd: t.cwd })),
    nativeAvailable: ctx.nativeAvailable,
    sessionId,
  })
}