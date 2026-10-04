import { MODULE_BY_KEY } from '@/data/modules'
import {
  FIREWATCH_NORMAL,
  FIREWATCH_REMINDER_KEY,
  dedupeReminders,
  isWarningLevel,
  normalizeFirewatchRow,
  planFirewatchDecision,
  rowVersion,
  type DecisionKind,
} from '@/data/firewatch'
import { allRows, commitBlob, listRows, resetRows, saveRows } from '@/data/local-store'
import type {
  ActionResult,
  EntryRow,
  FirewatchDecisionResult,
  FirewatchReminder,
  ModuleMeta,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

const FIREWATCH_KEY = 'firewatch'

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(key: string, id: number, action: string): ActionResult {
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `﻿${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

function readStoredReminders(): FirewatchReminder[] {
  const stored = allRows()[FIREWATCH_REMINDER_KEY]
  return Array.isArray(stored) ? (stored as FirewatchReminder[]) : []
}

/* ── 火险监测：列表、预警面板、检查站提醒三处共用的研判入口 ─────────────────── */

/** 列表读取统一走兼容归一化：旧记录按原读数保留，状态以当前研判结果为权威。 */
export function listFirewatchEntries(filters: Record<string, string> = {}): PageResult {
  const normalized = listRows(FIREWATCH_KEY).map(normalizeFirewatchRow)
  const matched = filterRows(normalized, filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

/** 预警面板：只看当前仍处于预警态的监测点，解除后立即消失，不残留旧等级。 */
export function listFirewatchWarnings(): EntryRow[] {
  return listRows(FIREWATCH_KEY)
    .map(normalizeFirewatchRow)
    .filter((row) => isWarningLevel(String(row.status)))
}

/** 检查站提醒：按监测点幂等，历史重复项在读取时去重，异常次数不重复。 */
export function listFirewatchReminders(): FirewatchReminder[] {
  return dedupeReminders(readStoredReminders(), listRows(FIREWATCH_KEY))
}

// 同一时刻只允许一笔研判提交，并发的第二次直接拒绝。
let firewatchBusy = false

/**
 * 提交一次火险研判：
 * - 等级只能按「蓝→黄→橙→红」顺序逐级推进，解除回到正常；
 * - 带版本号的乐观并发控制，状态已被别人推进时拒绝本次提交；
 * - 在途的第二笔提交直接拒绝；
 * - 监测状态与检查站提醒同次落库，任何一步失败整体退回，原监测读数不动。
 */
export async function submitFirewatchDecision(
  id: number,
  kind: DecisionKind,
  expectedVersion: number,
): Promise<FirewatchDecisionResult> {
  if (firewatchBusy) {
    return {
      ok: false,
      message: '已有一笔火险研判正在提交，请勿并发重复提交',
      version: expectedVersion,
    }
  }
  firewatchBusy = true
  try {
    // 让出一个宏任务：同刻并发的第二笔研判会先在上面的 busy 判断处被拒绝，
    // 本笔随后继续执行，保证两笔并发提交只受理一笔。
    await new Promise((resolve) => setTimeout(resolve, 0))

    const rows = listRows(FIREWATCH_KEY)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的火险监测点`, version: expectedVersion }
    }

    const current = normalizeFirewatchRow(rows[index])
    // 版本号以存储原始值为准：历史记录没有版本号时按 0 处理，
    // 不能用归一化时补出来的值比较，否则旧记录的第二次研判会被误放行。
    const storedVersion = rowVersion(rows[index])
    if (storedVersion !== expectedVersion) {
      return {
        ok: false,
        message: `监测点状态已被其他研判更新（当前「${current.status}」），请刷新列表后再操作`,
        version: storedVersion,
      }
    }

    if (kind === '解除预警' && !isWarningLevel(String(current.status))) {
      return { ok: false, message: '监测点当前不是预警态，无需解除', version: storedVersion }
    }

    let transition
    try {
      transition = planFirewatchDecision(rows[index], readStoredReminders(), kind, new Date().toISOString())
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : '火险等级推进失败',
        version: storedVersion,
      }
    }

    const nextRows = [...rows]
    nextRows[index] = transition.row
    try {
      // 监测点状态 + 监测状态列 + 检查站提醒，一个事务一次性写入。
      // 落库失败由 commitBlob 回滚缓存，这里再把失败结果返回给页面，不抛异常出去。
      commitBlob({
        [FIREWATCH_KEY]: nextRows,
        [FIREWATCH_REMINDER_KEY]: transition.reminders,
      })
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? `研判落库失败，已全部退回：${error.message}` : '研判落库失败，已全部退回',
        version: storedVersion,
      }
    }

    const nextLevel = String(transition.row.status)
    const message =
      kind === '解除预警'
        ? `预警已解除，监测点恢复「${FIREWATCH_NORMAL}」，检查站提醒同步撤销`
        : `火险等级已推进为「${nextLevel}」，检查站提醒同步更新`
    return { ok: true, message, version: rowVersion(transition.row) }
  } finally {
    firewatchBusy = false
  }
}

export function loadOverview(): OverviewResult {
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    let entries = listRows(meta.key)
    if (meta.key === FIREWATCH_KEY) {
      // 火险模块的异常量以当前等级为权威，历史旧标记不再残留。
      entries = entries.map(normalizeFirewatchRow)
    }
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
