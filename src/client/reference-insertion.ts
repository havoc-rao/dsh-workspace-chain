import type { InputActions } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { referenceInsert, type ReferenceItem } from '../shared/references.js'

/** Derive the plugin's action boundary from the host's actual public contract. */
export type ReferenceInputActions = Pick<InputActions, 'captureInsertion' | 'insertReference' | 'focus'>
export function insertInputReference(actions: ReferenceInputActions, item: ReferenceItem): boolean {
  // Older running hosts may lack the upgraded actions. Refuse without inserting
  // raw text or using private editor/DOM APIs.
  if (typeof actions.insertReference !== 'function' || typeof actions.focus !== 'function') return false
  const inserted = actions.insertReference(referenceInsert(item), actions.captureInsertion())
  if (inserted) actions.focus()
  return inserted
}
