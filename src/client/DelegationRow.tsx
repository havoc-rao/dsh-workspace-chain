import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
export function DelegationRow({ block, inspect }: ToolCallViewProps) {
  const settled = 'kind' in block
  let args: Record<string, unknown> = {}
  try { args = object(JSON.parse((settled ? block.call?.argsRaw : block.argsRaw) ?? '{}')) } catch { /* Streaming arguments may be incomplete. */ }
  const target = typeof args.target === 'string' ? args.target : 'workspace'
  const meta = settled ? object(block.meta) : {}
  const background = typeof meta.jobId === 'string'
  const status = !settled ? 'Delegating…' : block.isError ? 'Delegation failed' : background ? 'Background job started' : 'Result received'
  const output = settled ? block.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : ''
  return <section aria-label={`Workspace delegation: ${target}`} style={{ border: '1px solid var(--border-color, #ddd)', borderRadius: 10, padding: '10px 12px', margin: '6px 0', fontSize: 13 }}>
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
      <strong>↗ {target}</strong><span role="status">{status}</span>
      {inspect && <button type="button" onClick={inspect}>Details</button>}
    </div>
    {background && <p>Job {String(meta.jobId)} · collect with job_output</p>}
    {typeof args.task === 'string' && <details><summary>Delegated task</summary><p style={{ whiteSpace: 'pre-wrap' }}>{args.task}</p></details>}
    {output && <details open={settled && block.isError}><summary>{settled && block.isError ? 'Error details' : 'Result'}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit', maxHeight: 320, overflow: 'auto' }}>{output}</pre></details>}
  </section>
}
