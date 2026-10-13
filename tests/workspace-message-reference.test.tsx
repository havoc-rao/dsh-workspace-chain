// @vitest-environment jsdom
import { act, type ComponentProps } from 'react'
import { installWorkspaceReferenceStyle, workspaceReferenceStyle } from '../src/client/workspace-reference-style.js'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
// The published primitives entry is a browser platform bundle, not a Node test module.
// Keep this boundary mocked; host tests own the official icon artwork.
const tooltip = vi.hoisted(() => ({ props: {} as { label: string; delayMs: number; portal: boolean; side: string; maxWidth: number } }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Tooltip: (props: typeof tooltip.props & { children: React.ReactNode }) => { tooltip.props = props; return props.children },
  ReferenceIconRegular: ({ kind, size }: { kind: string; size: number }) => <svg data-reference-kind={kind} width={size} height={size} aria-hidden="true" />,
}))
import { referenceZh, referenceEn, type ReferenceTranslate } from '../src/client/reference-locales.js'
import { workspaceReference, workspaceReferenceIds, workspaceMentions, referenceInsert } from '../src/shared/references.js'
import { referencedTask } from '../src/workspace-hints.js'
import { selectWorkspaceReference, WorkspaceMessageReference } from '../src/client/WorkspaceMessageReference.js'

it('uses composer semantic hover tokens on the whole inline chip without hover geometry changes', () => {
  const css = workspaceReferenceStyle
  const base = css.match(/\[data-ref-chip="workspace"\]\s*\{([^}]+)\}/u)![1]!
  const hover = css.match(/\[data-ref-chip="workspace"\]:hover\s*\{([^}]+)\}/u)![1]!.trim()
  expect(hover).toBe('background: var(--dsw-alias-state-business-tertiary);')
  for (const declaration of ['display: inline;', 'padding: 0 4px;', 'border-radius: var(--dsw-radius-sm);', 'line-height: inherit;', 'vertical-align: baseline;', 'color: var(--dsw-alias-state-business-primary);', 'background: transparent;', 'white-space: inherit;', 'overflow-wrap: anywhere;', 'box-decoration-break: clone;', '-webkit-box-decoration-break: clone;']) expect(base).toContain(declaration)
  expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|inline-flex|nowrap/iu)
})
it('installs the exact CSS once per plugin effect and removes it on disposal', () => {
  const dispose = installWorkspaceReferenceStyle()
  const style = document.head.querySelector('[data-workspace-chain-reference-style]')!
  expect(style.textContent).toBe(workspaceReferenceStyle)
  dispose()
  expect(document.head.querySelector('[data-workspace-chain-reference-style]')).toBeNull()
})
it('persists a Unicode display label separately from workspace identity and extracts the task', async () => {
  const label = '项目 / "测试" 🙂'
  const ref = referenceInsert({ kind: 'workspace', id: 'stable-id', label, description: '' }).ref
  expect(workspaceMentions(ref)).toEqual([{ ref, id: 'stable-id', label }])
  expect(workspaceReferenceIds(`${ref} @workspace-id/stable-id`)).toEqual(['stable-id'])
  expect(referencedTask(`${ref} 给他发送一个你好。`)).toBe('你好')
  expect(selectWorkspaceReference({ token: '@some-file/path' })).toBeNull()
  expect(selectWorkspaceReference({ token: '@workspace-ref/invalid' })).toBeNull()
  expect(selectWorkspaceReference({ token: `${ref} trailing` })).toBeNull()
  expect(selectWorkspaceReference({ token: `${ref}。` })).toBeNull()
  expect(selectWorkspaceReference({ token: '@workspace-id/%ZZ' })).toBeNull()
  expect(selectWorkspaceReference({ token: referenceInsert({ kind: 'session', id: 's1', label: 'Session', description: '' }).ref })).toBeNull()
})

it('renders old IDs using the current workspace name and new references using their saved name after removal', () => {
  const element = document.createElement('div'); document.body.append(element)
  const root = createRoot(element)
  const paint = (token: string, items: unknown[], dictionary = referenceZh) => {
    const matched = selectWorkspaceReference({ token })!
    act(() => root.render(<WorkspaceMessageReference {...{ matched, t: ((key: keyof typeof referenceZh) => dictionary[key]) as ReferenceTranslate, useWorkspaces: (select: (state: unknown) => unknown) => select({ items }) } as unknown as ComponentProps<typeof WorkspaceMessageReference>} />))
  }
  try {
    paint('@workspace-id/stable-id', [{ workspaceId: 'stable-id', title: '当前名称', path: '/project' }])
    expect(element.textContent).toBe('当前名称')
    expect(tooltip.props.label).toBe('@workspace-id/stable-id')
    expect(tooltip.props.delayMs).toBe(500)
    expect(tooltip.props.portal).toBe(true)
    expect(tooltip.props.side).toBe('bottom')
    expect(tooltip.props.maxWidth).toBe(480)
    const chip = element.querySelector('[data-ref-chip="workspace"]')!
    expect(chip.getAttribute('data-ref-chip')).toBe('workspace')
    expect(chip.contains(element.querySelector('svg'))).toBe(true)
    expect(chip.textContent).toBe('当前名称')
    expect(chip.getAttribute('style')).toBeNull()
    expect(element.firstElementChild?.getAttribute('tabindex')).toBe('0')
    paint(workspaceReference('stable-id', '保存的名称'), [])
    expect(element.textContent).toBe('保存的名称')
    paint('@workspace-id/stable-id', [])
    expect(element.textContent).toBe('工作区不可用')
    expect(element.textContent).not.toContain('stable-id')
    expect(element.querySelector('button')).toBeNull()
    expect(element.querySelector('svg')?.getAttribute('data-reference-kind')).toBe('folder')
    expect(element.firstElementChild?.getAttribute('style') ?? '').not.toContain('#4c8dff')
    paint('@workspace-id/stable-id', [], referenceEn)
    expect(element.textContent).toBe('Workspace unavailable')
    expect(tooltip.props.label).toBe('@workspace-id/stable-id')
    const snapshot = '<script>bad()</script> 🙂'
    const token = workspaceReference('stable-id', snapshot)
    paint(token, [])
    expect(element.textContent).toBe(snapshot)
    expect(element.querySelector('script')).toBeNull()
    expect(element.innerHTML).not.toContain(token)
    expect(tooltip.props.label).toBe(token)
    expect(workspaceReferenceIds(token)).toEqual(['stable-id'])
  } finally { act(() => root.unmount()); element.remove() }
})
