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

/** 检查站火险提醒：与监测状态同次落库，一个监测点同时刻只有一份。 */
export type FirewatchReminder = {
  id: number
  monitorId: number
  monitorCode: string
  area: string
  level: string
  warnedAt: string
  acknowledged: boolean
}

/** 列表行在规范状态之外附带的研判视图字段，不写回原行、不改原读数。 */
export type FirewatchViewRow = {
  id: number
  status: string
  pending: boolean
  abnormal: boolean
  level: number
  active: boolean
  monitorTimeText: string
  reminder: FirewatchReminder | null
  [field: string]: string | number | boolean | FirewatchReminder | null
}

export type OverviewResult = {
  cards: { label: string; value: number }[]
  modules: { name: string; created: number; pending: number; abnormal: number }[]
}
