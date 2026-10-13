import { useEffect } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { IJobs } from '@deepseek-ai/dsh-api-job-controller/client'
import type { UiWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { DELEGATION_NS } from './delegation-locales.js'
import { delegationStyle } from './delegation-style.js'

export interface DelegationInjected {
  hooks: { delegationJobs: IJobs['state'] }
  watchRows: IJobs['watchRows']
  openSession: UiWorkspace['openSession']
}
export type DelegationRowProps = ToolCallViewProps & InjectFace<DelegationInjected> & PropsLocale<typeof DELEGATION_NS>
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function Chevron() {
  return <svg className="chain-chevron" aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
export function DelegationRow(props: DelegationRowProps) {
  const { t } = props
  const settled = props.phase === 'result'
  let args: Record<string, unknown> = {}
  if (props.phase === 'preparing') {
    // Read during render so the host tracks fields as streaming arguments grow.
    args = Object.fromEntries(['target', 'task', 'session_id'].map(key => [key, props.block.args.text(key)]))
  } else {
    try {
      const raw = props.phase === 'result' ? props.block.call?.argsRaw : props.block.argsRaw
      args = object(JSON.parse(raw ?? '{}'))
    } catch { /* Malformed recorded arguments must not break the row. */ }
  }
  const meta = settled ? object(props.block.meta) : {}
  const target = typeof args.target === 'string' ? args.target : typeof meta.target === 'string' ? meta.target : t('workspace')
  const project = target.replace(/[/\\]+$/u, '').split(/[/\\]/u).at(-1) || target
  const jobId = typeof meta.jobId === 'string' ? meta.jobId : undefined
  const background = jobId !== undefined
  // The framework binds sessionId to the owning conversation, not tool arguments.
  const job = props.useDelegationJobs(state => state.rows[props.sessionId]?.find(row => row.id === jobId))
  useEffect(() => background ? props.watchRows(props.sessionId) : undefined,
    [background, props.sessionId, props.watchRows])
  const failed = settled && props.block.isError
  const delegationId = typeof meta.delegationId === 'string' ? meta.delegationId : undefined
  const checkpoint = typeof meta.checkpointPath === 'string' ? meta.checkpointPath : undefined
  // Background meta is preallocated and never navigation authority. Roster
  // sessionId is published only after Host confirmation, including settled jobs.
  // Failed foreground calls need the new explicit presentation confirmation.
  const confirmedId = background ? job?.sessionId
    : settled && (!failed || meta.sessionConfirmed === true) && typeof meta.sessionId === 'string'
      ? meta.sessionId : undefined
  const sessionId = typeof confirmedId === 'string' && confirmedId.trim() && meta.mode !== 'sdk' ? confirmedId as SessionId : undefined
  const continuing = typeof args.session_id === 'string' ? args.session_id : undefined
  const recordLine = delegationId ? [t('record', { id: delegationId }), checkpoint ? t('checkpoint', { path: checkpoint }) : undefined].filter(Boolean).join(' · ') : undefined
  const sessionLine = sessionId ? t(continuing ? 'returnSession' : 'targetSession', { id: sessionId }) : undefined
  const metaLine = [sessionLine, recordLine].filter(Boolean).join(' · ')
  const jobSettled = job && job.status !== 'running' && job.status !== 'stopping'
  const state = !settled ? 'running' : failed || job?.status === 'failed' ? 'error' : background && !jobSettled ? 'background' : 'complete'
  const status = t(!settled ? 'running' : failed ? 'error' : !background ? 'complete'
    : job?.status === 'completed' ? 'backgroundComplete' : job?.status === 'failed' ? 'backgroundError'
      : job?.status === 'killed' ? 'killed' : job?.status === 'stopping' ? 'stopping' : 'background')
  const output = settled ? props.block.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : ''
  const task = typeof args.task === 'string' ? args.task : ''
  const preview = (text: string) => text.replace(/\s+/gu, ' ').trim()
  return <section className="dsh-chain-task" data-state={state} aria-label={t('label', { project })}>
    <style>{delegationStyle}</style>
    <div className="chain-head">
      <span className="chain-folder"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" /></svg></span>
      <div className="chain-project"><span className="chain-name" title={target}>{project}</span>{project !== target && <span className="chain-path" title={target}>{target}</span>}</div>
      <span className="chain-status" role="status"><span className="chain-dot" aria-hidden="true" />{status}</span>
      {sessionId && <button className="chain-inspect" type="button" onClick={() => props.openSession(sessionId)}>{t('openSession')}</button>}
      {props.inspect && <button className="chain-inspect" type="button" onClick={props.inspect} aria-label={t('inspectLabel')}>{t('inspect')}</button>}
    </div>
    {task && <details className="chain-task"><summary><Chevron /><span className="chain-label">{t('task')}</span><span className="chain-preview">{preview(task)}</span></summary><div className="chain-content">{task}</div></details>}
    {output && (!background || failed) && <details className="chain-result" open={Boolean(failed)}><summary><Chevron /><span className="chain-label">{t(failed ? 'failure' : 'result')}</span><span className="chain-preview">{preview(output)}</span></summary><div className="chain-content">{output}</div></details>}
    {background && !failed && <p className="chain-background">{!jobSettled && t('backgroundHint')}{metaLine ? ` ${metaLine}` : ''}</p>}
    {metaLine && (failed || !background) && <p className="chain-record">{metaLine}</p>}
  </section>
}
