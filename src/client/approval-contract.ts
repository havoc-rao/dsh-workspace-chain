/**
 * Live-profile type shims for the approval-detail slot.
 *
 * The shipping web profile composes `@deepseek-ai/dsh-client-ui-approval`
 * (`conversation.approval.detail` — the optional detail inside a pending
 * escalation-approval card, owner `{ callId }`) and `@deepseek-ai/dsh-client-ui-chat`
 * (the `useChat` member of the session standard kit). This plugin compiles
 * against an older client type surface that predates both, so the two
 * declarations are reproduced here structurally — type-only, erased from the
 * bundle, with the runtime contract owned by the live profile. If a future
 * dependency really brings the authoritative merge, drop this file's
 * `declare module` blocks and keep only the helpers.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Owner currency of the approval-detail seat (ui-approval contract). */
export interface ApprovalDetailOwnerProps {
  /** Tool call correlated with the pending approval request. */
  callId: string
}

/** Minimal structural view of one tool-call node in the chat snapshot. */
export interface ChatCallLike {
  readonly callId: string
  readonly name?: string
  readonly argsRaw?: string
}
export interface ChatNodeLike {
  readonly kind?: string
  readonly data?: { readonly root?: ChatCallLike }
}
export interface ChatSnapshotLike {
  readonly nodes: {
    values(): readonly ChatNodeLike[]
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Optional detail for the Tool call correlated with an approval request. */
    'conversation.approval.detail': {
      kind: 'single'
      scope: 'session'
      owner: ApprovalDetailOwnerProps
    }
  }
  interface SessionStandardProps {
    /** Selector hook over the current Conversation binding's Chat target (ui-chat merge in the live profile). */
    useChat: <T>(selector: (snapshot: ChatSnapshotLike) => T) => T
  }
}

/** Find the running/settled tool call an approval correlates to, when it is materialized in the loaded window. */
export function findApprovalCall(snapshot: ChatSnapshotLike, callId: string): ChatCallLike | undefined {
  for (const node of snapshot.nodes.values()) {
    const root = node.kind === 'tool-call' ? node.data?.root : undefined
    if (root !== undefined && root.callId === callId) return root
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