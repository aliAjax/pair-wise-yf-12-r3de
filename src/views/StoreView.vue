<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import {
  products,
  upsertProduct,
  removeProduct,
  type Product
} from "../business/catalog";
import {
  ledger,
  today,
  startTodayTimer,
  registerBatch,
  setPromo,
  checkout,
  planSale,
  voidSale,
  saleAmount,
  transferBatch,
  transferableBatches,
  stationCapacity,
  usedSlots,
  freeSlots,
  setStationCapacity,
  daySales,
  daySummary,
  promoBatches,
  batchCountByStatus,
  batchStatus,
  BATCH_STATUS_LABEL,
  daysToExpire,
  unitPrice,
  productInUse,
  productLabel,
  type Batch,
  type CartItem
} from "../business/ledger";
import { stations, stationName } from "../business/stations";

startTodayTimer();

type TabKey = "register" | "batches" | "sales" | "today" | "transfer" | "rules";

const tabs: { key: TabKey; label: string; hint: string }[] = [
  { key: "register", label: "批次登记", hint: "同一商品按保质期分批登记" },
  { key: "batches", label: "批次与折扣", hint: "查批次、贴签降价、过期自动下架" },
  { key: "sales", label: "销售结算", hint: "从最早到期批次扣减" },
  { key: "today", label: "当日销量", hint: "按日汇总，可撤销销售" },
  { key: "transfer", label: "跨站调拨", hint: "整批调出，接收站留货位" },
  { key: "rules", label: "商品规则", hint: "条码、进价与售价" }
];
const activeTab = ref<TabKey>("register");
const flash = ref<{ ok: boolean; text: string } | null>(null);
let flashTimer: number | undefined;
function notify(ok: boolean, text: string) {
  flash.value = { ok, text };
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => (flash.value = null), 4200);
}
function run(result: { ok: boolean; message: string }) {
  notify(result.ok, result.message);
}

/* ---------------- 当前油站 ---------------- */

const currentStationId = ref(stations.value[0]?.id ?? "");
if (!currentStationId.value && stations.value.length) currentStationId.value = stations.value[0].id;

const capacityDraft = ref<number>(stationCapacity(currentStationId.value));
watch(currentStationId, (id) => {
  capacityDraft.value = stationCapacity(id);
});
function saveCapacity() {
  const result = setStationCapacity(currentStationId.value, Number(capacityDraft.value));
  run(result);
  if (result.ok) capacityDraft.value = stationCapacity(currentStationId.value);
}

const stationMetrics = computed(() =>
  currentStationId.value ? batchCountByStatus(currentStationId.value) : { saleable: 0, promo: 0, expired: 0 }
);
const todayStats = computed(() =>
  currentStationId.value ? daySummary(today.value, currentStationId.value) : daySummary(today.value)
);

/* ---------------- 批次登记 ---------------- */

