import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { mention, type Catalog } from '../shared/catalog.js'
export function createWorkspaceSource(load: () => Promise<Catalog>): InputTriggerSource {
  return {
    trigger: '@', name: 'workspace-chain', order: 1,
    async candidates(_session, { query, signal }) {
      const catalog = await load()
      if (signal.aborted) return []
      const search = query.replace(/^workspace\//, '').toLocaleLowerCase()
      return catalog.targets.filter(target => [target.name, target.purpose, ...target.aliases].some(value => value.toLocaleLowerCase().includes(search)))
        .map(target => ({ name: `workspace/${target.name}`, description: target.purpose, icon: 'folder', value: target.name }))
    },
    onPick({ candidate }) {
      if (candidate.value === undefined) return undefined
      const ref = mention(candidate.value)
      return { insert: { source: 'workspace-chain', ref, label: candidate.value, appearance: 'folder', clipboardText: ref } }
    },
    codec: { clipboardText: ref => ref, serialize: async ref => ref },
  }
}
