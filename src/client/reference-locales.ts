import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

export const REFERENCE_NS = 'workspace-chain.reference'
export const referenceZh = {
  unavailable: '工作区不可用',
  missing: '工作区当前不在列表中',
  references: '会话与工作区引用',
  invalidDrop: '无法识别此引用，请从侧栏重新拖入。',
  blockedDrop: '当前无法添加引用，请稍后重试。',
  dropHint: '松开以添加工作区或会话引用',
  dropDescription: '引用将加入当前输入框；引用本身不会执行任务。',
}
export const referenceEn: Record<keyof typeof referenceZh, string> = {
  unavailable: 'Workspace unavailable',
  missing: 'Workspace is not currently listed',
  references: 'Session and workspace references',
  invalidDrop: 'Unknown reference. Drag it again from the sidebar.',
  blockedDrop: 'Cannot add a reference right now. Please retry later.',
  dropHint: 'Drop to add a workspace or session reference',
  dropDescription: 'Adds to the current composer; references do not execute tasks.',
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'workspace-chain.reference': keyof typeof referenceZh
  }
}
export type ReferenceTranslate = TranslateNS<typeof REFERENCE_NS>
