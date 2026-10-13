import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'

export const DELEGATION_NS = 'workspace-chain.delegation'
export const delegationZh = {
  kind: '工作区委派', workspace: '工作区', label: '工作区委派：{project}', running: '正在委派', error: '委派失败',
  background: '后台已启动', complete: '已返回结果', backgroundComplete: '后台已完成',
  stopping: '后台正在停止', killed: '后台已取消', backgroundError: '后台失败',
  inspect: '详情', inspectLabel: '查看委派调用详情', openSession: '打开目标会话',
  task: '委派任务', failure: '失败原因', result: '执行结果',
  backgroundHint: '任务已转入后台，完成后由当前对话收取结果。',
  record: '委派记录 {id}', checkpoint: '进度 {path}',
  targetSession: '目标会话 {id}', returnSession: '返回会话 {id}',
}
export const delegationEn: Record<keyof typeof delegationZh, string> = {
  kind: 'Workspace delegation', workspace: 'Workspace', label: 'Workspace delegation: {project}', running: 'Delegating', error: 'Delegation failed',
  background: 'Background started', complete: 'Result returned', backgroundComplete: 'Background completed',
  stopping: 'Background stopping', killed: 'Background cancelled', backgroundError: 'Background failed',
  inspect: 'Details', inspectLabel: 'Inspect delegation call', openSession: 'Open target session',
  task: 'Delegated task', failure: 'Failure reason', result: 'Execution result',
  backgroundHint: 'Task is running in the background. This conversation will collect its result.',
  record: 'Delegation record {id}', checkpoint: 'Progress {path}',
  targetSession: 'Target session {id}', returnSession: 'Return to session {id}',
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'workspace-chain.delegation': keyof typeof delegationZh
  }
}
export type DelegationTranslate = TranslateNS<typeof DELEGATION_NS>
