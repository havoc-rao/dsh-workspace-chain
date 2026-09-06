import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Local DSH exposes events; the published runtime exposes snapshotEvents(). */
export function sessionEvents(session: {
  readonly events?: readonly SessionEvent[]
  snapshotEvents?: () => readonly SessionEvent[]
}): readonly SessionEvent[] {
  const events = session.events
  if (Array.isArray(events)) return events
  if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
  throw new Error('DSH session event reader is unavailable')
}