const blankRegister = () => ({
  barcode: "",
  name: "",
  cost: 0,
  qty: 1,
  expireDate: defaultExpire()
});
function defaultExpire() {
  const date = new Date();
  date.setDate(date.getDate() + 7);
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${m}-${d}`;
}
const registerForm = reactive(blankRegister());

function fillByBarcode() {
  const product = products.value.find((item) => item.barcode === registerForm.barcode.trim());
  if (product) {
    registerForm.name = product.name;
    registerForm.cost = product.cost;
    const date = new Date();
    date.setDate(date.getDate() + product.shelfDays);
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    registerForm.expireDate = `${date.getFullYear()}-${m}-${d}`;
  }
}

function submitRegister() {
  const result = registerBatch({
    stationId: currentStationId.value,
    barcode: String(registerForm.barcode),
    name: String(registerForm.name),
    cost: Number(registerForm.cost),
    qty: Number(registerForm.qty),
    expireDate: String(registerForm.expireDate)
  });
  run(result);
  if (result.ok) Object.assign(registerForm, blankRegister());
}

/* ---------------- 批次查询与折扣 ---------------- */

type BatchFilter = "all" | "saleable" | "promo" | "expiring" | "expired";
const batchFilters: { key: BatchFilter; label: string }[] = [
  { key: "all", label: "全部" },
  { key: "saleable", label: "在架可售" },
  { key: "promo", label: "折扣中" },
  { key: "expiring", label: "临期" },
  { key: "expired", label: "已过期下架" }
];
const batchFilter = ref<BatchFilter>("all");
const batchKeyword = ref("");

const stationBatches = computed(() => {
  const keyword = batchKeyword.value.trim();
  return ledger.batches
    .filter((batch) => batch.stationId === currentStationId.value)
    .filter((batch) => {
      switch (batchFilter.value) {
        case "saleable":
          return batch.qty > 0 && batchStatus(batch) !== "expired";
        case "promo":
          return batchStatus(batch) === "promo";
        case "expiring":
          return batchStatus(batch) === "expiring";
        case "expired":
          return batchStatus(batch) === "expired";
        default:
          return true;
      }
    })
    .filter((batch) => !keyword || batch.barcode.includes(keyword) || batch.name.includes(keyword))
    .sort((a, b) => a.expireDate.localeCompare(b.expireDate) || a.createdAt.localeCompare(b.createdAt));
});

const promoDraft = reactive<Record<string, string>>({});
watch(
  stationBatches,
  (list) => {
    for (const batch of list) {
      if (!(batch.id in promoDraft)) {
        promoDraft[batch.id] = batch.promoPrice === null ? "" : String(batch.promoPrice);
      }
    }
  },
  { immediate: true }
);

function applyPromo(batch: Batch) {
  const raw = promoDraft[batch.id];
  if (raw === "" || raw === undefined || raw === null) {
    run(setPromo(batch.id, null));
    return;
  }
  run(setPromo(batch.id, Number(raw)));
  promoDraft[batch.id] = ledger.batches.find((b) => b.id === batch.id)?.promoPrice?.toString() ?? "";
}
function clearPromo(batch: Batch) {
  promoDraft[batch.id] = "";
  run(setPromo(batch.id, null));
}
function expireText(batch: Batch): string {
  const days = daysToExpire(batch);
  if (days < 0) return `已过期 ${-days} 天`;
  if (days === 0) return "今天到期";
  if (days === 1) return "明天到期";
  return `还剩 ${days} 天`;
}

/* ---------------- 销售结算 ---------------- */

const cart = reactive<{ barcode: string; qty: number }[]>([]);
const cartBarcode = ref("");
function addCartLine() {
  const barcode = cartBarcode.value;
  if (!barcode) return;
  const existing = cart.find((line) => line.barcode === barcode);
  if (existing) existing.qty += 1;
  else cart.push({ barcode, qty: 1 });
  cartBarcode.value = "";
}
function removeCartLine(barcode: string) {
  const index = cart.findIndex((line) => line.barcode === barcode);
  if (index >= 0) cart.splice(index, 1);
}
const cartItems = computed<CartItem[]>(() =>
  cart
    .map((line) => {
      const product = products.value.find((item) => item.barcode === line.barcode);
      return { barcode: line.barcode, name: product?.name ?? line.barcode, qty: line.qty };
    })
    .filter((item) => item.qty > 0)
);
const checkoutPlan = computed(() => planSale(currentStationId.value, cartItems.value));
const planTotal = computed(() =>
  checkoutPlan.value.lines.reduce((sum, line) => sum + line.qty * line.unitPrice, 0)
);
function availableQty(barcode: string): number {
  return ledger.batches
    .filter((b) => b.stationId === currentStationId.value && b.barcode === barcode && b.qty > 0 && batchStatus(b) !== "expired")
    .reduce((sum, b) => sum + b.qty, 0);
}
function submitCheckout() {
  const result = checkout(currentStationId.value, cartItems.value);
  run(result);
  if (result.ok) cart.splice(0, cart.length);
}

/* ---------------- 当日销量 ---------------- */

const salesStationFilter = ref<string>("current");
const salesStationId = computed(() =>
  salesStationFilter.value === "all" ? undefined : salesStationFilter.value
);
const todaySales = computed(() => daySales(today.value, salesStationId.value));
const salesSummary = computed(() => daySummary(today.value, salesStationId.value));
function timeText(iso: string): string {
  return new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}
function doVoidSale(saleId: string) {
  if (!window.confirm("确认撤销这笔销售？商品将退回原批次。")) return;
  run(voidSale(saleId));
}

/* ---------------- 跨站调拨 ---------------- */

const transferBatchId = ref("");
const transferTargetId = ref("");
watch(currentStationId, () => {
  transferBatchId.value = "";
  transferTargetId.value = "";
});
const transferable = computed(() => transferableBatches(currentStationId.value));
const transferTargets = computed(() => stations.value.filter((s) => s.id !== currentStationId.value));
const selectedTransferBatch = computed(() =>
  ledger.batches.find((batch) => batch.id === transferBatchId.value)
);
const transferCheck = computed(() =>
  transferBatchId.value && transferTargetId.value
    ? (() => {
        const batch = ledger.batches.find((b) => b.id === transferBatchId.value);
        return batch
          ? { ok: freeSlots(transferTargetId.value) > 0 && batch.qty === batch.receiveQty && batchStatus(batch) !== "expired", message: "" }
          : { ok: false, message: "批次不存在" };
      })()
    : { ok: false, message: "" }
);
function submitTransfer() {
  const result = transferBatch(transferBatchId.value, transferTargetId.value);
  run(result);
  if (result.ok) {
    transferBatchId.value = "";
    transferTargetId.value = "";
  }
}
const transferHistory = computed(() =>
  ledger.transfers
    .filter(
      (t) => t.fromStationId === currentStationId.value || t.toStationId === currentStationId.value
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 8)
);
/* ---------------- 商品规则 ---------------- */

const blankProduct = (): Product => ({ barcode: "", name: "", cost: 0, price: 0, shelfDays: 30 });
const productForm = reactive<Product>(blankProduct());
const editingBarcode = ref<string | null>(null);
function startEditProduct(product: Product) {
  editingBarcode.value = product.barcode;
  Object.assign(productForm, product);
}
function resetProductForm() {
  editingBarcode.value = null;
  Object.assign(productForm, blankProduct());
}
function submitProduct() {
  const result = upsertProduct({ ...productForm });
  run(result);
  if (result.ok) resetProductForm();
}
function deleteProduct(barcode: string) {
  run(removeProduct(barcode, productInUse(barcode)));
}

const promoList = computed(() => promoBatches(currentStationId.value));
</script>

<template>
  <section class="store-page">
    <div class="station-bar panel">
      <div class="station-pick">
        <label>
          当前油站
          <select v-model="currentStationId">
            <option v-for="station in stations" :key="station.id" :value="station.id">
              {{ station.station }}（{{ station.area }}）
            </option>
          </select>
        </label>
        <div class="slot-box">
          <span>货位占用</span>
          <strong>{{ usedSlots(currentStationId) }} / {{ stationCapacity(currentStationId) }}</strong>
          <span class="slot-free">空闲 {{ freeSlots(currentStationId) }}</span>
        </div>
        <div class="capacity-edit">
          <label>
            货位总数
            <input v-model.number="capacityDraft" type="number" min="0" step="1" @keydown.enter="saveCapacity" />
          </label>
          <button type="button" class="secondary" @click="saveCapacity">保存货位</button>
        </div>
      </div>
      <div class="metric-line">
        <article class="metric compact">
          <span>在架批次</span>
          <strong>{{ stationMetrics.saleable }}</strong>
        </article>
        <article class="metric compact">
          <span>折扣批次</span>
          <strong>{{ stationMetrics.promo }}</strong>
        </article>
        <article class="metric compact">
          <span>今日销量（件）</span>
          <strong>{{ todayStats.qty }}</strong>
        </article>
        <article class="metric compact">
          <span>今日销售额</span>
          <strong>¥{{ todayStats.amount.toFixed(2) }}</strong>
        </article>
        <article class="metric compact warn" :class="{ active: stationMetrics.expired > 0 }">
          <span>已过期批次</span>
          <strong>{{ stationMetrics.expired }}</strong>
        </article>
      </div>
    </div>

    <transition name="fade">
      <p v-if="flash" class="flash" :class="flash.ok ? 'ok' : 'err'">{{ flash.text }}</p>
    </transition>

    <nav class="tabs">
      <button
        v-for="tab in tabs"
        :key="tab.key"
        type="button"
        class="tab"
        :class="{ active: activeTab === tab.key }"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
      </button>
    </nav>
    <p class="tab-hint">{{ tabs.find((t) => t.key === activeTab)?.hint }}</p>

    <!-- 批次登记 -->
    <section v-show="activeTab === 'register'" class="panel">
      <h2>登记批次</h2>
      <p class="rule-note">同一商品不同保质期分批登记，数量不再合并；每个批次占 1 个货位。</p>
      <form class="form-grid register-grid" @submit.prevent="submitRegister">
        <label>
          条码
          <input v-model="registerForm.barcode" list="barcode-list" required @change="fillByBarcode" />
          <datalist id="barcode-list">
            <option v-for="product in products" :key="product.barcode" :value="product.barcode">
              {{ product.name }}
            </option>
          </datalist>
        </label>
        <label>
          名称
          <input v-model="registerForm.name" required placeholder="选条码后自动带出" />
        </label>
        <label>
          进价（元）
          <input v-model.number="registerForm.cost" type="number" min="0" step="0.01" required />
        </label>
        <label>
          数量（件）
          <input v-model.number="registerForm.qty" type="number" min="1" step="1" required />
        </label>
        <label>
          到期日
          <input v-model="registerForm.expireDate" type="date" :min="today" required />
        </label>
        <button type="submit" class="submit-wide">登记批次</button>
      </form>
    </section>

    <!-- 批次与折扣 -->
    <section v-show="activeTab === 'batches'" class="panel">
      <div class="toolbar">
        <h2>批次台账</h2>
        <div class="filters-inline">
          <button
            v-for="item in batchFilters"
            :key="item.key"
            type="button"
            class="chip"
            :class="{ active: batchFilter === item.key }"
            @click="batchFilter = item.key"
          >
            {{ item.label }}
          </button>
          <input v-model="batchKeyword" class="search-input" placeholder="搜条码 / 名称" />
        </div>
      </div>

      <div v-if="promoList.length" class="promo-strip">
        <span class="strip-title">当前折扣：</span>
        <span v-for="batch in promoList" :key="batch.id" class="promo-tag">
          {{ batch.name }} ¥{{ batch.promoPrice?.toFixed(2) }}（{{ expireText(batch) }}）
        </span>
      </div>

      <div class="table-wrap">
        <table class="ledger-table">
          <thead>
            <tr>
              <th>条码</th>
              <th>名称</th>
              <th>剩余/登记</th>
              <th>进价</th>
              <th>现价</th>
              <th>到期日</th>
              <th>状态</th>
              <th>贴签折扣（≥进价）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="stationBatches.length === 0">
              <td colspan="8" class="empty-cell">暂无匹配批次</td>
            </tr>
            <tr v-for="batch in stationBatches" :key="batch.id" :class="['row-' + batchStatus(batch)]">
              <td>{{ batch.barcode }}</td>
              <td>{{ batch.name }}</td>
              <td>{{ batch.qty }} / {{ batch.receiveQty }}</td>
              <td>¥{{ batch.cost.toFixed(2) }}</td>
              <td>¥{{ unitPrice(batch).toFixed(2) }}</td>
              <td>
                {{ batch.expireDate }}
                <span class="expire-sub">{{ expireText(batch) }}</span>
              </td>
              <td>
                <span class="status" :class="'st-' + batchStatus(batch)">
                  {{ BATCH_STATUS_LABEL[batchStatus(batch)] }}
                </span>
              </td>
              <td>
                <div v-if="batchStatus(batch) !== 'expired'" class="promo-edit">
                  <input
                    v-model="promoDraft[batch.id]"
                    type="number"
                    :min="batch.cost"
                    step="0.1"
                    class="promo-input"
                    :placeholder="`最低 ¥${batch.cost.toFixed(2)}`"
                  />
                  <button type="button" class="mini" @click="applyPromo(batch)">贴签</button>
                  <button type="button" class="mini secondary" @click="clearPromo(batch)">撤签</button>
                </div>
                <span v-else class="muted">已自动下架</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- 销售结算 -->
    <section v-show="activeTab === 'sales'" class="panel">
      <h2>销售结算</h2>
      <p class="rule-note">按 FEFO 从最早到期的在架批次扣减；贴签批次按折扣价结算，过期批次不参与。</p>
      <div class="sales-layout">
        <div>
          <div class="cart-add">
            <select v-model="cartBarcode">
              <option value="" disabled>选择商品加入</option>
              <option
                v-for="product in products"
                :key="product.barcode"
                :value="product.barcode"
                :disabled="availableQty(product.barcode) === 0"
              >
                {{ productLabel(product) }}（在架 {{ availableQty(product.barcode) }} 件）
              </option>
            </select>
            <button type="button" @click="addCartLine">加入</button>
          </div>
          <table class="ledger-table cart-table">
            <thead>
              <tr><th>商品</th><th>数量</th><th>可用</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-if="cart.length === 0"><td colspan="4" class="empty-cell">购物车为空</td></tr>
              <tr v-for="line in cart" :key="line.barcode">
                <td>{{ productLabel(products.find((p) => p.barcode === line.barcode) ?? { barcode: line.barcode, name: line.barcode, cost: 0, price: 0, shelfDays: 0 }) }}</td>
                <td><input v-model.number="line.qty" type="number" min="1" step="1" class="qty-input" /></td>
                <td>{{ availableQty(line.barcode) }}</td>
                <td><button type="button" class="mini danger" @click="removeCartLine(line.barcode)">移除</button></td>
            </tr>
            </tbody>
          </table>
        </div>
        <div class="checkout-box">
          <h3>FEFO 扣减预览</h3>
          <p v-if="!checkoutPlan.ok" class="plan-err">{{ checkoutPlan.message || "请先加入商品" }}</p>
          <ul v-else class="plan-list">
            <li v-for="(line, index) in checkoutPlan.lines" :key="line.batch.id + index">
              <span>{{ line.batch.name }} × {{ line.qty }}</span>
              <span>批次到期 {{ line.batch.expireDate }} · ¥{{ line.unitPrice.toFixed(2) }}</span>
            </li>
          </ul>
          <p class="plan-total">合计：<strong>¥{{ planTotal.toFixed(2) }}</strong></p>
          <button type="button" class="submit-wide" :disabled="!checkoutPlan.ok" @click="submitCheckout">
            确认销售
          </button>
        </div>
      </div>
    </section>

    <!-- 当日销量 -->
    <section v-show="activeTab === 'today'" class="panel">
      <div class="toolbar">
        <h2>当日销量 · {{ today }}</h2>
        <select v-model="salesStationFilter">
          <option value="current">仅当前油站</option>
          <option value="all">全部油站</option>
          <option v-for="station in stations" :key="station.id" :value="station.id">{{ station.station }}</option>
        </select>
      </div>
      <div class="metric-line">
        <article class="metric compact"><span>成交笔数</span><strong>{{ salesSummary.count }}</strong></article>
        <article class="metric compact"><span>销售件数</span><strong>{{ salesSummary.qty }}</strong></article>
        <article class="metric compact"><span>销售额</span><strong>¥{{ salesSummary.amount.toFixed(2) }}</strong></article>
        <article class="metric compact"><span>毛利</span><strong>¥{{ salesSummary.profit.toFixed(2) }}</strong></article>
        <article class="metric compact"><span>已撤销</span><strong>{{ salesSummary.voidedCount }}</strong></article>
      </div>
      <table class="ledger-table">
        <thead>
          <tr><th>时间</th><th>油站</th><th>明细（含批次到期日）</th><th>金额</th><th>状态</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-if="todaySales.length === 0"><td colspan="6" class="empty-cell">今日尚无销售记录</td></tr>
          <tr v-for="sale in todaySales" :key="sale.id" :class="{ voided: sale.voided }">
            <td>{{ timeText(sale.createdAt) }}</td>
            <td>{{ stationName(sale.stationId) }}</td>
            <td class="line-cell">
              <span v-for="(line, i) in sale.lines" :key="i" class="sale-line">
                {{ line.name }} ×{{ line.qty }}（批次{{ line.expireDate }}，¥{{ line.unitPrice.toFixed(2) }}）
              </span>
            </td>
            <td>¥{{ saleAmount(sale).toFixed(2) }}</td>
            <td>
              <span class="status" :class="sale.voided ? 'st-expired' : 'st-normal'">
                {{ sale.voided ? "已撤销" : "正常" }}
              </span>
            </td>
            <td>
              <button v-if="!sale.voided" type="button" class="mini danger" @click="doVoidSale(sale.id)">
                撤销并退回原批次
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- 跨站调拨 -->
    <section v-show="activeTab === 'transfer'" class="panel">
      <h2>跨站调拨</h2>
      <p class="rule-note">只支持整批调拨（未拆零销售）；接收站必须留得出 1 个货位，否则整笔取消、两边库存都保留。</p>
      <div class="transfer-layout">
        <form class="form-grid" @submit.prevent="submitTransfer">
          <label>
            整批可用批次（{{ transferable.length }}）
            <select v-model="transferBatchId" required>
              <option value="" disabled>选择要调出的批次</option>
              <option v-for="batch in transferable" :key="batch.id" :value="batch.id">
                {{ batch.name }} · {{ batch.qty }} 件 · {{ batch.expireDate }} 到期
              </option>
            </select>
          </label>
          <label>
            接收站
            <select v-model="transferTargetId" required>
              <option value="" disabled>选择接收站</option>
              <option v-for="station in transferTargets" :key="station.id" :value="station.id">
                {{ stationName(station.id) }}（空闲货位 {{ freeSlots(station.id) }}/{{ stationCapacity(station.id) }}）
              </option>
            </select>
          </label>
          <p v-if="selectedTransferBatch" class="transfer-info">
            本批 {{ selectedTransferBatch.qty }} 件整批移动，接收站将新占 1 个货位，调出站释放 1 个货位。
          </p>
          <p v-if="transferBatchId && transferTargetId && !transferCheck.ok" class="plan-err">
            接收站货位不足或批次不符合整批条件，调拨不会执行。
          </p>
          <button type="submit" class="submit-wide" :disabled="!transferCheck.ok">确认调拨</button>
        </form>
        <div>
          <h3>本站近期调拨</h3>
          <table class="ledger-table">
            <thead>
              <tr><th>时间</th><th>批次</th><th>方向</th><th>数量</th></tr>
            </thead>
            <tbody>
              <tr v-if="transferHistory.length === 0"><td colspan="4" class="empty-cell">暂无调拨记录</td></tr>
              <tr v-for="item in transferHistory" :key="item.id">
                <td>{{ item.createdAt.slice(0, 16).replace("T", " ") }}</td>
                <td>{{ item.name }}</td>
                <td>
                  <template v-if="item.fromStationId === currentStationId">
                    调出至 {{ stationName(item.toStationId) }}
                  </template>
                  <template v-else>
                    由 {{ stationName(item.fromStationId) }} 调入
                  </template>
                </td>
                <td>{{ item.qty }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- 商品规则 -->
    <section v-show="activeTab === 'rules'" class="panel">
      <h2>{{ editingBarcode ? "编辑商品规则" : "新增商品规则" }}</h2>
      <form class="form-grid rules-form" @submit.prevent="submitProduct">
        <label>
          条码
          <input v-model="productForm.barcode" required :disabled="editingBarcode !== null" placeholder="例如 6901001" />
        </label>
        <label>
          名称
          <input v-model="productForm.name" required />
        </label>
        <label>
          进价（折扣底价）
          <input v-model.number="productForm.cost" type="number" min="0" step="0.01" required />
        </label>
        <label>
          售价
          <input v-model.number="productForm.price" type="number" min="0" step="0.01" required />
        </label>
        <label>
          保质期天数
          <input v-model.number="productForm.shelfDays" type="number" min="1" step="1" required />
        </label>
        <div class="form-actions">
          <button type="submit">{{ editingBarcode ? "保存修改" : "登记商品" }}</button>
          <button v-if="editingBarcode" type="button" class="secondary" @click="resetProductForm">取消编辑</button>
        </div>
      </form>

      <div class="table-wrap" style="margin-top: 18px">
        <table class="ledger-table">
          <thead>
            <tr><th>条码</th><th>名称</th><th>进价</th><th>售价</th><th>保质期</th><th>在架批次</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="product in products" :key="product.barcode">
              <td>{{ product.barcode }}</td>
              <td>{{ product.name }}</td>
              <td>¥{{ product.cost.toFixed(2) }}</td>
              <td>¥{{ product.price.toFixed(2) }}</td>
              <td>{{ product.shelfDays }} 天</td>
              <td>{{ ledger.batches.filter((b) => b.barcode === product.barcode && b.qty > 0).length }} 个</td>
              <td class="row-actions">
                <button type="button" class="mini secondary" @click="startEditProduct(product)">编辑</button>
                <button type="button" class="mini danger" @click="deleteProduct(product.barcode)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </section>
</template>
