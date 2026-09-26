<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { stations, persistStations, type StationRecord } from "../business/stations";

type Field = {
  key: string;
  label: string;
  type?: "number" | "date" | "select";
  options?: readonly string[];
};

const project = {
  title: "油站网点地图管理",
  subtitle: "维护油站位置、营业状态和库存摘要。",
  formTitle: "新增油站",
  primaryAction: "保存油站",
  entityLabel: "油站",
  statuses: ["营业中", "暂停营业", "库存紧张"],
  filters: ["全部区域", "东区", "西区", "机场线"],
  fields: [
    { key: "station", label: "油站名称" },
    { key: "area", label: "区域", type: "select", options: ["东区", "西区", "机场线"] },
    { key: "stock", label: "库存摘要L", type: "number" },
    { key: "manager", label: "负责人" }
  ],
  metricLabels: ["油站数", "暂停营业", "库存紧张"]
} as const;

const fields = project.fields as readonly Field[];
const statuses = [...project.statuses];

function createBlank() {
  return Object.fromEntries(fields.map((field) => [field.key, field.type === "number" ? 0 : ""]));
}

const records = stations;
const form = reactive<Record<string, string | number>>(createBlank());
const note = ref("");
const filter = ref(project.filters[0]);

const filteredRecords = computed(() => {
  if (filter.value.startsWith("全部")) return records.value;
  return records.value.filter((record) => Object.values(record).includes(filter.value));
});

const metrics = computed(() => {
  const total = records.value.length;
  const paused = records.value.filter((record) => record.status === statuses[1]).length;
  const tight = records.value.filter((record) => record.status === statuses[2]).length;
  const numberValues = records.value.flatMap((record) =>
    fields.filter((field) => field.type === "number").map((field) => Number(record[field.key] || 0))
  );
  const sum = numberValues.reduce((acc, value) => acc + value, 0);
  return [total, paused || sum, tight || Math.round(sum / Math.max(total, 1))];
});

const chartRows = computed(() => statuses.map((status) => ({
  status,
  value: records.value.filter((record) => record.status === status).length
})));

const maxChart = computed(() => Math.max(1, ...chartRows.value.map((row) => row.value)));

function nextStatus(status: string) {
  const index = statuses.indexOf(status);
  return statuses[(index + 1) % statuses.length];
}

function primaryText(record: StationRecord) {
  const first = fields[0];
  const second = fields[1];
  return [record[first.key], record[second.key]].filter(Boolean).join(" / ") || project.entityLabel;
}

function submit() {
  records.value = [
    {
      ...form,
      id: crypto.randomUUID(),
      status: statuses[0],
      notes: note.value || "暂无备注",
      createdAt: new Date().toISOString()
    } as StationRecord,
    ...records.value
  ];
  Object.assign(form, createBlank());
  note.value = "";
  persistStations();
}

function flow(record: StationRecord) {
  record.status = nextStatus(record.status);
  persistStations();
}

function remove(id: string) {
  records.value = records.value.filter((record) => record.id !== id);
  persistStations();
}
</script>

<template>
  <section class="workspace">
    <form class="panel" @submit.prevent="submit">
      <h2>{{ project.formTitle }}</h2>
      <div class="form-grid">
        <label v-for="field in fields" :key="field.key">
          {{ field.label }}
          <select v-if="field.type === 'select'" v-model="form[field.key]" required>
            <option value="">请选择</option>
            <option v-for="option in field.options" :key="option">{{ option }}</option>
          </select>
          <input v-else v-model="form[field.key]" :type="field.type || 'text'" required />
        </label>
        <label>
          备注
          <textarea v-model="note" placeholder="填写处理说明或现场备注" />
        </label>
        <button type="submit">{{ project.primaryAction }}</button>
      </div>
    </form>

    <section class="list-panel">
      <div class="toolbar">
        <h2>{{ project.entityLabel }}列表</h2>
        <select v-model="filter">
          <option v-for="item in project.filters" :key="item">{{ item }}</option>
        </select>
      </div>

      <div class="record-grid">
        <div v-if="filteredRecords.length === 0" class="empty">暂无匹配数据</div>
        <article v-for="record in filteredRecords" :key="record.id" class="record">
          <div class="record-head">
            <p class="record-title">{{ primaryText(record) }}</p>
            <span class="status">{{ record.status }}</span>
          </div>
          <div class="details">
            <span v-for="field in fields" :key="field.key">{{ field.label }}: {{ record[field.key] }}</span>
          </div>
          <p class="note">{{ record.notes }}</p>
          <div class="actions">
            <button type="button" @click="flow(record)">流转状态</button>
            <button class="secondary" type="button" @click="navigator.clipboard?.writeText(primaryText(record))">复制摘要</button>
            <button class="danger" type="button" @click="remove(record.id)">删除</button>
          </div>
        </article>
      </div>

      <div class="mini-chart">
        <div v-for="row in chartRows" :key="row.status" class="bar">
          <span>{{ row.status }}</span>
          <div class="bar-track"><div class="bar-fill" :style="{ width: `${(row.value / maxChart) * 100}%` }" /></div>
          <strong>{{ row.value }}</strong>
        </div>
      </div>
    </section>
  </section>
</template>
