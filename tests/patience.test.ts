import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { adaptiveDeadline, probeActivity } from '../src/patience.js'
import type { DelegationRecord } from '../src/delegation-record.js'
const roots: string[] = []
afterEach(() => { vi.useRealTimers(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function directory() { const root = mkdtempSync(join(tmpdir(), 'chain-patience-')); roots.push(root); return root }
const quiet = () => ({ active: false as const, detail: 'quiet' })

describe('adaptiveDeadline', () => {
  it('aborts at the base window when the probe never reports activity', async () => {
    vi.useFakeTimers()
    const timeout = adaptiveDeadline({ baseMs: 100, extensionMs: 50, maxExtensions: 3, signal: new AbortController().signal, probe: quiet })
    expect(timeout.expired()).toBe(false)
    await vi.advanceTimersByTimeAsync(50)
    expect(timeout.signal.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(50)
    expect(timeout.expired()).toBe(true)
    expect(timeout.signal.aborted).toBe(true)
    expect(timeout.reason()).toContain('no target activity observed (quiet)')
    timeout.dispose()
  })
  it('extends one round per activity window and aborts only at the extension cap', async () => {
    vi.useFakeTimers()
    const granted: string[] = []
    const timeout = adaptiveDeadline({
      baseMs: 100, extensionMs: 50, maxExtensions: 3,
      signal: new AbortController().signal,
      probe: () => ({ active: true as const, detail: 'heartbeat' }),
      onExtend: (extension, probe) => granted.push(`${extension}:${probe.detail}`),
    })
    await vi.advanceTimersByTimeAsync(100)
    expect(timeout.extensions()).toBe(1)
    expect(timeout.expired()).toBe(false)
    expect(granted).toEqual(['1:heartbeat'])
    await vi.advanceTimersByTimeAsync(50)
    expect(timeout.extensions()).toBe(2)
    await vi.advanceTimersByTimeAsync(50)
    expect(timeout.extensions()).toBe(3)
    await vi.advanceTimersByTimeAsync(50)
    expect(timeout.expired()).toBe(true)
    expect(timeout.signal.aborted).toBe(true)
    expect(timeout.reason()).toContain('extension cap')
    expect(timeout.reason()).toContain('100ms + 3×50ms')
    timeout.dispose()
  })
  it('a stalled probe between extensions falls back to a plain timeout with the stall detail', async () => {
    vi.useFakeTimers()
    let active = true
    const timeout = adaptiveDeadline({ baseMs: 100, extensionMs: 50, maxExtensions: 5, signal: new AbortController().signal, probe: () => ({ active, detail: 'store 5s ago' }) })
    await vi.advanceTimersByTimeAsync(100)
    expect(timeout.expired()).toBe(false)
    active = false
    await vi.advanceTimersByTimeAsync(50)
    expect(timeout.expired()).toBe(true)
    expect(timeout.reason()).toContain('store 5s ago')
    timeout.dispose()
  })
  it('stops probing when the caller cancels, so settlement stays cancelled not timeout', async () => {
    vi.useFakeTimers()
    const caller = new AbortController()
    const timeout = adaptiveDeadline({ baseMs: 100, extensionMs: 50, maxExtensions: 5, signal: caller.signal, probe: () => ({ active: true as const, detail: 'busy' }) })
    caller.abort('parent interrupted')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(timeout.signal.aborted).toBe(true)
    expect(timeout.expired()).toBe(false)
    expect(timeout.extensions()).toBe(0)
    timeout.dispose()
  })
  it('dispose stops later deadline checks', async () => {
    vi.useFakeTimers()
    const timeout = adaptiveDeadline({ baseMs: 100, extensionMs: 50, maxExtensions: 5, signal: new AbortController().signal, probe: () => ({ active: true as const, detail: 'busy' }) })
    timeout.dispose()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(timeout.expired()).toBe(false)
    expect(timeout.signal.aborted).toBe(false)
  })
})

describe('probeActivity', () => {
  const recordOf = (dir: string): DelegationRecord => ({ progressPath: join(dir, '.dsh', 'delegations', 'dlg-x', 'progress.md') } as DelegationRecord)
  const run = (localAgent?: SubagentRun['localAgent']): SubagentRun => ({ localAgent } as SubagentRun)
  it('reports a live local agent as active', () => {
    expect(probeActivity({ run: () => run({ status: 'running' } as never), record: recordOf(directory()), dshHome: directory(), freshMs: 60_000 })).toMatchObject({ active: true })
  })
  it('reports an idle local agent as inactive without further signals', () => {
    const root = directory()
    expect(probeActivity({ run: () => run({ status: 'idle' } as never), record: recordOf(directory()), dshHome: root, freshMs: 60_000 })).toMatchObject({ active: false })
  })
  it('treats a fresh session-store write as activity', () => {
    const home = directory()
    const sessions = join(home, 'sessions')
    mkdirSync(sessions, { recursive: true })
    const log = join(sessions, 'child.jsonl')
    writeFileSync(log, '')
    utimesSync(log, new Date(), new Date())
    expect(probeActivity({ run: () => run(), record: recordOf(directory()), dshHome: home, freshMs: 60_000 })).toMatchObject({ active: true })
  })
  it('ignores a stale session store and plugin-only progress lines', () => {
    const home = directory()
    const sessions = join(home, 'sessions')
    mkdirSync(sessions, { recursive: true })
    const log = join(sessions, 'old.jsonl')
    writeFileSync(log, '')
    utimesSync(log, new Date(Date.now() - 300_000), new Date(Date.now() - 300_000))
    const probe = probeActivity({ run: () => run(), record: recordOf(directory()), dshHome: home, freshMs: 60_000 })
    expect(probe.active).toBe(false)
    expect(probe.detail).toContain('store 300s ago')
    expect(probe.detail).toContain('progress absent')
  })
  it('counts a child checkpoint line as activity even when the store is absent', () => {
    const root = directory()
    const record = recordOf(root)
    mkdirSync(join(root, '.dsh', 'delegations', 'dlg-x'), { recursive: true })
    writeFileSync(record.progressPath, '[init] delegation record created\n- 正在等待对方返回 key…\n')
    const probe = probeActivity({ run: () => run(), record, dshHome: directory(), freshMs: 60_000 })
    expect(probe.active).toBe(true)
    expect(probe.detail).toContain('progress checkpoint')
  })
  it('ignores plugin lifecycle lines (mtime freshness alone is not child activity)', () => {
    const root = directory()
    const record = recordOf(root)
    mkdirSync(join(root, '.dsh', 'delegations', 'dlg-x'), { recursive: true })
    writeFileSync(record.progressPath, '[init] delegation record created\n[session created abc]\n')
    utimesSync(record.progressPath, new Date(), new Date())
    expect(probeActivity({ run: () => run(), record, dshHome: directory(), freshMs: 60_000 }).active).toBe(false)
  })
  it('keeps counting a child checkpoint as active while its mtime stays inside the window', () => {
    const root = directory()
    const record = recordOf(root)
    mkdirSync(join(root, '.dsh', 'delegations', 'dlg-x'), { recursive: true })
    writeFileSync(record.progressPath, '- 步骤一\n')
    utimesSync(record.progressPath, new Date(Date.now() - 30_000), new Date(Date.now() - 30_000))
    const probe = probeActivity({ run: () => run(), record, dshHome: directory(), freshMs: 60_000 })
    expect(probe.active).toBe(true)
    expect(probe.detail).toContain('progress checkpoint 30s ago')
  })
})