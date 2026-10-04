import type { EntryRow, FirewatchReminder } from './types'

/**
 * 火险监测领域规则：监测列表、预警面板、检查站提醒三处共用这一份，
 * 不再让通用动作流各自盲写状态。
 */

// 火险等级只能按这个顺序逐级推进，解除统一回到「正常」。
export const FIREWATCH_LEVELS = ['正常', '蓝色预警', '黄色预警', '橙色预警', '红色预警'] as const

export const FIREWATCH_NORMAL = FIREWATCH_LEVELS[0]
export const FIREWATCH_REMINDER_KEY = 'firewatchReminders'

const STATUS_FIELD = '监测状态'
const CODE_FIELD = '监测点编号'
const AREA_FIELD = '监测区域'
const READ_TIME_FIELD = '监测时间'
// 火险等级/风力/湿度/气温属于「原监测读数」，研判与兼容归一化都不许改。
const READING_FIELDS = ['火险等级', '风力等级', '相对湿度', '气温读数'] as const

/** 是否处于预警态：预警面板与检查站提醒的唯一权威判定。 */
export function isWarningLevel(level: string): boolean {
  return level !== FIREWATCH_NORMAL
}

export function levelIndex(level: string): number {
  const index = FIREWATCH_LEVELS.indexOf(level as (typeof FIREWATCH_LEVELS)[number])
  return index
}

/**
 * 历史记录兼容：
 * - 旧记录没有版本号时按 0 处理，不报错、不丢弃；
 * - 缺「监测时间」的旧记录按原读数兼容：监测时间等业务字段保持原样，一律不回写；
 * - 以当前状态 status 为权威，纠正「监测状态」列、pending、abnormal 的旧值，
 *   只在读取返回的副本上纠正，存储里的原监测读数保持原样。
 */
export function normalizeFirewatchRow(raw: EntryRow): EntryRow {
  const current = levelIndex(String(raw.status)) >= 0 ? String(raw.status) : FIREWATCH_NORMAL
  const row: EntryRow = { ...raw }
  for (const field of READING_FIELDS) {
    // 原监测读数原样保留，即便缺字段也不补占位值。
    if (raw[field] !== undefined) {
      row[field] = raw[field]
    }
  }
  if (raw[READ_TIME_FIELD] === undefined || raw[READ_TIME_FIELD] === '') {
    // 缺监测时刻的旧记录：不补写监测时间，只在状态字段上做读取兼容。
    row[READ_TIME_FIELD] = ''
  }
  row.status = current
  // 「监测状态」列以当前状态为准，解除后列表不会再残留旧等级。
  row[STATUS_FIELD] = current
  row.abnormal = isWarningLevel(current)
  row.pending = isWarningLevel(current)
  const version = typeof raw.version === 'number' ? raw.version : 0
  row.version = version
  return row
}

export function rowVersion(row: EntryRow): number {
  return typeof row.version === 'number' ? row.version : 0
}

/** 缺监测时刻的旧记录：迁移与流转都不回写监测时间。 */
export function hasReadTime(row: EntryRow): boolean {
  return row[READ_TIME_FIELD] !== undefined && row[READ_TIME_FIELD] !== ''
}

/**
 * 纯规则计算：一次研判后监测点与提醒集合应变成什么样。
 * 不碰存储，调用方负责在同一事务里把两者一起落库，失败整体退回。
 */
export type DecisionKind = '升级预警' | '更新等级' | '解除预警'

export type FirewatchTransition = {
  row: EntryRow
  reminders: FirewatchReminder[]
}

export function planFirewatchDecision(
  rawRow: EntryRow,
  reminders: FirewatchReminder[],
  kind: DecisionKind,
  now: string,
): FirewatchTransition {
  const row = normalizeFirewatchRow(rawRow)
  const currentIndex = levelIndex(String(row.status))
  let nextLevel: string

  if (kind === '解除预警') {
    nextLevel = FIREWATCH_NORMAL
  } else {
    // 「更新等级」与「升级预警」都只能按规则顺序推进一级，不能跳级。
    if (currentIndex >= FIREWATCH_LEVELS.length - 1) {
      throw new Error(`监测点已经是「${FIREWATCH_LEVELS[FIREWATCH_LEVELS.length - 1]}」，不能继续升级`)
    }
    nextLevel = FIREWATCH_LEVELS[currentIndex + 1]
  }

  // 监测状态与通用状态同次更新，原监测读数保持原样。
  row.status = nextLevel
  row[STATUS_FIELD] = nextLevel
  row.abnormal = isWarningLevel(nextLevel)
  row.pending = isWarningLevel(nextLevel)
  row.version = rowVersion(row) + 1

  const pointId = Number(row.id)
  const others = reminders.filter((item) => item.pointId !== pointId)
  const nextReminders = isWarningLevel(nextLevel)
    ? [
        ...others,
        {
          pointId,
          pointCode: String(row[CODE_FIELD] ?? ''),
          area: String(row[AREA_FIELD] ?? ''),
          level: nextLevel,
          createdAt: now,
        },
      ]
    : others

  return { row, reminders: nextReminders }
}

/** 检查站提醒读取：兼容存储里可能存在的历史重复项，按监测点去重只留最新一条。 */
export function dedupeReminders(reminders: FirewatchReminder[], rows: EntryRow[]): FirewatchReminder[] {
  const normalized = rows.map(normalizeFirewatchRow)
  const byPoint = new Map<number, FirewatchReminder>()
  for (const item of reminders) {
    const previous = byPoint.get(item.pointId)
    if (!previous || previous.createdAt < item.createdAt) {
      // 同一监测点重复研判只保留最新等级，异常次数不重复显示。
      byPoint.set(item.pointId, item)
    }
  }
  // 兼容历史记录：旧监测点已经处于预警但还没有提醒记录时，按当前等级补一条展示，
  // 只在读侧合成，不回写存储、不改原读数。
  for (const row of normalized) {
    if (!isWarningLevel(String(row.status)) || byPoint.has(Number(row.id))) {
      continue
    }
    byPoint.set(Number(row.id), {
      pointId: Number(row.id),
      pointCode: String(row['监测点编号'] ?? ''),
      area: String(row['监测区域'] ?? ''),
      level: String(row.status),
      createdAt: '',
    })
  }
  return [...byPoint.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
