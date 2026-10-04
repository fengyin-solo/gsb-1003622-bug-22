/** 纯前端数据层的公共类型：与全栈版后端返回的结构保持一致，换回后端时页面不用改。 */

export type EntryRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  [field: string]: string | number | boolean
}

export type ModuleMeta = {
  key: string
  name: string
  entity: string
  desc: string
  fields: string[]
  statuses: string[]
  actions: string[]
  actionTargets: Record<string, string>
  metrics: string[]
}

export type PageResult = {
  items: EntryRow[]
  total: number
  page: number
  size: number
}

export type ActionResult = {
  ok: boolean
  message: string
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}

/** 火险监测点研判结果：携带落库后的新版本，供页面做并发校验。 */
export type FirewatchDecisionResult = {
  ok: boolean
  message: string
  version: number
}

/**
 * 检查站火险提醒：监测点进入预警时同次落库，解除时同次删除。
 * 按监测点幂等：同一监测点在预警期间只保留一条有效提醒，异常次数不重复。
 */
export type FirewatchReminder = {
  /** 与火险监测点 id 一致，天然去重键。 */
  pointId: number
  pointCode: string
  area: string
  /** 提醒时的火险等级（蓝/黄/橙/红），与监测点当前状态同源。 */
  level: string
  createdAt: string
}
