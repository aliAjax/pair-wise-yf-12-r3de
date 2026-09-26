// 批次台账：批次登记、FEFO 销售扣减、撤销退回原批次、跨站整批调拨与当日销量统计。
// 数据保存在浏览器 localStorage，规则判断全部走 productRules。
import { reactive } from "vue";
import {
  fefoOrder,
  isExpired,
  isSameDay,
  localDateString,
  round2,
  todayString,
  validateSalePrice,
  type Batch,
  type SaleLine,
  type SaleRecord,
  type TransferRecord,
} from "./productRules";

const STORAGE_KEY = "hxwlfront-21-batch-ledger";
const STATION_KEY = "hxwlfront-21-station-map"; // 沿用原网点功能的油站数据
const DEFAULT_CAPACITY = 6; // 每站默认批次数货位

export interface StationInfo {
  id: string;
  name: string;
  area: string;
}

interface LedgerState {
  batches: Batch[];
  sales: SaleRecord[];
  transfers: TransferRecord[];
  capacities: Record<string, number>;
}

type Result = { ok: boolean; message: string };

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function seedState(): LedgerState {
  const day = 86400000;
  const expiry = (offsetDays: number) => localDateString(new Date(Date.now() + offsetDays * day));
  const mk = (
    stationId: string,
    barcode: string,
    name: string,
    purchasePrice: number,
    quantity: number,
    expiryOffset: number,
    ageDays = 0
  ): Batch => ({
    id: uid("batch"),
    stationId,
    barcode,
    name,
    purchasePrice,
    quantity,
    initialQuantity: quantity,
    expiryDate: expiry(expiryOffset),
    createdAt: new Date(Date.now() - ageDays * day).toISOString(),
  });
  return {
    capacities: {},
    sales: [],
    transfers: [],
    batches: [
      mk("东区一站", "6901001", "矿泉水 550ml", 1.2, 48, 180, 12),
      mk("东区一站", "6901001", "矿泉水 550ml", 1.1, 24, 30, 2),
      mk("东区一站", "6902002", "吐司面包", 3.5, 12, 2),
      mk("东区一站", "6903003", "卤蛋", 1.5, 20, -1), // 已过期，演示自动下架
      mk("机场快线站", "6901001", "矿泉水 550ml", 1.3, 60, 200),
      mk("机场快线站", "6904004", "能量饮料", 4.5, 30, 90),
    ],
  };
}

function loadState(): LedgerState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as LedgerState;
  } catch {
    // 数据损坏时回到种子数据
  }
  return seedState();
}

const state = reactive<LedgerState>(loadState());

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// ---------- 油站与货位 ----------

export function listStations(): StationInfo[] {
  try {
    const raw = localStorage.getItem(STATION_KEY);
    const records = raw ? (JSON.parse(raw) as Array<Record<string, unknown>>) : [];
    if (Array.isArray(records) && records.length > 0) {
      return records.map((record) => {
        const name = String(record.station ?? "未命名油站");
        return { id: name, name, area: String(record.area ?? "") };
      });
    }
  } catch {
    // 网点数据不可读时使用默认站点
  }
  return [
    { id: "东区一站", name: "东区一站", area: "东区" },
    { id: "机场快线站", name: "机场快线站", area: "机场线" },
  ];
}

export function stationCapacity(stationId: string): number {
  return state.capacities[stationId] ?? DEFAULT_CAPACITY;
}

export function setStationCapacity(stationId: string, capacity: number) {
  state.capacities[stationId] = Math.max(1, Math.floor(capacity));
  persist();
}

/** 在架且有货的批次才占货位；过期批次自动下架不占位。 */
export function usedSlots(stationId: string, today = todayString()): number {
  return state.batches.filter(
    (batch) => batch.stationId === stationId && batch.quantity > 0 && !isExpired(batch, today)
  ).length;
}

export function freeSlots(stationId: string): number {
  return Math.max(0, stationCapacity(stationId) - usedSlots(stationId));
}

// ---------- 批次登记 ----------

export interface RegisterInput {
  stationId: string;
  barcode: string;
  name: string;
  purchasePrice: number;
  quantity: number;
  expiryDate: string;
}

