<script setup lang="ts">
// 油站页面：批次柜台。查批次、折扣、当日销量，办理登记、销售、撤销与跨站调拨。
import { computed, reactive, ref, watch } from "vue";
import {
  cancelSale,
  freeSlots,
  listStations,
  registerBatch,
  saleableBatches,
  saleableProducts,
  sellProduct,
  setStationCapacity,
  stationBatches,
  stationCapacity,
  stationSales,
  stationTransfers,
  todaySummary,
  transferBatch,
  usedSlots,
} from "./batchLedger";
import {
  batchStatus,
  discountText,
  round2,
  suggestDiscountRate,
  todayString,
} from "./productRules";

const stations = listStations();
const stationId = ref(stations[0]?.id ?? "");

const message = ref<{ type: "ok" | "err"; text: string } | null>(null);
function show(result: { ok: boolean; message: string }) {
  message.value = { type: result.ok ? "ok" : "err", text: result.message };
}

// ---------- 批次台账 ----------

const ledgerFilter = ref("全部");
const batches = computed(() => stationBatches(stationId.value));
const filteredBatches = computed(() => {
  if (ledgerFilter.value === "全部") return batches.value;
  return batches.value.filter((batch) => batchStatus(batch) === ledgerFilter.value);
});

const activeCount = computed(
  () => batches.value.filter((batch) => batch.quantity > 0 && batchStatus(batch) !== "已过期下架").length
);
const nearCount = computed(
  () => batches.value.filter((batch) => batch.quantity > 0 && batchStatus(batch) === "临期").length
);
const expiredCount = computed(
  () => batches.value.filter((batch) => batchStatus(batch) === "已过期下架").length
);

// ---------- 货位 ----------

const capacityInput = ref(stationCapacity(stationId.value));
const slotsUsed = computed(() => usedSlots(stationId.value));
const slotsFree = computed(() => freeSlots(stationId.value));
watch(stationId, (id) => {
  capacityInput.value = stationCapacity(id);
});
function saveCapacity() {
  setStationCapacity(stationId.value, Number(capacityInput.value) || 1);
  show({ ok: true, message: `货位已调整为 ${stationCapacity(stationId.value)} 个` });
}

// ---------- 登记批次 ----------

const batchForm = reactive({
  barcode: "",
  name: "",
  purchasePrice: 1,
  quantity: 1,
  expiryDate: todayString(),
});
function submitBatch() {
  const result = registerBatch({ stationId: stationId.value, ...batchForm });
  show(result);
  if (result.ok) {
    batchForm.barcode = "";
    batchForm.name = "";
    batchForm.purchasePrice = 1;
    batchForm.quantity = 1;
    batchForm.expiryDate = todayString();
  }
}

// ---------- 销售开单 ----------

const products = computed(() => saleableProducts(stationId.value));
const saleForm = reactive({ barcode: "", quantity: 1, listPrice: 0, discountRate: 1 });
const selectedProduct = computed(
  () => products.value.find((product) => product.barcode === saleForm.barcode) ?? null
);
watch(products, (list) => {
  if (!list.some((product) => product.barcode === saleForm.barcode)) {
    saleForm.barcode = list[0]?.barcode ?? "";
  }
});
watch(
  () => saleForm.barcode,
  (barcode) => {
    const first = saleableBatches(stationId.value, barcode)[0];
    saleForm.discountRate = first ? suggestDiscountRate(first) : 1;
    saleForm.listPrice = selectedProduct.value?.maxPurchasePrice ?? 0;
  },
  { immediate: true }
);
const salePricePreview = computed(() => round2((saleForm.listPrice || 0) * (saleForm.discountRate || 0)));
const saleFloor = computed(() => selectedProduct.value?.maxPurchasePrice ?? 0);
const saleBelowFloor = computed(() => salePricePreview.value > 0 && salePricePreview.value < saleFloor.value);
function submitSale() {
  const result = sellProduct({ stationId: stationId.value, ...saleForm });
  show(result);
  if (result.ok) saleForm.quantity = 1;
}

// ---------- 当日销量与销售记录 ----------

const summary = computed(() => todaySummary(stationId.value));
const todayQty = computed(() => summary.value.reduce((sum, row) => sum + row.quantity, 0));
const todayAmount = computed(() => round2(summary.value.reduce((sum, row) => sum + row.amount, 0)));
const sales = computed(() => stationSales(stationId.value).slice(0, 20));
function undoSale(saleId: string) {
  show(cancelSale(saleId));
}

// ---------- 跨站调拨 ----------

