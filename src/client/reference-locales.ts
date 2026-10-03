import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

export const REFERENCE_NS = 'workspace-chain.reference'
export const referenceZh = {
  unavailable: '工作区不可用',
  missing: '工作区当前不在列表中',
}
export const referenceEn: Record<keyof typeof referenceZh, string> = {
  unavailable: 'Workspace unavailable',
  missing: 'Workspace is not currently listed',
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'workspace-chain.reference': keyof typeof referenceZh
  }
}
export type ReferenceTranslate = TranslateNS<typeof REFERENCE_NS>