export function registerBatch(input: RegisterInput): Result {
  const barcode = input.barcode.trim();
  const name = input.name.trim();
  if (!barcode || !name) return { ok: false, message: "条码和名称不能为空" };
  if (!(input.purchasePrice > 0)) return { ok: false, message: "进价必须大于 0" };
  if (!Number.isInteger(input.quantity) || input.quantity <= 0)
    return { ok: false, message: "数量必须为正整数" };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.expiryDate))
    return { ok: false, message: "请选择到期日" };
  if (input.expiryDate < todayString())
    return { ok: false, message: "到期日早于今天，批次无法上架" };
  if (freeSlots(input.stationId) < 1)
    return { ok: false, message: "本站货位不足，无法登记新批次" };

  state.batches.push({
    id: uid("batch"),
    stationId: input.stationId,
    barcode,
    name,
    purchasePrice: round2(input.purchasePrice),
    quantity: input.quantity,
    initialQuantity: input.quantity,
    expiryDate: input.expiryDate,
    createdAt: new Date().toISOString(),
  });
  persist();
  return { ok: true, message: `批次已登记上架：${name} × ${input.quantity}` };
}

// ---------- 查询 ----------

export function stationBatches(stationId: string): Batch[] {
  return fefoOrder(state.batches.filter((batch) => batch.stationId === stationId));
}

/** 可售批次：未过期且有库存，按最早到期排序。 */
export function saleableBatches(stationId: string, barcode?: string): Batch[] {
  const today = todayString();
  return fefoOrder(
    state.batches.filter(
      (batch) =>
        batch.stationId === stationId &&
        batch.quantity > 0 &&
        !isExpired(batch, today) &&
        (!barcode || batch.barcode === barcode)
    )
  );
}

export interface SaleableProduct {
  barcode: string;
  name: string;
  quantity: number;
  maxPurchasePrice: number;
  nearestExpiry: string;
}

/** 按条码汇总可售商品，供销售开单选择。 */
export function saleableProducts(stationId: string): SaleableProduct[] {
  const map = new Map<string, SaleableProduct>();
  for (const batch of saleableBatches(stationId)) {
    const row = map.get(batch.barcode) ?? {
      barcode: batch.barcode,
      name: batch.name,
      quantity: 0,
      maxPurchasePrice: 0,
      nearestExpiry: batch.expiryDate,
    };
    row.quantity += batch.quantity;
    row.maxPurchasePrice = Math.max(row.maxPurchasePrice, batch.purchasePrice);
    row.nearestExpiry = row.nearestExpiry < batch.expiryDate ? row.nearestExpiry : batch.expiryDate;
    map.set(batch.barcode, row);
  }
  return [...map.values()];
}

// ---------- 销售（最早到期批次先扣） ----------

export interface SellInput {
  stationId: string;
  barcode: string;
  quantity: number;
  listPrice: number;
  discountRate: number;
}

export function sellProduct(input: SellInput): Result {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0)
    return { ok: false, message: "销售数量必须为正整数" };
  if (!(input.listPrice > 0)) return { ok: false, message: "标价必须大于 0" };
  if (!(input.discountRate > 0) || input.discountRate > 1)
    return { ok: false, message: "折扣率需在 (0, 1] 之间，1 为无折扣" };

  const batches = saleableBatches(input.stationId, input.barcode);
  if (batches.length === 0)
    return { ok: false, message: "无可售批次（缺货或已过期自动下架）" };
  const available = batches.reduce((sum, batch) => sum + batch.quantity, 0);
  if (available < input.quantity)
    return { ok: false, message: `可售库存不足，仅剩 ${available} 件` };

  // FEFO 扣减计划：先算计划再核价，避免部分扣减后才发现折扣违规
  let remain = input.quantity;
  const lines: SaleLine[] = [];
  for (const batch of batches) {
    if (remain <= 0) break;
    const take = Math.min(batch.quantity, remain);
    lines.push({ batchId: batch.id, quantity: take, purchasePrice: batch.purchasePrice });
    remain -= take;
  }

  const salePrice = round2(input.listPrice * input.discountRate);
  const priceError = validateSalePrice(salePrice, lines.map((line) => line.purchasePrice));
  if (priceError) return { ok: false, message: priceError };

  for (const line of lines) {
    const batch = state.batches.find((item) => item.id === line.batchId);
    if (batch) batch.quantity -= line.quantity;
  }
  state.sales.unshift({
    id: uid("sale"),
    stationId: input.stationId,
    barcode: input.barcode,
    name: batches[0].name,
    quantity: input.quantity,
    listPrice: round2(input.listPrice),
    discountRate: input.discountRate,
    salePrice,
    lines,
    canceled: false,
    createdAt: new Date().toISOString(),
  });
  persist();
  return { ok: true, message: `已售 ${input.quantity} 件，实收单价 ${salePrice} 元` };
}

