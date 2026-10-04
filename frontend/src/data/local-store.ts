import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'forest-fire-patrol:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// 除各模块的 EntryRow[] 外，还会存检查站提醒等衍生表（同事务一起落库）。
type StorageBlob = Record<string, unknown[]>

function readStorage(): StorageBlob {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as StorageBlob
    return { ...fallback, ...parsed }
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

let cache: StorageBlob | null = null

export function allRows(): StorageBlob {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return (allRows()[key] ?? []) as EntryRow[]
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

/**
 * 同事务落库：多个存储键（例如监测点状态与检查站提醒）一次性提交，
 * 任意一步失败都退回提交前的快照，绝不留下「状态改了、提醒没改」的半成品。
 */
export function commitBlob(patch: Record<string, unknown[]>): void {
  const snapshot = cache
  // 先在内存里完整构建，构建过程出错直接抛错，缓存保持原样。
  const next = { ...allRows(), ...patch }
  cache = next
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      // 整个事务只有一次写入；写入失败同样整体回滚。
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    }
  } catch (error) {
    cache = snapshot
    throw error
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}

/** 仅供验收脚本使用：丢弃内存缓存，下次读取重新从 localStorage 装载。 */
export function __evictCacheForTest(): void {
  cache = null
}
