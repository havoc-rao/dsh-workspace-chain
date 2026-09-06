import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { mention, type Catalog } from '../shared/catalog.js'
import { referenceInsert, workspaceMentions, workspaceReference, type ReferenceItem } from '../shared/references.js'
export function createWorkspaceSource(load: () => Promise<Catalog>, references: () => readonly ReferenceItem[] = () => []): InputTriggerSource {
  return {
    trigger: '@', name: 'workspace-chain', order: 1,
    async candidates(_session, { query, signal }) {
      const catalog = await load()
      if (signal.aborted) return []
      const kind = query.startsWith('session/') ? 'session' : query.startsWith('workspace/') ? 'workspace' : undefined
      const search = query.replace(/^(workspace|session)\//, '').toLocaleLowerCase()
      return [
        ...references().filter(item => (!kind || item.kind === kind) && [item.label, item.description, item.id].some(value => value.toLocaleLowerCase().includes(search)))
          .map(item => ({ name: `${item.kind}/${item.label}`, description: item.description, icon: item.kind === 'workspace' ? 'folder' : 'message-square', value: JSON.stringify({ kind: item.kind, id: item.id }) })),
        ...catalog.targets.filter(target => kind !== 'session' && [target.name, target.purpose, ...target.aliases].some(value => value.toLocaleLowerCase().includes(search)))
          .map(target => ({ name: `workspace/${target.name}`, description: target.purpose, icon: 'folder', value: JSON.stringify({ kind: 'target', id: target.name }) })),
      ]
    },
    onPick({ candidate }) {
      if (candidate.value === undefined) return undefined
      let value: { kind: string; id: string }
      try { value = JSON.parse(candidate.value) } catch { return undefined }
      if (value.kind !== 'target') {
        const item = references().find(item => item.kind === value.kind && item.id === value.id)
        return item ? { insert: referenceInsert(item) } : undefined
      }
      const ref = mention(value.id)
      return { insert: { source: 'workspace-chain', ref, label: value.id, appearance: 'folder', clipboardText: ref } }
    },
    codec: { clipboardText: ref => ref, serialize: async ref => {
      const mention = workspaceMentions(ref).find(item => item.ref === ref)
      if (!mention || mention.label !== undefined) return ref
      const item = references().find(item => item.kind === 'workspace' && item.id === mention.id)
      return item ? workspaceReference(item.id, item.label) : ref
    } },
  }
}
