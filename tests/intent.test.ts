import { describe, expect, it } from 'vitest'
import { identifyIntent, intentHint } from '../src/intent.js'
import { mention } from '../src/shared/catalog.js'
const targets = [{ name: 'project-b', purpose: 'backend', aliases: ['后端项目', 'backend'] }, { name: 'docs site', purpose: 'docs', aliases: [] }]
describe('query intent', () => {
  it('recognizes UI references, aliases and multiple targets', () => {
    expect(identifyIntent(`同步后端项目 ${mention('project-b')} 和 ${mention('docs site')}`, [], targets).targets).toEqual(['project-b', 'docs site'])
    expect(identifyIntent('update backend API', [], targets).targets).toEqual(['project-b'])
  })
  it('uses previous user queries for continuation but not unrelated requests', () => {
    const previous = ['Please update @workspace/project-b']
    expect(identifyIntent('继续完成刚才的工作', previous, targets)).toMatchObject({ targets: ['project-b'], inherited: true })
    expect(identifyIntent('Explain this local function', previous, targets).targets).toEqual([])
  })
  it('does not match substrings or silently resolve unknown workspace names', () => {
    expect(identifyIntent('project-backup', [], targets).targets).toEqual([])
    const intent = identifyIntent('@workspace/unknown', ['@workspace/project-b'], targets)
    expect(intent).toEqual({ targets: [], inherited: false, unknown: ['unknown'] })
    expect(intentHint(intent, 'delegate_workspace')).toContain('do not guess')
  })
  it('does not treat session reference labels or encoded payloads as workspace intent', () => {
    const wire = (label: string) => `@[${label}](dsh-session:cHJvamVjdC1i)`
    expect(identifyIntent(wire('backend'), [], targets).targets).toEqual([])
    expect(identifyIntent(wire('@workspace/project-b'), [], targets).targets).toEqual([])
    expect(identifyIntent(wire('继续 backend'), ['@workspace/project-b'], targets).targets).toEqual([])
    expect(identifyIntent(`${wire('backend')} @workspace/${encodeURIComponent('docs site')}`, [], targets).targets).toEqual(['docs site'])
  })
  it('explains upstream context and result integration without unconditional execution', () => {
    const hint = intentHint({ targets: ['project-b'], inherited: false, unknown: [] }, 'delegate_workspace')
    expect(hint).toContain('delegate only when the user requests work')
    expect(hint).toContain('upstream results')
    expect(hint).toContain('integrate')
  })
})
