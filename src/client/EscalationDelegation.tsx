/** Approval-detail takeover: the escalation prompt for a sandbox-blocked file edit. */
import { useEffect, useState } from 'react'
import type { OwnerOfResult, PathOwnerView } from '../shared/catalog.js'
import { commandOf, filePathOf, findApprovalCall, type ChatCallLike, type ChatSnapshotLike } from './approval-contract.js'

/** The wire tools whose correlated approval is a file mutation with a `file_path`. */
const FS_MUTATORS = new Set(['edit', 'write'])

/** Approval identity plus the session standard kit members this component actually reads. */
export interface EscalationDelegationProps {
  /** Tool call correlated with the pending approval request. */
  callId: string
  /** Current Session identity. */
  sessionId: string
  /** Selector hook over the current Conversation binding's Chat target. */
  useChat: <T>(selector: (snapshot: ChatSnapshotLike) => T) => T
  /** RPC-backed ownership query; throws on failure. */
  queryOwner: (path: string, sessionId: string) => Promise<OwnerOfResult>
}

const STYLE = `
.dsh-chain-approval { --chain-muted: var(--ds-color-text-secondary, #85858b); --chain-border: var(--ds-color-border, rgba(128,128,128,.2)); --chain-accent: var(--dsw-alias-state-business-primary, var(--ds-color-accent, #4c8dff)); display: block; min-width: 0; border: 1px solid var(--chain-border); border-radius: var(--dsw-row-radius, 8px); overflow: hidden; color: var(--ds-color-text-primary, inherit); font-size: 12px; line-height: 1.55; margin: 0; }
.dsh-chain-approval * { box-sizing: border-box; }
.dsh-chain-approval .chain-ap-head { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border-bottom: 1px solid var(--chain-border); }
.dsh-chain-approval .chain-ap-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.dsh-chain-approval .chain-ap-state { flex: none; color: var(--chain-muted); font-size: 11px; }
.dsh-chain-approval .chain-ap-body { margin: 0; padding: 7px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-chain-approval .chain-ap-actions { display: flex; align-items: center; gap: 6px; padding: 0 10px 8px; }
.dsh-chain-approval button { border: 0; border-radius: 5px; background: color-mix(in srgb, var(--chain-accent) 12%, transparent); color: var(--chain-accent); padding: 4px 9px; cursor: pointer; font: inherit; font-size: 11px; }
.dsh-chain-approval button:hover { background: color-mix(in srgb, var(--chain-accent) 22%, transparent); }
.dsh-chain-approval button:focus-visible { outline: 2px solid var(--chain-accent); outline-offset: 1px; }
.dsh-chain-approval .chain-ap-command { display: block; margin: 0; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; color: var(--ds-color-text-primary, inherit); }
`

function externalOwners(result: OwnerOfResult | undefined): PathOwnerView[] {
  if (result === undefined) return []
  return result.owners.filter(owner => result.current === undefined || owner.root !== result.current.root)
}

function tipFor(result: OwnerOfResult, external: readonly PathOwnerView[]): string {
  if (external.length > 0) {
    const owner = external[0]!
    return owner.delegatable
      ? `该路径属于已登记的另一个工作区 ${JSON.stringify(owner.name)}（${owner.root}）。当前工作区没有此路径的写入权限：可拒绝本次提权，并在对话中说明将该编辑任务委派给该工作区（委派提示已按常规方式注入模型上下文）。`
      : `该路径属于已登记的另一个工作区 ${JSON.stringify(owner.name)}（${owner.root}），但该工作区未配置可用的委派执行器；可继续提权，或取消后人工处理。`
  }
  if (result.current !== undefined && result.owners.length > 0) {
    return `该路径位于当前工作区 ${JSON.stringify(result.current.name)}（${result.current.root}）内 — 正常审批提权即可继续编辑。`
  }
  return '未匹配到已登记的工作区；该路径不在任何已登记工作区内。确需编辑可继续提权，或取消审批。'
}

function delegateInstruction(path: string, owner: PathOwnerView): string {
  return `请将此编辑任务委派给工作区 ${owner.name}（${owner.root}）：路径 ${path} 的修改在当前工作区无写入权限，由目标工作区会话完成该编辑并验证。`
}

export function EscalationDelegation({ callId, useChat, sessionId, queryOwner }: EscalationDelegationProps) {
  const call: ChatCallLike | undefined = typeof useChat === 'function' ? useChat(snapshot => findApprovalCall(snapshot, callId)) : undefined
  const command = commandOf(call)
  const file = filePathOf(call)
  const mutating = file !== undefined && FS_MUTATORS.has(call?.name ?? '')
  const [query, setQuery] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')
  const [result, setResult] = useState<OwnerOfResult | undefined>()
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!mutating || file === undefined) return
    let alive = true
    setQuery('loading')
    setError('')
    queryOwner(file, sessionId).then(
      value => { if (!alive) return; setResult(value); setQuery('done') },
      (failure: unknown) => { if (!alive) return; setError(String(failure)); setQuery('error') },
    )
    return () => { alive = false }
  }, [mutating, file, sessionId, queryOwner, reload])
  const external = externalOwners(result)
  const copy = (): void => {
    if (result === undefined || external.length === 0) return
    const text = delegateInstruction(result.path, external[0]!)
    const done = () => { setCopied(true); setTimeout(() => setCopied(false), 1600) }
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text).then(done, () => {})
    } else done()
  }
  // The shipped command row's parity check: nothing to add for unrelated tools.
  if (!mutating && command === undefined) return null
  return <div className="dsh-chain-approval" aria-label="编辑路径归属">
    <style>{STYLE}</style>
    {command !== undefined
      ? <code className="chain-ap-command" title={command}>{command}</code>
      : <>
        <div className="chain-ap-head">
          <span className="chain-ap-path" title={file}>{file}</span>
          <span className="chain-ap-state" role="status">
            {query === 'loading' ? '正在查询归属…' : query === 'error' ? '查询失败' : query === 'done' ? '已查询归属' : ''}
          </span>
        </div>
        {query === 'error' && <p className="chain-ap-body">归属查询失败：{error}</p>}
        {query === 'done' && result !== undefined && <p className="chain-ap-body">{tipFor(result, external)}</p>}
        {(query === 'done' || query === 'error') && <div className="chain-ap-actions">
          <button type="button" onClick={() => setReload(count => count + 1)}>重新查询</button>
          {query === 'done' && result !== undefined && external.length > 0 && <button type="button" onClick={copy}>{copied ? '已复制委派指令' : '复制委派指令'}</button>}
        </div>}
      </>}
  </div>
}