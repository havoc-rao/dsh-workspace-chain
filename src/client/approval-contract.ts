import type {} from '@deepseek-ai/dsh-client-ui-approval/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'

/** Minimal structural view of one tool-call node in the chat snapshot. */
export interface ChatCallLike {
  readonly callId: string
  readonly name?: string
  readonly argsRaw?: string
}
export interface ChatNodeLike {
  readonly kind?: string
  readonly data?: unknown
}
export interface ChatSnapshotLike {
  readonly nodes: {
    values(): readonly ChatNodeLike[]
  }
}

/** Find the running/settled tool call an approval correlates to, when it is materialized in the loaded window. */
export function findApprovalCall(snapshot: ChatSnapshotLike, callId: string): ChatCallLike | undefined {
  for (const node of snapshot.nodes.values()) {
    if (node.kind !== 'tool-call' || !node.data || typeof node.data !== 'object') continue
    const root = (node.data as { root?: unknown }).root
    if (!root || typeof root !== 'object') continue
    const call = root as ChatCallLike
    if (call.callId === callId) return call
  }
  return undefined
}

/** Extract the shell command from a correlated call's arguments (shipped ApprovalCommand parity). */
export function commandOf(call: ChatCallLike | undefined): string | undefined {
  if (call === undefined) return undefined
  try {
    const args = JSON.parse(call.argsRaw ?? '{}') as Record<string, unknown>
    return typeof args.command === 'string' ? args.command : undefined
  } catch {
    return undefined
  }
}

/** Extract the mutation target path from an edit/write call's arguments. */
export function filePathOf(call: ChatCallLike | undefined): string | undefined {
  if (call === undefined) return undefined
  try {
    const args = JSON.parse(call.argsRaw ?? '{}') as Record<string, unknown>
    const value = args.file_path
    return typeof value === 'string' && value.trim() ? value : undefined
  } catch {
    return undefined
  }
}