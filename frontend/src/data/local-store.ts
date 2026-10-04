import { SEED_ROWS } from './seed'
import type { EntryRow, FirewatchReminder } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'
// 检查站火险提醒与各业务模块同库存放，保证监测状态和提醒能同次落库、一起退回。
export const FIREWATCH_REMINDER_KEY = 'firewatchReminders'

export type StoreState = Record<string, unknown>

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function asRows(value: unknown): EntryRow[] {
  return Array.isArray(value) ? (value as EntryRow[]) : []
}

/**
 * 读取后的统一规范化：
 * - 历史版本没有提醒集合（缺监测时刻的旧记录也是同理），这里只读兼容，给空集合，不回写。
 * - 结构异常时按空集合处理，保证上层读到的形状永远稳定。
 */
function normalize(parsed: Record<string, unknown>): StoreState {
  const state: StoreState = {}
  for (const [key, value] of Object.entries(SEED_ROWS)) {
    state[key] = Array.isArray(parsed[key]) ? parsed[key] : clone(value)
  }
  state[FIREWATCH_REMINDER_KEY] = asRows(parsed[FIREWATCH_REMINDER_KEY]) as unknown as FirewatchReminder[]
  return state
}

function seedState(): StoreState {
  const state: StoreState = { ...clone(SEED_ROWS) }
  state[FIREWATCH_REMINDER_KEY] = []
  return state
}

function readStorage(): StoreState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return seedState()
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    const fallback = seedState()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    return normalize(JSON.parse(raw) as Record<string, unknown>)
  } catch {
    const fallback = seedState()
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: StoreState | null = null

export function allRows(): StoreState {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return asRows(allRows()[key])
}

export function listReminders(): FirewatchReminder[] {
  return asRows(allRows()[FIREWATCH_REMINDER_KEY]) as unknown as FirewatchReminder[]
}

/**
 * 原子提交：所有集合先校验、合并成一个快照后一次性写入。
 * 序列化或 localStorage 写入任一环节失败，都恢复上一个快照并向上抛错，
 * 不会出现监测状态已变、检查站提醒没落（或反过来）的半成品。
 */
export function commit(patches: Record<string, unknown>): void {
  const previous = allRows()
  const next: StoreState = { ...previous }
  for (const [key, value] of Object.entries(patches)) {
    if (!Array.isArray(value)) {
      throw new Error(`集合 ${key} 的数据结构不合法，已放弃本次提交`)
    }
    next[key] = value
  }
  const serialized = JSON.stringify(next)
  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, serialized)
    } catch (error) {
      cache = previous
      throw error instanceof Error ? error : new Error('数据落库失败，已退回提交前状态')
    }
  }
  cache = JSON.parse(serialized) as StoreState
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  commit({ [key]: rows })
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
