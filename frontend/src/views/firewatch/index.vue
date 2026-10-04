<template>
  <section class="page" data-module="firewatch">
    <header class="page-head">
      <div>
        <h2>火险监测管理</h2>
        <p class="page-desc">维护火险监测点，围绕监测点编号、监测区域、火险等级、风力等级做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记火险监测点</button>
        <button class="btn" type="button" @click="exportRows">导出火险监测清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <section class="panel">
      <header class="panel-head">
        <h3>预警面板</h3>
        <span class="panel-sub">等级只按 正常→蓝→黄→橙→红 顺序推进；解除后此处立即清空，检查站提醒同次撤销</span>
      </header>
      <table class="data-table">
        <thead>
          <tr>
            <th>监测点编号</th>
            <th>监测区域</th>
            <th>当前预警等级</th>
            <th>监测时刻</th>
            <th>检查站提醒</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in warnings" :key="String(item.monitorId)">
            <td>{{ item.monitorCode }}</td>
            <td>{{ item.area }}</td>
            <td>{{ item.level }}</td>
            <td>{{ item.warnedAt }}</td>
            <td>{{ item.acknowledged ? '已复核' : '待复核' }}</td>
            <td class="row-actions">
              <button
                class="link"
                type="button"
                :disabled="busyIds.has(item.monitorId) || item.level === '红色预警'"
                @click="assess(item.monitorId)"
              >
                研判升级
              </button>
              <button
                class="link"
                type="button"
                @click="release(item.monitorId)"
              >
                解除预警
              </button>
            </td>
          </tr>
          <tr v-if="!warnings.length">
            <td colspan="6" class="empty-state">当前没有生效中的预警</td>
          </tr>
        </tbody>
      </table>
    </section>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ cellText(row, column) }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              :disabled="isBusy(row, action)"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无火险监测数据，可先登记火险监测点</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条火险监测记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  assessMonitor,
  firewatchOverview,
  listFirewatch,
  monitorTimeText,
  releaseMonitor,
  remindersForView,
} from '@/api/firewatch-service'
import { downloadEntries, moduleMeta } from '@/api/local-service'
import type { FirewatchViewRow } from '@/data/types'

const meta = moduleMeta('firewatch')
// 监测时间为时刻字段，缺时刻的旧记录按原读数兼容显示「未记录」，其余均为原监测读数，只读不改。
const columns = ["监测点编号", "监测区域", "火险等级", "风力等级", "相对湿度", "气温读数", "监测时间", "监测状态"]
const actions = ["更新等级", "解除预警", "升级预警"]
const statuses = ["正常", "蓝色预警", "黄色预警", "橙色预警", "红色预警"]

const rows = ref<FirewatchViewRow[]>([])
const warnings = ref(remindersForView())
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const busyIds = ref<Set<number>>(new Set())

const stats = ref([
  { label: "监测点数", value: 0 },
  { label: "红色预警数", value: 0 },
  { label: "生效中预警", value: 0 },
])

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => row.status === status).length,
  })),
)

function cellText(row: FirewatchViewRow, column: string): string {
  if (column === '监测时间') {
    return monitorTimeText(row)
  }
  const value = row[column]
  return value === null || value === undefined ? '—' : String(value)
}

function isBusy(row: FirewatchViewRow, action: string): boolean {
  // 研判进行中只锁研判类动作；解除走独立流程，红色预警仍可解除。
  return action !== '解除预警' && busyIds.value.has(Number(row.id))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '火险监测点登记入口尚未接入审批流'
}

async function assess(id: number) {
  if (busyIds.value.has(id)) {
    errorMessage.value = '该监测点正在研判中，已拒绝重复提交'
    return
  }
  errorMessage.value = ''
  busyIds.value.add(id)
  try {
    const result = await assessMonitor(id)
    if (!result.ok) {
      errorMessage.value = result.message
    }
    reload()
  } finally {
    busyIds.value.delete(id)
  }
}

function release(id: number) {
  errorMessage.value = ''
  const result = releaseMonitor(id)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function runAction(action: string, row: FirewatchViewRow) {
  if (action === '解除预警') {
    release(Number(row.id))
    return
  }
  void assess(Number(row.id))
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listFirewatch(filters.value)
    rows.value = payload.items
    total.value = payload.total
    warnings.value = remindersForView()
    const overview = firewatchOverview()
    stats.value = [
      { label: "监测点数", value: payload.total },
      { label: "红色预警数", value: overview.redCount },
      { label: "生效中预警", value: overview.activeCount },
    ]
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '火险监测列表读取失败'
  }
}

onMounted(reload)
</script>
