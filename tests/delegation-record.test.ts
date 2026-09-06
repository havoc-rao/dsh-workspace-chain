import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  appendProgress, classifyDelegation, composeTask, deriveDelegationTitle, finalizeRecord, newDelegationId,
  progressSummary, recordDir, updateSessionIdentity, writeDelegationRecord,
} from '../src/delegation-record.js'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function recordFixture() {
  const workspacePath = mkdtempSync(join(tmpdir(), 'chain-record-')); roots.push(workspacePath)
  const record = writeDelegationRecord({
    delegationId: newDelegationId(), mode: 'local', target: workspacePath, workspacePath,
    parentSessionId: 'parent-1', createdAt: new Date().toISOString(), task: 'Do the thing', timeoutMs: 3000,
  })
  return { workspacePath, record }
}
describe('delegation record', () => {
  it('writes the task book, progress header and resume template under the target workspace', () => {
    const { workspacePath, record } = recordFixture()
    expect(record.dir).toBe(recordDir(workspacePath, record.delegationId))
    expect(existsSync(record.taskPath)).toBe(true)
    expect(existsSync(record.taskJsonPath)).toBe(true)
    expect(existsSync(record.progressPath)).toBe(true)
    expect(existsSync(record.resumePath)).toBe(true)
    const taskBook = JSON.parse(readFileSync(record.taskJsonPath, 'utf8'))
    expect(taskBook).toMatchObject({ delegationId: record.delegationId, mode: 'local', workspacePath, parentSessionId: 'parent-1', task: 'Do the thing', timeoutMs: 3000 })
    expect(taskBook.taskPath).toBe(record.taskPath)
    expect(taskBook.progressPath).toBe(record.progressPath)
    const markdown = readFileSync(record.taskPath, 'utf8')
    expect(markdown).toContain('# 委派任务书')
    expect(markdown).toContain('## 任务原文')
    expect(markdown).toContain('Do the thing')
    expect(markdown).toContain(workspacePath)
    const progress = readFileSync(record.progressPath, 'utf8')
    expect(progress).toContain('# 委派进度')
    expect(progress).toContain('[init] delegation record created')
    const resume = readFileSync(record.resumePath, 'utf8')
    expect(resume).toContain('续跑任务书样例')
    expect(resume).toContain(record.taskPath)
    expect(resume).toContain('delegate_workspace')
  })
  it('records session identity updates into the task book', () => {
    const { record } = recordFixture()
    updateSessionIdentity(record, { sessionId: 'session-child', runId: 'run-1' })
    const taskBook = JSON.parse(readFileSync(record.taskJsonPath, 'utf8'))
    expect(taskBook.sessionId).toBe('session-child')
    expect(taskBook.runId).toBe('run-1')
    expect(readFileSync(record.taskPath, 'utf8')).toContain('session-child')
  })
  it('appends checkpoints, bounds summaries and finalizes with a result line', () => {
    const { record } = recordFixture()
    appendProgress(record, 'read the codebase')
    appendProgress(record, 'implemented feature')
    finalizeRecord(record, 'host-aborted')
    const summary = progressSummary(record, 2)
    expect(summary).toContain('4 checkpoints')
    expect(summary).toContain('implemented feature')
    expect(summary).not.toContain('read the codebase')
    const progress = readFileSync(record.progressPath, 'utf8')
    expect(progress).toContain('[result] host-aborted')
    expect(readFileSync(record.resumePath, 'utf8')).toContain('**host-aborted**')
  })
  it('composes the task envelope with explicit paths and passes plain tasks through', () => {
    const { record } = recordFixture()
    const envelope = composeTask('Implement API', record)
    expect(envelope).toContain(`delegationId=${record.delegationId}`)
    expect(envelope).toContain(record.taskPath)
    expect(envelope).toContain(record.progressPath)
    expect(envelope).toContain('---- 任务原文 ----\nImplement API\n---- 任务结束 ----')
    expect(composeTask('raw', undefined)).toBe('raw')
  })
  it('persists a pinned title in the task book', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'chain-record-')); roots.push(workspacePath)
    const record = writeDelegationRecord({
      delegationId: newDelegationId(), mode: 'local', target: workspacePath, workspacePath,
      parentSessionId: 'parent', createdAt: new Date().toISOString(), task: 'Draw a cat', title: '绘画/画一只猫',
    })
    expect(JSON.parse(readFileSync(record.taskJsonPath, 'utf8')).title).toBe('绘画/画一只猫')
    expect(readFileSync(record.taskPath, 'utf8')).toContain('| 任务标题 | 绘画/画一只猫 |')
  })
  it('derives a short task-only title with first line, stripping and truncation', () => {
    expect(deriveDelegationTitle('画一只猫并提交到远程仓库')).toBe('画一只猫并提交到远程仓库')
    expect(deriveDelegationTitle('改造 cordis.patch.yml 的 !!js config 表达式，然后补 lib/index.js 的 schema 与优先级链，并跑验证')).toBe('改造 cordis.patch.yml 的 !!js config 表达式，然后…')
    expect(deriveDelegationTitle('- 第一行是任务概述\n第二行是细节')).toBe('第一行是任务概述')
    expect(deriveDelegationTitle('/not-a-command')).toBe('not-a-command')
    expect(deriveDelegationTitle('# 标题行\n内容')).toBe('标题行')
    expect(deriveDelegationTitle('   ')).toBe('委派任务')
  })
  it('fails loudly when the record directory cannot be created (caller degrades best-effort)', () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'chain-record-')); roots.push(workspacePath)
    writeFileSync(join(workspacePath, '.dsh'), 'file in the way')
    expect(() => writeDelegationRecord({
      delegationId: newDelegationId(), mode: 'local', target: workspacePath, workspacePath,
      parentSessionId: 'parent', createdAt: new Date().toISOString(), task: 'x',
    })).toThrow()
  })
  it('classifies settlement reasons with the right precedence', () => {
    expect(classifyDelegation({ stopReason: 'aborted', timeout: true, canceled: false })).toBe('timeout')
    expect(classifyDelegation({ stopReason: 'error', timeout: false, canceled: true })).toBe('cancelled')
    expect(classifyDelegation({ stopReason: 'aborted', timeout: false, canceled: false })).toBe('host-reclaim')
    expect(classifyDelegation({ stopReason: 'error', timeout: false, canceled: false })).toBe('crash')
    expect(classifyDelegation({ stopReason: 'completed', timeout: false, canceled: false })).toBe('completed')
    expect(classifyDelegation({ stopReason: 'max-tokens', timeout: false, canceled: false })).toBe('max-tokens')
    expect(classifyDelegation({ stopReason: 'refusal', timeout: false, canceled: false })).toBe('refused')
    expect(classifyDelegation({ stopReason: 'future-reason', timeout: false, canceled: false })).toBe('failed')
    expect(classifyDelegation({ timeout: false, canceled: false, crashed: new Error('boom') })).toBe('crash')
  })
})