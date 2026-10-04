<template>
  <section class="page" data-module="checkpoint">
    <header class="page-head">
      <div>
        <h2>防火检查站管理</h2>
        <p class="page-desc">维护防火检查站，围绕站点编号、站点位置、值守人员、检查项目做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记防火检查站</button>
        <button class="btn" type="button" @click="exportRows">导出防火检查站清单</button>
      </div>
    </header>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <!-- 检查站火险提醒：与火险监测同次落库，按监测点去重，异常次数不重复 -->
    <section class="reminder-panel">
      <div class="reminder-head">
        <h3>火险预警检查站提醒</h3>
        <span class="reminder-count">需联动监测点 {{ reminders.length }} 处</span>
      </div>
      <table v-if="reminders.length" class="data-table">
        <thead>
          <tr><th>监测点编号</th><th>监测区域</th><th>火险等级</th><th>检查要求</th></tr>
        </thead>
        <tbody>
          <tr v-for="item in reminders" :key="`rem-${item.pointId}`">
            <td>{{ item.pointCode || '—' }}</td>
            <td>{{ item.area || '—' }}</td>
            <td>{{ item.level }}</td>
            <td>{{ checkpointDemand(item.level) }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">暂无生效火险预警，各检查站按常态检查执行</p>
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
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无防火检查站数据，可先登记防火检查站</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条防火检查站记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listFirewatchReminders,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import type { EntryRow, FirewatchReminder } from '@/data/types'

const meta = moduleMeta('checkpoint')
const columns = ["站点编号", "站点位置", "值守人员", "检查项目", "通行车辆数", "收缴火种数", "值班日期", "运行状态"]
const actions = ["升级检查", "关闭站点", "安排换岗"]
const statuses = ["正常检查", "临时关闭", "升级检查", "等待换岗"]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const filters = ref<Record<string, string>>({})
const reminders = ref<FirewatchReminder[]>([])
const stats = ref([
  { label: '站点总数', value: 0 },
  { label: '正常检查数', value: 0 },
  { label: '联动预警提醒', value: 0 },
])

function checkpointDemand(level: string): string {
  if (level === '红色预警' || level === '橙色预警') {
    return '升级检查：逐车登记、火种一律收缴'
  }
  return '加强巡查：重点时段增派值守'
}

const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  errorMessage.value = '防火检查站登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    reminders.value = listFirewatchReminders()
    // 异常次数按监测点去重后统计，重复研判不会让提醒数累加。
    stats.value = [
      { label: '站点总数', value: payload.total },
      { label: '正常检查数', value: payload.items.filter((row) => row.status === '正常检查').length },
      { label: '联动预警提醒', value: reminders.value.length },
    ]
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '防火检查站列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.reminder-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-left: 4px solid #d92d20;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.reminder-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.reminder-head h3 {
  margin: 0;
  font-size: 15px;
}
.reminder-count {
  font-size: 12px;
  color: #b42318;
}
</style>
