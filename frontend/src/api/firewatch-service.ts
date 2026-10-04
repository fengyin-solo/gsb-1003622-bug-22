import {
  FIREWATCH_REMINDER_KEY,
  commit,
  listReminders,
  listRows,
} from '@/data/local-store'
import { SEED_ROWS } from '@/data/seed'
import type {
  ActionResult,
  EntryRow,
  FirewatchReminder,
  FirewatchViewRow,
} from '@/data/types'

function matchFilters(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

/**
 * 火险研判领域服务：监测列表、预警面板、检查站提醒三处共用同一份规范状态。
 * 规范等级只认监测行的 status，顺序固定，原监测读数（等级/风力/湿度/气温/监测时间）只读不改。
 */
export const FIREWATCH_LEVELS = ['正常', '蓝色预警', '黄色预警', '橙色预警', '红色预警'] as const
export const FIREWATCH_KEY = 'firewatch'

// 同一点位研判进行中的提交锁：第二次并发提交直接拒绝，不排队、不覆盖。
const inflight = new Set<number>()

function levelIndex(status: string): number {
  const index = FIREWATCH_LEVELS.indexOf(status as (typeof FIREWATCH_LEVELS)[number])
  return index < 0 ? 0 : index
}

function nextReminderId(reminders: FirewatchReminder[]): number {
  return reminders.reduce((max, item) => Math.max(max, item.id), 0) + 1
}

/** 旧记录缺监测时刻时按原读数兼容：没有就读「未记录」，不补写、不改原值。 */
export function monitorTimeText(row: { [field: string]: unknown }): string {
  const value = String(row['监测时间'] ?? '').trim()
  return value === '' ? '未记录' : value
}

/**
 * 历史预警记录可能没有独立提醒（旧版本不生成提醒集合）。
 * 这里只在读取侧按当前等级合成，不写库；每个监测点最多合成一份，面板与检查站天然不重复。
 */
export function remindersForView(): FirewatchReminder[] {
  const stored = listReminders()
  const byMonitor = new Map<number, FirewatchReminder>()
  for (const reminder of stored) {
    if (!byMonitor.has(reminder.monitorId)) {
      byMonitor.set(reminder.monitorId, { ...reminder })
    }
  }
  for (const row of listRows(FIREWATCH_KEY)) {
    const level = levelIndex(String(row.status))
    if (level <= 0 || byMonitor.has(Number(row.id))) {
      continue
    }
    byMonitor.set(Number(row.id), {
      id: -Number(row.id),
      monitorId: Number(row.id),
      monitorCode: String(row['监测点编号'] ?? `FIRE-${row.id}`),
      area: String(row['监测区域'] ?? '未登记区域'),
      level: FIREWATCH_LEVELS[level],
      warnedAt: monitorTimeText(row),
      acknowledged: false,
    })
  }
  return [...byMonitor.values()].sort((a, b) => levelIndex(b.level) - levelIndex(a.level))
}

export function listFirewatch(filters: Record<string, string> = {}): {
  items: FirewatchViewRow[]
  total: number
} {
  const reminders = new Map(remindersForView().map((item) => [item.monitorId, item]))
  const items = matchFilters(listRows(FIREWATCH_KEY), filters).map((row) => {
    const level = levelIndex(String(row.status))
    return {
      ...row,
      status: FIREWATCH_LEVELS[level],
      level,
      active: level > 0,
      monitorTimeText: monitorTimeText(row),
      reminder: reminders.get(Number(row.id)) ?? null,
    }
  })
  return { items, total: items.length }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

/**
 * 研判一次：等级只能按 正常→蓝→黄→橙→红 的顺序推进一格。
 * 监测状态与检查站提醒在同一次 commit 落库；任一步失败整体退回，原读数不动。
 */
export async function assessMonitor(id: number): Promise<ActionResult> {
  if (inflight.has(id)) {
    return { ok: false, message: `监测点 ${id} 正在研判中，请勿重复提交` }
  }
  inflight.add(id)
  try {
    const rows = listRows(FIREWATCH_KEY)
    const index = rows.findIndex((row) => Number(row.id) === id)
    if (index < 0) {
      return { ok: false, message: `没有找到编号为 ${id} 的火险监测点` }
    }
    const current = levelIndex(String(rows[index].status))
    if (current >= FIREWATCH_LEVELS.length - 1) {
      return { ok: false, message: '已是红色预警，等级已到顶，不能继续研判升级' }
    }
    const targetLevel = current + 1
    const target = FIREWATCH_LEVELS[targetLevel]
    // 留出研判窗口：窗口内的第二次提交会在入口锁处被拒绝。
    await delay(200)

    const updated: EntryRow = { ...rows[index], status: target }
    const nextRows = [...rows]
    nextRows[index] = updated

    const existing = listReminders()
    let nextReminders: FirewatchReminder[]
    const reminderIndex = existing.findIndex((item) => item.monitorId === id)
    if (reminderIndex >= 0) {
      nextReminders = [...existing]
      nextReminders[reminderIndex] = { ...existing[reminderIndex], level: target }
    } else {
      const reminder: FirewatchReminder = {
        id: nextReminderId(existing.filter((item) => item.id > 0)),
        monitorId: id,
        monitorCode: String(rows[index]['监测点编号'] ?? `FIRE-${id}`),
        area: String(rows[index]['监测区域'] ?? '未登记区域'),
        level: target,
        warnedAt: monitorTimeText(rows[index]),
        acknowledged: false,
      }
      nextReminders = [...existing, reminder]
    }

    try {
      commit({ [FIREWATCH_KEY]: nextRows, [FIREWATCH_REMINDER_KEY]: nextReminders })
    } catch {
      return { ok: false, message: '研判结果落库失败，监测状态与检查站提醒已一起退回' }
    }
    return { ok: true, message: `监测点 ${id} 已研判为「${target}」，检查站提醒同步更新` }
  } finally {
    inflight.delete(id)
  }
}

/** 解除预警：状态回到正常，同点提醒同次删除；失败一起退回。 */
export function releaseMonitor(id: number): ActionResult {
  const rows = listRows(FIREWATCH_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的火险监测点` }
  }
  if (levelIndex(String(rows[index].status)) === 0) {
    return { ok: false, message: '该监测点当前为正常状态，无需解除预警' }
  }
  const nextRows = [...rows]
  nextRows[index] = { ...rows[index], status: FIREWATCH_LEVELS[0] }
  const nextReminders = listReminders().filter((item) => item.monitorId !== id)
  try {
    commit({ [FIREWATCH_KEY]: nextRows, [FIREWATCH_REMINDER_KEY]: nextReminders })
  } catch {
    return { ok: false, message: '解除操作落库失败，监测状态与检查站提醒已一起退回' }
  }
  return { ok: true, message: `监测点 ${id} 已解除预警，检查站提醒同步撤销` }
}

/**
 * 检查站侧复核提醒：幂等确认，已确认过的提醒拒绝第二次提交。
 * 只改提醒确认标记，监测原状态与原读数不动，与监测集合同一次 commit 落库。
 */
export function acknowledgeReminder(monitorId: number): ActionResult {
  const reminders = listReminders()
  const index = reminders.findIndex((item) => item.monitorId === monitorId)
  if (index < 0) {
    return { ok: false, message: '该提醒来自历史记录或已随预警解除，无需复核' }
  }
  if (reminders[index].acknowledged) {
    return { ok: false, message: '该提醒已复核确认，请勿重复提交' }
  }
  const nextReminders = [...reminders]
  nextReminders[index] = { ...reminders[index], acknowledged: true }
  try {
    commit({ [FIREWATCH_REMINDER_KEY]: nextReminders })
  } catch {
    return { ok: false, message: '复核结果落库失败，已退回提交前状态' }
  }
  return { ok: true, message: '检查站提醒已复核确认' }
}

/** 预警面板与运营概览共用的统计：以「监测点」为唯一口径，异常次数不随提醒重复。 */
export function firewatchOverview(): {
  activeCount: number
  pendingCount: number
  abnormalCount: number
  redCount: number
} {
  const views = listFirewatch().items.filter((row) => row.active)
  const reminders = remindersForView()
  return {
    activeCount: views.length,
    pendingCount: reminders.filter((item) => !item.acknowledged).length,
    abnormalCount: views.length,
    redCount: views.filter((row) => row.level === FIREWATCH_LEVELS.length - 1).length,
  }
}

/** 重置监测点：监测集合回到示例数据、提醒集合清空，两者一次提交同落同退。 */
export function resetFirewatch(): void {
  commit({
    [FIREWATCH_KEY]: JSON.parse(JSON.stringify(SEED_ROWS[FIREWATCH_KEY] ?? [])),
    [FIREWATCH_REMINDER_KEY]: [],
  })
}
