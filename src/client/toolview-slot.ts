import type { Catalog } from '../shared/catalog.js'

/**
 * Keyed toolview ownership is async by nature (the wire tool name comes from
 * the host catalog RPC), while DSH's keyed dispatch falls back to the generic
 * tool card for unclaimed keys — and an unregistered slot stays unregistered
 * for the rest of the app session. `armToolviewSlot` therefore keeps trying:
 * a failed catalog fetch is retried with bounded backoff, and every client
 * connection reset (initial connect, host restart, reconnect) re-arms the
 * registration, so a single transient failure can never permanently degrade
 * delegation rows to the plain generic card.
 */
export interface ToolviewSlotHandles {
  /** Fetch the host catalog; rejects on any failure. */
  load: () => Promise<Catalog>
  /** Install the keyed view for a wire tool name; returns a disposal function. */
  register: (toolName: string) => () => void
  /** Subscribe to client connection resets (initial connect included); returns a disposal function. */
  onReset: (listener: () => void) => () => void
  /** Backoff scheduler; defaults to `setTimeout`/`clearTimeout`. */
  schedule?: (delayMs: number, run: () => void) => () => void
  /** Backoff window bounds; defaults to 200ms base doubling up to a 5s cap. */
  retry?: { baseMs: number; maxMs: number }
  /** Failure logging; defaults to a `workspace-chain UI:` console.error prefix. */
  logError?: (error: unknown) => void
}

/** The live arm. Dispose once when the owning plugin fiber unloads. */
export interface ToolviewSlotArm {
  dispose(): void
}

export function armToolviewSlot(handles: ToolviewSlotHandles): ToolviewSlotArm {
  const { load, register, onReset } = handles
  const schedule = handles.schedule ?? ((delayMs, run) => {
    const id = setTimeout(run, delayMs)
    return () => { clearTimeout(id) }
  })
  const { baseMs, maxMs } = handles.retry ?? { baseMs: 200, maxMs: 5000 }
  const logError = handles.logError ?? (error => console.error('workspace-chain UI:', error))
  let disposed = false
  let remove: (() => void) | undefined
  let registeredToolName: string | undefined
  /** Supersedes in-flight loads and pending retries started by older attempts. */
  let generation = 0
  let failures = 0
  let cancelRetry: (() => void) | undefined

  const cancelPending = (): void => {
    cancelRetry?.()
    cancelRetry = undefined
  }

  /** Install — or replace — the keyed registration once the catalog resolves. */
  const apply = (catalog: Catalog): void => {
    if (disposed) return
    if (remove !== undefined && registeredToolName === catalog.toolName) return
    const previous = remove
    remove = undefined
    registeredToolName = undefined
    previous?.()
    remove = register(catalog.toolName)
    registeredToolName = catalog.toolName
    failures = 0
  }

  const arm = async (): Promise<void> => {
    if (disposed) return
    const attempt = ++generation
    try {
      const catalog = await load()
      if (disposed || attempt !== generation) return
      apply(catalog)
    } catch (error) {
      if (disposed || attempt !== generation) return
      logError(error)
      cancelPending()
      failures += 1
      const delay = Math.min(baseMs * 2 ** (failures - 1), maxMs)
      cancelRetry = schedule(delay, () => { void arm() })
    }
  }

  const reset = (): void => {
    // The host (re)connected: its catalog handler may be mounted now, or its
    // config may have changed — supersede any in-flight or pending attempt.
    generation += 1
    cancelPending()
    void arm()
  }

  const offReset = onReset(reset)
  void arm()
  return {
    dispose(): void {
      if (disposed) return
      disposed = true
      offReset()
      cancelPending()
      generation += 1
      remove?.()
      remove = undefined
      registeredToolName = undefined
    },
  }
}