/** 撤销销售：按扣减明细把数量退回原批次。 */
export function cancelSale(saleId: string): Result {
  const sale = state.sales.find((item) => item.id === saleId);
  if (!sale) return { ok: false, message: "销售记录不存在" };
  if (sale.canceled) return { ok: false, message: "该单已撤销过" };
  for (const line of sale.lines) {
    const batch = state.batches.find((item) => item.id === line.batchId);
    if (batch) batch.quantity += line.quantity;
  }
  sale.canceled = true;
  persist();
  return { ok: true, message: "已撤销，商品退回原批次" };
}

// ---------- 跨站调拨（整批可用 + 接收站留货位） ----------

export function transferBatch(batchId: string, toStationId: string): Result {
  const batch = state.batches.find((item) => item.id === batchId);
  if (!batch) return { ok: false, message: "批次不存在" };
  const fromStationId = batch.stationId;

  const record = (status: TransferRecord["status"], reason: string) => {
    state.transfers.unshift({
      id: uid("transfer"),
      batchId,
      barcode: batch.barcode,
      name: batch.name,
      quantity: batch.quantity,
      fromStationId,
      toStationId,
      status,
      reason,
      createdAt: new Date().toISOString(),
    });
    persist();
  };
  const reject = (reason: string): Result => {
    record("已拒绝", reason);
    return { ok: false, message: reason };
  };

  if (fromStationId === toStationId) return reject("调拨目标不能是本站");
  if (batch.quantity <= 0 || isExpired(batch))
    return reject("批次已售罄或过期，不满足整批可用，双方库存保持不变");
  if (freeSlots(toStationId) < 1)
    return reject("接收站货位不足，无法留出货位，双方库存保持不变");

  batch.stationId = toStationId; // 整批移动，批次号不变，撤销销售仍能退回原批次
  record("已调拨", "整批调拨成功");
  return { ok: true, message: `已整批调拨 ${batch.name} × ${batch.quantity} 至 ${toStationId}` };
}

// ---------- 销售与调拨查询 ----------

export function stationSales(stationId: string): SaleRecord[] {
  return state.sales.filter((sale) => sale.stationId === stationId);
}

export function todaySales(stationId: string): SaleRecord[] {
  return state.sales.filter(
    (sale) => sale.stationId === stationId && !sale.canceled && isSameDay(sale.createdAt)
  );
}

export interface TodaySummaryRow {
  barcode: string;
  name: string;
  quantity: number;
  amount: number;
}

/** 当日销量：按条码汇总未撤销的今日销售。 */
export function todaySummary(stationId: string): TodaySummaryRow[] {
  const map = new Map<string, TodaySummaryRow>();
  for (const sale of todaySales(stationId)) {
    const row = map.get(sale.barcode) ?? {
      barcode: sale.barcode,
      name: sale.name,
      quantity: 0,
      amount: 0,
    };
    row.quantity += sale.quantity;
    row.amount = round2(row.amount + sale.quantity * sale.salePrice);
    map.set(sale.barcode, row);
  }
  return [...map.values()];
}

export function stationTransfers(stationId: string): TransferRecord[] {
  return state.transfers.filter(
    (item) => item.fromStationId === stationId || item.toStationId === stationId
  );
}
