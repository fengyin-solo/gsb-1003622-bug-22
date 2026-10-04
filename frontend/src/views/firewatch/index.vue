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

    <!-- 预警面板：与列表同源，解除后立即移除，不再残留旧等级 -->
    <section class="warn-panel">
      <div class="warn-panel-head">
        <h3>火险预警面板</h3>
        <span class="warn-panel-count">生效预警 {{ warnings.length }} 处</span>
      </div>
      <table v-if="warnings.length" class="data-table">
        <thead>
          <tr><th>监测点编号</th><th>监测区域</th><th>当前等级</th><th>检查站提醒</th></tr>
        </thead>
        <tbody>
          <tr v-for="row in warnings" :key="`warn-${String(row.id)}`">
            <td>{{ row['监测点编号'] ?? '—' }}</td>
            <td>{{ row['监测区域'] ?? '—' }}</td>
            <td>{{ row.status }}</td>
            <td>{{ reminderOf(Number(row.id))?.level ? `已下发：${reminderOf(Number(row.id))?.level}` : '历史预警兼容展示' }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="empty-state">当前没有生效中的火险预警</p>
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
              class="link"
              type="button"
              :disabled="submitting"
              @click="openDecision(row)"
            >
              更新等级
            </button>
            <button
              class="link"
              type="button"
              :disabled="submitting || !isWarning(row)"
              @click="runDecision(row, '解除预警')"
            >
              解除预警
            </button>
            <button
              class="link"
              type="button"
              :disabled="submitting || isTopLevel(row)"
              @click="runDecision(row, '升级预警')"
            >
              升级预警
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

    <!-- 研判确认：并发第二次提交会被服务层拒绝并提示 -->
    <div v-if="dialog.open" class="modal-mask" @click.self="closeDialog">
      <div class="modal-card">
        <h3>火险等级研判确认</h3>
        <p class="modal-text">监测点：{{ dialog.row?.['监测点编号'] }}（{{ dialog.row?.['监测区域'] }}）</p>
        <p class="modal-text">当前等级：{{ dialog.row?.status }}</p>
        <p class="modal-text">研判后等级：<strong>{{ dialog.nextLevel }}</strong>（按蓝→黄→橙→红顺序推进）</p>
        <p class="modal-text">检查站提醒将与监测状态同次落库，失败一起退回。</p>
        <p v-if="dialog.error" class="error-text">{{ dialog.error }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" :disabled="submitting" @click="closeDialog">取消</button>
          <button class="btn primary" type="button" :disabled="submitting" @click="confirmDecision">
            {{ submitting ? '研判提交中…' : '确认研判' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listFirewatchEntries,
  listFirewatchReminders,
  listFirewatchWarnings,
  moduleMeta,
  submitFirewatchDecision,
} from '@/api/local-service'
import { FIREWATCH_LEVELS, isWarningLevel, levelIndex, type DecisionKind } from '@/data/firewatch'
import type { EntryRow, FirewatchReminder } from '@/data/types'

const meta = moduleMeta('firewatch')
const columns = ["监测点编号", "监测区域", "火险等级", "风力等级", "相对湿度", "气温读数", "监测时间", "监测状态"]
const filterFields = columns.slice(0, 3)
const statuses = FIREWATCH_LEVELS

const rows = ref<EntryRow[]>([])
const warnings = ref<EntryRow[]>([])
const reminders = ref<FirewatchReminder[]>([])
const total = ref(0)
const errorMessage = ref('')
const submitting = ref(false)
const filters = ref<Record<string, string>>({})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const stats = computed(() => {
  const today = new Date().toISOString().slice(0, 10)
  const createdToday = reminders.value.filter((item) => item.createdAt?.slice(0, 10) === today).length
  return [
    { label: '监测点数', value: total.value },
    { label: '红色预警数', value: warnings.value.filter((row) => row.status === '红色预警').length },
    { label: '今日新增预警', value: createdToday },
  ]
})

const dialog = ref<{
  open: boolean
  row: EntryRow | null
  nextLevel: string
  error: string
}>({ open: false, row: null, nextLevel: '', error: '' })

function isWarning(row: EntryRow): boolean {
  return isWarningLevel(String(row.status))
}

function isTopLevel(row: EntryRow): boolean {
  return levelIndex(String(row.status)) >= FIREWATCH_LEVELS.length - 1
}

function reminderOf(pointId: number): FirewatchReminder | undefined {
  return reminders.value.find((item) => item.pointId === pointId)
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

// 「更新等级」= 研判：先确认一次，再提交；并发的第二次提交会被服务层拒绝。
function openDecision(row: EntryRow) {
  if (submitting.value || isTopLevel(row)) {
    return
  }
  const next = FIREWATCH_LEVELS[levelIndex(String(row.status)) + 1]
  dialog.value = { open: true, row, nextLevel: next, error: '' }
}

function closeDialog() {
  if (submitting.value) {
    return
  }
  dialog.value.open = false
  dialog.value.row = null
  dialog.value.error = ''
}

async function confirmDecision() {
  const row = dialog.value.row
  if (!row) {
    return
  }
  const result = await runDecisionAsync(row, '更新等级')
  if (result.ok) {
    closeDialog()
  } else {
    dialog.value.error = result.message
  }
}

async function runDecision(row: EntryRow, kind: DecisionKind) {
  const result = await runDecisionAsync(row, kind)
  if (!result.ok) {
    errorMessage.value = result.message
  }
}

async function runDecisionAsync(
  row: EntryRow,
  kind: DecisionKind,
): Promise<{ ok: boolean; message: string }> {
  errorMessage.value = ''
  submitting.value = true
  try {
    const result = await submitFirewatchDecision(Number(row.id), kind, Number(row.version ?? 0))
    if (result.ok) {
      reload()
    }
    return { ok: result.ok, message: result.message }
  } finally {
    submitting.value = false
  }
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listFirewatchEntries(filters.value)
    rows.value = payload.items
    total.value = payload.total
    warnings.value = listFirewatchWarnings()
    reminders.value = listFirewatchReminders()
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '火险监测列表读取失败'
  }
}

onMounted(reload)
</script>

<style scoped>
.warn-panel {
  background: #fff;
  border: 1px solid var(--border);
  border-left: 4px solid #d92d20;
  border-radius: 8px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.warn-panel-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.warn-panel-head h3 {
  margin: 0;
  font-size: 15px;
}
.warn-panel-count {
  font-size: 12px;
  color: #b42318;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(16, 24, 40, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
}
.modal-card {
  background: #fff;
  border-radius: 10px;
  padding: 18px 20px;
  width: 420px;
  max-width: calc(100vw - 32px);
}
.modal-card h3 {
  margin: 0 0 12px;
  font-size: 16px;
}
.modal-text {
  margin: 6px 0;
  font-size: 13px;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 14px;
}
.link:disabled {
  color: #94a3b8;
  cursor: not-allowed;
}
</style>
