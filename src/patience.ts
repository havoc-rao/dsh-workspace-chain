import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { DelegationRecord } from './delegation-record.js'

/**
 * Activity-aware wait bounds for workspace delegations.
 *
 * A plain hard timeout is wrong for long delegation tasks: the target is
 * another workspace's live agent, and we can observe whether it still works
 * (local agent status, session-store writes, or child progress checkpoints).
 * `adaptiveDeadline` keeps the caller's base window, then — instead of
 * aborting the moment it expires — re-arms itself for one `extensionMs`
 * round while the activity probe still reports the target as working, up to
 * `maxExtensions` rounds. A timeout is only declared after the target has
 * been silent for a full extension window (or the extension cap is reached),
 * so "the other side is still working → wait a bit longer" becomes the
 * default policy instead of a race with the model's patience.
 */

export interface ActivityProbeResult {
  active: boolean
  /** Human-readable evidence for progress lines and the timeout reason. */
  detail: string
}

export interface PatienceOptions {
  /** Base wait before the first activity check (the caller's timeout_ms). */
  baseMs: number
  /** Per-round extension while the target still shows activity. */
  extensionMs: number
  /** Cap on extension rounds; a still-active delegation is then settled as timeout. */
  maxExtensions: number
  /** Caller cancellation signal; it aborts the combined signal without expiring the wait. */
  signal: AbortSignal
  /** Cheap liveness check, called only at deadline boundaries (never on a loop). */
  probe: () => ActivityProbeResult
  /** Called after each accepted extension round (e.g. to append a progress checkpoint line). */
  onExtend?: (extension: number, probe: ActivityProbeResult) => void
}

export interface Patience {
  /** Combined signal: aborts on terminal timeout or caller cancellation. */
  signal: AbortSignal
  /** Stop future deadline checks (idempotent; does not abort). */
  dispose(): void
  /** Terminal timeout reached (extension cap or stall) — drives `timeout` classification. */
  expired(): boolean
  /** Number of extension rounds granted so far. */
  extensions(): number
  /** Why the wait expired, when it did. */
  reason(): string | undefined
}

export function adaptiveDeadline(options: PatienceOptions): Patience {
  const controller = new AbortController()
  let expired = false
  let used = 0
  let reason: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (ms: number) => {
    timer = setTimeout(fire, ms)
    timer.unref()
  }
  function fire(): void {
    if (expired) return
    const probe = options.probe()
    if (probe.active && used < options.maxExtensions) {
      used += 1
      options.onExtend?.(used, probe)
      schedule(options.extensionMs)
      return
    }
    expired = true
    const waited = `${options.baseMs}ms + ${used}×${options.extensionMs}ms`
    reason = probe.active
      ? `workspace delegation timed out: target stayed active past the ${options.maxExtensions}-extension cap (waited ${waited})`
      : `workspace delegation timed out: no target activity observed (${probe.detail}); waited ${waited}`
    controller.abort(new Error(reason))
  }
  // Caller cancellation owns the outcome: stop probing so a slow child
  // settlement can never flip the classification from cancelled to timeout.
  const onCallerAbort = () => { if (timer) clearTimeout(timer) }
  options.signal.addEventListener('abort', onCallerAbort, { once: true })
  schedule(options.baseMs)
  return {
    signal: AbortSignal.any([options.signal, controller.signal]),
    dispose: () => {
      if (timer) clearTimeout(timer)
      options.signal.removeEventListener('abort', onCallerAbort)
    },
    expired: () => expired,
    extensions: () => used,
    reason: () => reason,
  }
}

function newestEntryMs(dir: string): number | undefined {
  let newest: number | undefined
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) continue
      const mtime = statSync(join(dir, entry.name)).mtimeMs
      if (newest === undefined || mtime > newest) newest = mtime
    }
    return newest
  } catch {
    return undefined
  }
}

/** mtime of the progress file, but only once the CHILD has appended a checkpoint line (`- …`). */
function childProgressMs(record: DelegationRecord | undefined): number | undefined {
  if (!record) return undefined
  try {
    if (!readFileSync(record.progressPath, 'utf8').split('\n').some(line => /^- /.test(line))) return undefined
    return statSync(record.progressPath).mtimeMs
  } catch {
    return undefined
  }
}

export interface ActivityProbeOptions {
  record?: DelegationRecord
  /** Current run handle; undefined while provider startup is still pending. */
  run: () => SubagentRun | undefined
  /** The target's DSH home; its `sessions/` root is watched for streaming writes. */
  dshHome: string
  /** Freshness window: any heartbeat younger than this counts as active. */
  freshMs: number
}

/**
 * Best-effort liveness probe for the target workspace session. Sources, in
 * priority order: the live local agent's status (native path), the newest
 * write under `<dshHome>/sessions` (streaming deltas from either path), and
 * the child's own progress checkpoints. All reads are guarded — an
 * unreadable store simply reports no signal.
 */
export function probeActivity(options: ActivityProbeOptions): ActivityProbeResult {
  const now = Date.now()
  const fresh = (mtime: number | undefined): mtime is number => mtime !== undefined && now - mtime <= options.freshMs
  const aged = (mtime: number | undefined): string => mtime === undefined ? 'absent' : `${Math.max(0, Math.round((now - mtime) / 1000))}s ago`
  const run = options.run()
  if (run?.localAgent?.status === 'running') return { active: true, detail: 'target agent is live and running' }
  const store = newestEntryMs(join(options.dshHome, 'sessions'))
  if (fresh(store)) return { active: true, detail: `target session store heartbeat ${aged(store)}` }
  const progress = childProgressMs(options.record)
  if (fresh(progress)) return { active: true, detail: `target progress checkpoint ${aged(progress)}` }
  return { active: false, detail: `store ${aged(store)}, progress ${aged(progress)}` }
}