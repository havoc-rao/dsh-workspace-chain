import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Catalog } from '../src/shared/catalog.js'
import { armToolviewSlot } from '../src/client/toolview-slot.js'
const CATALOG: Catalog = { toolName: 'delegate_workspace', targets: [] }

afterEach(() => { vi.useRealTimers() })

describe('armToolviewSlot', () => {
  /** Collect reset listeners like a real event bus; the returned disposer unsubscribes. */
  function captureReset() {
    const listeners: (() => void)[] = []
    const onReset = vi.fn((listener: () => void) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    })
    return { listeners, onReset }
  }
  /** Record registrations and disposals; the disposer records the tool name it removed. */
  function trackRegistrations() {
    const disposed: string[] = []
    const register = vi.fn((toolName: string) => vi.fn(() => { disposed.push(toolName) }))
    return { disposed, register }
  }
  /** Recording wrapper around the faked `setTimeout`, so delays and cancellations are observable. */
  function recordingSchedule() {
    const delays: number[] = []
    const cancelled: number[] = []
    const schedule = (delayMs: number, run: () => void) => {
      delays.push(delayMs)
      const id = setTimeout(run, delayMs)
      return () => { cancelled.push(delayMs); clearTimeout(id) }
    }
    return { delays, cancelled, schedule }
  }

  it('registers once with the catalog tool name and stays registered across same-name resets', async () => {
    vi.useFakeTimers()
    const { listeners, onReset } = captureReset()
    const { disposed, register } = trackRegistrations()
    const load = vi.fn(async () => CATALOG)
    const arm = armToolviewSlot({ load, register, onReset })
    await vi.advanceTimersByTimeAsync(0)
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith('delegate_workspace')
    const disposer = register.mock.results[0]!.value
    listeners[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(register).toHaveBeenCalledTimes(1)
    expect(disposer).not.toHaveBeenCalled()
    expect(disposed).toEqual([])
    arm.dispose()
  })

  it('retries failed loads with exponential backoff and stops once a load succeeds', async () => {
    vi.useFakeTimers()
    const { delays, schedule } = recordingSchedule()
    let attempts = 0
    const load = vi.fn(async () => {
      attempts += 1
      if (attempts <= 3) throw new Error('catalog unavailable')
      return CATALOG
    })
    const logError = vi.fn()
    const register = vi.fn(() => () => {})
    const arm = armToolviewSlot({
      load, register, onReset: () => () => {},
      logError, schedule, retry: { baseMs: 200, maxMs: 5000 },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(logError).toHaveBeenCalledTimes(1)
    expect(delays).toEqual([200])
    await vi.advanceTimersByTimeAsync(200)
    expect(logError).toHaveBeenCalledTimes(2)
    expect(delays).toEqual([200, 400])
    await vi.advanceTimersByTimeAsync(400)
    expect(logError).toHaveBeenCalledTimes(3)
    expect(delays).toEqual([200, 400, 800])
    await vi.advanceTimersByTimeAsync(800)
    expect(load).toHaveBeenCalledTimes(4)
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith('delegate_workspace')
    expect(logError).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
    arm.dispose()
  })

  it('caps the retry delay at maxMs', async () => {
    vi.useFakeTimers()
    const { delays, schedule } = recordingSchedule()
    const load = vi.fn(async () => { throw new Error('catalog unavailable') })
    const logError = vi.fn()
    const arm = armToolviewSlot({
      load, register: () => () => {}, onReset: () => () => {},
      logError, schedule, retry: { baseMs: 200, maxMs: 5000 },
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(200 + 400 + 800 + 1600 + 3200 + 5000 + 5000)
    expect(delays.slice(0, 6)).toEqual([200, 400, 800, 1600, 3200, 5000])
    expect(delays.slice(6).every(delay => delay === 5000)).toBe(true)
    expect(logError).toHaveBeenCalledTimes(delays.length)
    arm.dispose()
  })

  it('a reset re-arms and replaces the registration when the tool name changed', async () => {
    vi.useFakeTimers()
    const { listeners, onReset } = captureReset()
    const { disposed, register } = trackRegistrations()
    let toolName = 'delegate_workspace'
    const load = vi.fn(async () => ({ toolName, targets: [] }))
    const arm = armToolviewSlot({ load, register, onReset })
    await vi.advanceTimersByTimeAsync(0)
    expect(register).toHaveBeenCalledWith('delegate_workspace')
    toolName = 'delegate_workspace_v2'
    listeners[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(register).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenLastCalledWith('delegate_workspace_v2')
    expect(disposed).toEqual(['delegate_workspace'])
    arm.dispose()
  })

  it('a reset cancels the pending retry timer of a failed fetch and re-arms fresh', async () => {
    vi.useFakeTimers()
    const { listeners, onReset } = captureReset()
    const { disposed, register } = trackRegistrations()
    const { cancelled, schedule } = recordingSchedule()
    let toolName = 'delegate_workspace'
    let failFirst = true
    const load = vi.fn(async () => {
      if (failFirst) { failFirst = false; throw new Error('first catalog fetch fails') }
      return { toolName, targets: [] }
    })
    const arm = armToolviewSlot({ load, register, onReset, schedule })
    await vi.advanceTimersByTimeAsync(0)
    expect(load).toHaveBeenCalledTimes(1)
    expect(register).not.toHaveBeenCalled()
    expect(cancelled).toEqual([])
    toolName = 'delegate_workspace_v2'
    listeners[0]!()
    await vi.advanceTimersByTimeAsync(0)
    expect(cancelled).toEqual([200])
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith('delegate_workspace_v2')
    expect(disposed).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(register).toHaveBeenCalledTimes(1)
    arm.dispose()
  })

  it('dispose unsubscribes from resets and ignores a late load result', async () => {
    vi.useFakeTimers()
    const { listeners, onReset } = captureReset()
    const { disposed, register } = trackRegistrations()
    let resolveLoad: ((catalog: Catalog) => void) | undefined
    const load = vi.fn(() => new Promise<Catalog>(resolve => { resolveLoad = resolve }))
    const arm = armToolviewSlot({ load, register, onReset })
    expect(load).toHaveBeenCalledTimes(1)
    arm.dispose()
    expect(listeners).toHaveLength(0)
    resolveLoad!(CATALOG)
    await vi.advanceTimersByTimeAsync(0)
    expect(register).not.toHaveBeenCalled()
    expect(disposed).toEqual([])
    expect(load).toHaveBeenCalledTimes(1)
    arm.dispose()
  })

  it('dispose cancels a pending retry timer and no further load happens', async () => {
    vi.useFakeTimers()
    const { cancelled, schedule } = recordingSchedule()
    const load = vi.fn(async () => { throw new Error('catalog unavailable') })
    const arm = armToolviewSlot({
      load, register: () => () => {}, onReset: () => () => {}, schedule,
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(cancelled).toEqual([])
    expect(vi.getTimerCount()).toBe(1)
    arm.dispose()
    expect(cancelled).toEqual([200])
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('discards a stale load result that resolves after a newer arm', async () => {
    vi.useFakeTimers()
    const { listeners, onReset } = captureReset()
    const { disposed, register } = trackRegistrations()
    const resolvers: ((catalog: Catalog) => void)[] = []
    const load = vi.fn(() => new Promise<Catalog>(resolve => { resolvers.push(resolve) }))
    const arm = armToolviewSlot({ load, register, onReset })
    expect(load).toHaveBeenCalledTimes(1)
    listeners[0]!()
    expect(load).toHaveBeenCalledTimes(2)
    resolvers[0]!(CATALOG)
    await vi.advanceTimersByTimeAsync(0)
    expect(register).not.toHaveBeenCalled()
    expect(disposed).toEqual([])
    resolvers[1]!({ toolName: 'delegate_workspace_v2', targets: [] })
    await vi.advanceTimersByTimeAsync(0)
    expect(register).toHaveBeenCalledTimes(1)
    expect(register).toHaveBeenCalledWith('delegate_workspace_v2')
    arm.dispose()
  })
})