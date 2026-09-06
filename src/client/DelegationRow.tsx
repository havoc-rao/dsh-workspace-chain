import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { delegationStyle } from './delegation-style.js'
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function Chevron() {
  return <svg className="chain-chevron" aria-hidden="true" width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="m6 4 4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
}
export function DelegationRow({ block, inspect }: ToolCallViewProps) {
  const settled = 'kind' in block
  let args: Record<string, unknown> = {}
  try { args = object(JSON.parse((settled ? block.call?.argsRaw : block.argsRaw) ?? '{}')) } catch { /* Streaming arguments may be incomplete. */ }
  const meta = settled ? object(block.meta) : {}
  const target = typeof args.target === 'string' ? args.target : typeof meta.target === 'string' ? meta.target : '工作区'
  const project = target.replace(/[/\\]+$/u, '').split(/[/\\]/u).at(-1) || target
  const background = typeof meta.jobId === 'string'
  const failed = settled && block.isError
  const delegationId = typeof meta.delegationId === 'string' ? meta.delegationId : undefined
  const checkpoint = typeof meta.checkpointPath === 'string' ? meta.checkpointPath : undefined
  const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : undefined
  const continuing = typeof args.session_id === 'string' ? args.session_id : undefined
  const recordLine = delegationId ? `委派记录 ${delegationId}${checkpoint ? ` · 进度 ${checkpoint}` : ''}` : undefined
  const sessionLine = continuing
    ? `返回会话 ${continuing}`
    : sessionId ? `目标会话 ${sessionId}` : undefined
  const metaLine = [sessionLine, recordLine].filter(Boolean).join(' · ')
  const state = !settled ? 'running' : failed ? 'error' : background ? 'background' : 'complete'
  const status = !settled ? '正在委派' : failed ? '委派失败' : background ? '后台已启动' : '已返回结果'
  const output = settled ? block.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : ''
  const task = typeof args.task === 'string' ? args.task : ''
  const preview = (text: string) => text.replace(/\s+/gu, ' ').trim()
  return <section className="dsh-chain-task" data-state={state} aria-label={`工作区委派：${project}`}>
    <style>{delegationStyle}</style>
    <div className="chain-head">
      <span className="chain-folder"><svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 4a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" /></svg></span>
      <div className="chain-project"><span className="chain-name" title={target}>{project}</span>{project !== target && <span className="chain-path" title={target}>{target}</span>}</div>
      <span className="chain-status" role="status"><span className="chain-dot" aria-hidden="true" />{status}</span>
      {inspect && <button className="chain-inspect" type="button" onClick={inspect} aria-label="查看委派调用详情">详情</button>}
    </div>
    {task && <details className="chain-task"><summary><Chevron /><span className="chain-label">委派任务</span><span className="chain-preview">{preview(task)}</span></summary><div className="chain-content">{task}</div></details>}
    {output && (!background || failed) && <details className="chain-result" open={Boolean(failed)}><summary><Chevron /><span className="chain-label">{failed ? '失败原因' : '执行结果'}</span><span className="chain-preview">{preview(output)}</span></summary><div className="chain-content">{output}</div></details>}
    {background && !failed && <p className="chain-background">任务已转入后台，完成后由当前对话收取结果。{metaLine ? ` ${metaLine}` : ''}</p>}
    {metaLine && (failed || !background) && <p className="chain-record">{metaLine}</p>}
  </section>
}