const transferableBatches = computed(() =>
  saleableBatches(stationId.value).filter((batch) => batch.quantity > 0)
);
const transferForm = reactive({ batchId: "", toStationId: "" });
const targetStations = computed(() => stations.filter((station) => station.id !== stationId.value));
const targetFreeSlots = computed(() =>
  transferForm.toStationId ? freeSlots(transferForm.toStationId) : null
);
watch([stationId, transferableBatches], () => {
  if (!transferableBatches.value.some((batch) => batch.id === transferForm.batchId)) {
    transferForm.batchId = transferableBatches.value[0]?.id ?? "";
  }
});
watch(stationId, () => {
  transferForm.toStationId = "";
});
function submitTransfer() {
  if (!transferForm.batchId || !transferForm.toStationId) {
    show({ ok: false, message: "请选择批次和接收站" });
    return;
  }
  show(transferBatch(transferForm.batchId, transferForm.toStationId));
}
const transfers = computed(() => stationTransfers(stationId.value).slice(0, 10));

function timeText(iso: string) {
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}
</script>

<template>
  <section class="batch-page">
    <div class="toolbar">
      <h2>批次柜台</h2>
      <label class="station-picker">
        当前油站
        <select v-model="stationId">
          <option v-for="station in stations" :key="station.id" :value="station.id">
            {{ station.name }}（{{ station.area || "未分区" }}）
          </option>
        </select>
      </label>
    </div>

    <p v-if="message" class="flash" :class="message.type">{{ message.text }}</p>

    <section class="metrics five">
      <article class="metric"><span>在架批次</span><strong>{{ activeCount }}</strong></article>
      <article class="metric"><span>临期批次</span><strong>{{ nearCount }}</strong></article>
      <article class="metric"><span>已过期下架</span><strong>{{ expiredCount }}</strong></article>
      <article class="metric"><span>当日销量（件）</span><strong>{{ todayQty }}</strong></article>
      <article class="metric"><span>当日销售额（元）</span><strong>{{ todayAmount }}</strong></article>
    </section>

    <div class="workspace">
      <div class="side">
        <form class="panel" @submit.prevent="submitBatch">
          <h2>登记批次</h2>
          <div class="form-grid">
            <label>条码<input v-model.trim="batchForm.barcode" required placeholder="如 6901001" /></label>
            <label>名称<input v-model.trim="batchForm.name" required placeholder="商品名称" /></label>
            <label>进价（元）<input v-model.number="batchForm.purchasePrice" type="number" min="0.01" step="0.01" required /></label>
            <label>数量<input v-model.number="batchForm.quantity" type="number" min="1" step="1" required /></label>
            <label>到期日<input v-model="batchForm.expiryDate" type="date" required /></label>
            <button type="submit">登记上架</button>
          </div>
        </form>

        <form class="panel" @submit.prevent="submitSale">
          <h2>销售开单</h2>
          <div class="form-grid">
            <label>
              商品（按最早到期批次扣减）
              <select v-model="saleForm.barcode" required>
                <option value="" disabled>请选择商品</option>
                <option v-for="product in products" :key="product.barcode" :value="product.barcode">
                  {{ product.name }}（可售 {{ product.quantity }} 件，最近到期 {{ product.nearestExpiry }}）
                </option>
              </select>
            </label>
            <label>数量<input v-model.number="saleForm.quantity" type="number" min="1" step="1" required /></label>
            <label>标价（元）<input v-model.number="saleForm.listPrice" type="number" min="0.01" step="0.01" required /></label>
            <label>折扣率（1 为无折扣）<input v-model.number="saleForm.discountRate" type="number" min="0.01" max="1" step="0.05" required /></label>
            <p class="hint" :class="{ warn: saleBelowFloor }">
              实收单价 {{ salePricePreview }} 元，进价底价 {{ saleFloor }} 元，折扣不得低于进价
            </p>
            <button type="submit" :disabled="!selectedProduct || saleBelowFloor">确认销售</button>
          </div>
        </form>

        <form class="panel" @submit.prevent="submitTransfer">
          <h2>跨站调拨（整批）</h2>
          <div class="form-grid">
            <label>
              调出批次
              <select v-model="transferForm.batchId" required>
                <option value="" disabled>请选择批次</option>
                <option v-for="batch in transferableBatches" :key="batch.id" :value="batch.id">
                  {{ batch.name }} × {{ batch.quantity }}（{{ batch.expiryDate }} 到期）
                </option>
              </select>
            </label>
            <label>
              接收站
              <select v-model="transferForm.toStationId" required>
                <option value="" disabled>请选择油站</option>
                <option v-for="station in targetStations" :key="station.id" :value="station.id">
                  {{ station.name }}（剩余货位 {{ freeSlots(station.id) }}）
                </option>
              </select>
            </label>
            <p v-if="targetFreeSlots !== null" class="hint" :class="{ warn: targetFreeSlots < 1 }">
              接收站剩余货位 {{ targetFreeSlots }} 个{{ targetFreeSlots < 1 ? "，调拨将被拒绝并保留双方库存" : "" }}
            </p>
            <button type="submit" :disabled="!transferForm.batchId || !transferForm.toStationId">整批调拨</button>
          </div>
        </form>

        <div class="panel">
          <h2>货位设置</h2>
          <div class="form-grid">
            <p class="hint">本站货位 {{ slotsUsed }} / {{ stationCapacity(stationId) }}，剩余 {{ slotsFree }} 个</p>
            <label>货位总数<input v-model.number="capacityInput" type="number" min="1" step="1" /></label>
            <button type="button" class="secondary" @click="saveCapacity">保存货位</button>
          </div>
        </div>
      </div>

      <div class="main-col">
        <section class="list-panel">
          <div class="toolbar">
            <h2>批次台账</h2>
            <select v-model="ledgerFilter">
              <option>全部</option>
              <option>在架</option>
              <option>临期</option>
              <option>已过期下架</option>
            </select>
          </div>
          <table class="data-table">
            <thead>
              <tr>
                <th>条码</th><th>名称</th><th>进价</th><th>剩余/登记</th>
                <th>到期日</th><th>状态</th><th>建议折扣</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="batch in filteredBatches" :key="batch.id" :class="{ off: batchStatus(batch) === '已过期下架' }">
                <td>{{ batch.barcode }}</td>
                <td>{{ batch.name }}</td>
                <td>{{ batch.purchasePrice }} 元</td>
                <td>{{ batch.quantity }} / {{ batch.initialQuantity }}</td>
                <td>{{ batch.expiryDate }}</td>
                <td><span class="pill" :class="batchStatus(batch)">{{ batchStatus(batch) }}</span></td>
                <td>{{ batchStatus(batch) === '已过期下架' ? "—" : discountText(suggestDiscountRate(batch)) }}</td>
              </tr>
              <tr v-if="filteredBatches.length === 0">
                <td colspan="7" class="empty">暂无批次</td>
              </tr>
            </tbody>
          </table>
        </section>

        <section class="list-panel">
          <div class="toolbar"><h2>当日销量</h2></div>
          <table class="data-table">
            <thead>
              <tr><th>条码</th><th>名称</th><th>销量（件）</th><th>销售额（元）</th></tr>
            </thead>
            <tbody>
              <tr v-for="row in summary" :key="row.barcode">
                <td>{{ row.barcode }}</td>
                <td>{{ row.name }}</td>
                <td>{{ row.quantity }}</td>
                <td>{{ row.amount }}</td>
              </tr>
              <tr v-if="summary.length === 0"><td colspan="4" class="empty">今日暂无销售</td></tr>
            </tbody>
          </table>
        </section>

        <section class="list-panel">
          <div class="toolbar"><h2>销售记录</h2></div>
          <div class="record-grid">
            <div v-if="sales.length === 0" class="empty">暂无销售记录</div>
            <article v-for="sale in sales" :key="sale.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ sale.name }} × {{ sale.quantity }}</p>
                <span class="status" :class="{ canceled: sale.canceled }">{{ sale.canceled ? "已撤销" : "已成交" }}</span>
              </div>
              <div class="details">
                <span>条码：{{ sale.barcode }}</span>
                <span>标价：{{ sale.listPrice }} 元</span>
                <span>折扣：{{ discountText(sale.discountRate) }}</span>
                <span>实收单价：{{ sale.salePrice }} 元</span>
                <span>涉及批次：{{ sale.lines.length }} 个</span>
                <span>时间：{{ timeText(sale.createdAt) }}</span>
              </div>
              <div class="actions">
                <button v-if="!sale.canceled" type="button" class="danger" @click="undoSale(sale.id)">撤销销售（退回原批次）</button>
              </div>
            </article>
          </div>
        </section>

        <section class="list-panel">
          <div class="toolbar"><h2>调拨记录</h2></div>
          <div class="record-grid">
            <div v-if="transfers.length === 0" class="empty">暂无调拨记录</div>
            <article v-for="item in transfers" :key="item.id" class="record">
              <div class="record-head">
                <p class="record-title">{{ item.name }} × {{ item.quantity }}</p>
                <span class="status" :class="{ canceled: item.status === '已拒绝' }">{{ item.status }}</span>
              </div>
              <div class="details">
                <span>{{ item.fromStationId }} → {{ item.toStationId }}</span>
                <span>时间：{{ timeText(item.createdAt) }}</span>
              </div>
              <p class="note">{{ item.reason }}</p>
            </article>
          </div>
        </section>
      </div>
    </div>
  </section>
</template>
