import { reactive, ref } from "vue";
import { products, assertDiscountFloor, ensureProduct, round2, type Product } from "./catalog";
import { stations } from "./stations";

/**
 * 批次台账业务文件
 * - 每站按批次登记：条码、名称、进价、数量、到期日（同一商品不同保质期不再合并库存）
 * - 销售 FEFO：从最早到期的在架批次扣减
 * - 到期批次自动下架（不参与销售/调拨，台账保留可查）
 * - 批次折扣价不得低于进价（规则在 catalog.ts）
 * - 撤销销售把数量退回原批次（哪怕原批次已过期/已被调拨，仍回到该批次）
 * - 跨站调拨必须整批；接收站货位不足则整笔不动，两边库存都保留
 * 数据保存在浏览器 localStorage。
 */

export type BatchStatus = "normal" | "promo" | "expiring" | "expired";

export type Batch = {
  id: string;
  stationId: string;
  barcode: string;
  name: string;
  cost: number;
  /** 剩余可售数量（撤销销售会退回这里） */
  qty: number;
  /** 登记数量，调拨/撤销场景需要"整批"判断时以剩余数量为准 */
  receiveQty: number;
  expireDate: string; // YYYY-MM-DD
  /** 贴纸降价；null 表示无折扣，售价取商品规则 */
  promoPrice: number | null;
  createdAt: string;
};

export type SaleLine = {
  batchId: string;
  stationId: string;
  barcode: string;
  name: string;
  qty: number;
  unitPrice: number;
  cost: number;
  expireDate: string;
};

export type SaleRecord = {
  id: string;
  stationId: string;
  createdAt: string;
  lines: SaleLine[];
  voided: boolean;
};

export type TransferRecord = {
  id: string;
  batchId: string;
  barcode: string;
  name: string;
  qty: number;
  fromStationId: string;
  toStationId: string;
  createdAt: string;
};

export type LedgerState = {
  batches: Batch[];
  sales: SaleRecord[];
  transfers: TransferRecord[];
  /** 各站货位总数，默认 DEFAULT_SLOT_CAPACITY */
  capacities: Record<string, number>;
};

export type OpResult = { ok: boolean; message: string };

const LEDGER_STORAGE_KEY = "hxwlfront-21-batch-ledger";
const LEDGER_VERSION = 1;
export const DEFAULT_SLOT_CAPACITY = 6;
/** 到期前 N 天进入临期提醒（仍可正常销售） */
const EXPIRING_SOON_DAYS = 1;

function isoOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return localDate(date);
}

export function localDate(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 今天（本地时区），跨天自动刷新 */
export const today = ref(localDate());
let timer: number | undefined;
export function startTodayTimer() {
  if (timer !== undefined) return;
  timer = window.setInterval(() => {
    const now = localDate();
    if (now !== today.value) today.value = now;
  }, 30_000);
}

/* ---------------- 种子数据 ---------------- */

function makeBatch(
  stationId: string,
  barcode: string,
  name: string,
  cost: number,
  qty: number,
  expireDate: string,
  promoPrice: number | null = null
): Batch {
  return {
    id: crypto.randomUUID(),
    stationId,
    barcode,
    name,
    cost: round2(cost),
    qty,
    receiveQty: qty,
    expireDate,
    promoPrice,
    createdAt: new Date().toISOString()
  };
}

function seedState(): LedgerState {
  const [stationA, stationB] = stations.value;
  const idA = stationA?.id ?? "seed-1";
  const idB = stationB?.id ?? "seed-2";
  const batches: Batch[] = [
    makeBatch(idA, "6901002", "三明治", 6.5, 8, isoOffset(1)),
    makeBatch(idA, "6901002", "三明治", 6.5, 6, isoOffset(4)),
    makeBatch(idA, "6901003", "饭团", 4.0, 10, isoOffset(0), 5.0),
    makeBatch(idA, "6901001", "矿泉水 550ml", 1.2, 24, isoOffset(200)),
    makeBatch(idA, "6901004", "罐装咖啡", 3.5, 12, isoOffset(90)),
    makeBatch(idA, "6901004", "罐装咖啡", 3.5, 5, isoOffset(-3))
  ];
  // 东区一站占 6 个货位（满位），方便演示"接收站货位不够则保留两边库存"
  const batchB = makeBatch(idB, "6901001", "矿泉水 550ml", 1.2, 15, isoOffset(220));
  batches.push(batchB);

  // 预置一笔今日销售，演示 FEFO：先扣明天到期的三明治 2 个
  const earliest = batches[0];
  earliest.qty -= 2;
  const sales: SaleRecord[] = [
    {
      id: crypto.randomUUID(),
      stationId: idA,
      createdAt: new Date().toISOString(),
      voided: false,
      lines: [
        {
          batchId: earliest.id,
          stationId: idA,
          barcode: earliest.barcode,
          name: earliest.name,
          qty: 2,
          unitPrice: 12.0,
          cost: earliest.cost,
          expireDate: earliest.expireDate
        }
      ]
    }
  ];
  return { batches, sales, transfers: [], capacities: {} };
}

function isValidState(value: unknown): value is LedgerState {
  if (!value || typeof value !== "object") return false;
  const state = value as Record<string, unknown>;
  return Array.isArray(state.batches) && Array.isArray(state.sales) && Array.isArray(state.transfers);
}

function loadState(): LedgerState {
  const raw = localStorage.getItem(LEDGER_STORAGE_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as { version?: number; state?: LedgerState } | LedgerState;
      const candidate = (parsed as { state?: LedgerState }).state ?? (parsed as LedgerState);
      if (isValidState(candidate)) {
        return {
          batches: candidate.batches,
          sales: candidate.sales,
          transfers: candidate.transfers,
          capacities: candidate.capacities ?? {}
        };
      }
    } catch {
      /* 落盘损坏时用种子数据重开 */
    }
  }
  const seeded = seedState();
  persistState(seeded);
  return seeded;
}

function persistState(state: LedgerState = ledger) {
  localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify({ version: LEDGER_VERSION, state }));
}

export const ledger = reactive<LedgerState>(loadState());

/* ---------------- 批次状态 / 查询 ---------------- */

export function isExpired(batch: Batch): boolean {
  return batch.expireDate < today.value;
}

/** 临期：今天或明天到期但还没过期 */
export function isExpiringSoon(batch: Batch): boolean {
  if (isExpired(batch)) return false;
  const days = daysBetween(today.value, batch.expireDate);
  return days <= EXPIRING_SOON_DAYS;
}

function daysBetween(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00`).getTime();
  const b = new Date(`${to}T00:00:00`).getTime();
  return Math.round((b - a) / 86_400_000);
}

export function daysToExpire(batch: Batch): number {
  return daysBetween(today.value, batch.expireDate);
}

export function batchStatus(batch: Batch): BatchStatus {
  if (isExpired(batch)) return "expired";
  if (batch.promoPrice !== null) return "promo";
  if (isExpiringSoon(batch)) return "expiring";
  return "normal";
}

export const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  normal: "正常",
  promo: "折扣中",
  expiring: "临期",
  expired: "已过期"
};

/** 成交单价：批次贴签价优先（签价已在设置时校验不低于进价），否则取商品售价 */
export function unitPrice(batch: Batch): number {
  if (batch.promoPrice !== null) return batch.promoPrice;
  return products.value.find((p) => p.barcode === batch.barcode)?.price ?? batch.cost;
}

/** 在架且有库存（过期自动下架） */
export function isSaleable(batch: Batch): boolean {
  return batch.qty > 0 && !isExpired(batch);
}

/** FEFO：最早到期优先；同日按登记时间 */
export function sortFefo(list: Batch[]): Batch[] {
  return [...list].sort((a, b) =>
    a.expireDate === b.expireDate
      ? a.createdAt.localeCompare(b.createdAt)
      : a.expireDate.localeCompare(b.expireDate)
  );
}

export function saleableBatches(stationId: string, barcode?: string): Batch[] {
  return sortFefo(
    ledger.batches.filter(
      (batch) => batch.stationId === stationId && isSaleable(batch) && (!barcode || batch.barcode === barcode)
    )
  );
}

/** 站点货位：每个批次占一个货位（过期批次仍占用实物货位，需人工处理） */
export function stationCapacity(stationId: string): number {
  return ledger.capacities[stationId] ?? DEFAULT_SLOT_CAPACITY;
}

export function usedSlots(stationId: string): number {
  return ledger.batches.filter((batch) => batch.stationId === stationId).length;
}

export function freeSlots(stationId: string): number {
  return stationCapacity(stationId) - usedSlots(stationId);
}

export function setStationCapacity(stationId: string, capacity: number): OpResult {
  if (!Number.isInteger(capacity) || capacity < 0) return { ok: false, message: "货位数须为非负整数" };
  if (capacity < usedSlots(stationId)) {
    return { ok: false, message: `现有批次已占 ${usedSlots(stationId)} 个货位，不能调得更小` };
  }
  ledger.capacities[stationId] = capacity;
  persistState();
  return { ok: true, message: "货位数量已更新" };
}

/* ---------------- 登记批次 ---------------- */

export type RegisterInput = {
  stationId: string;
  barcode: string;
  name: string;
  cost: number;
  qty: number;
  expireDate: string;
};

export function registerBatch(input: RegisterInput): OpResult {
  if (!input.stationId) return { ok: false, message: "请先选择油站" };
  const barcode = input.barcode.trim();
  if (!barcode) return { ok: false, message: "请填写条码" };
  if (!Number.isFinite(input.cost) || input.cost < 0) return { ok: false, message: "进价不合法" };
  if (!Number.isInteger(input.qty) || input.qty <= 0) return { ok: false, message: "数量须为正整数" };
  if (!input.expireDate) return { ok: false, message: "请填写到期日" };
  if (input.expireDate < today.value) return { ok: false, message: "到期日已过，不能登记，按报损处理" };
  if (freeSlots(input.stationId) < 1) return { ok: false, message: "本站货位已满，先处理积压批次" };

  const cost = round2(input.cost);
  const { created } = ensureProduct(barcode, input.name || `商品${barcode}`, cost);
  const product = products.value.find((p) => p.barcode === barcode);
  ledger.batches.push(
    makeBatch(
      input.stationId,
      barcode,
      input.name.trim() || product?.name || `商品${barcode}`,
      cost,
      input.qty,
      input.expireDate
    )
  );
  persistState();
  return { ok: true, message: created ? "批次已登记，并按进价自动新建商品规则" : "批次已登记" };
}

/* ---------------- 贴纸折扣 ---------------- */

export function setPromo(batchId: string, price: number | null): OpResult {
  const batch = ledger.batches.find((item) => item.id === batchId);
  if (!batch) return { ok: false, message: "批次不存在" };
  if (isExpired(batch)) return { ok: false, message: "批次已过期，自动下架，不能贴签" };
  if (price === null) {
    batch.promoPrice = null;
    persistState();
    return { ok: true, message: "折扣已撤销，恢复原价" };
  }
  if (!Number.isFinite(price) || price < 0) return { ok: false, message: "折扣价不合法" };
  const check = assertDiscountFloor(batch.barcode, round2(price));
  if (!check.ok) return check;
  batch.promoPrice = round2(price);
  persistState();
  return { ok: true, message: `已贴签 ¥${batch.promoPrice.toFixed(2)}（进价 ¥${batch.cost.toFixed(2)}）` };
}

/* ---------------- 销售（FEFO 扣减） ---------------- */

export type CartItem = {
  barcode: string;
  name: string;
  qty: number;
};

export type AllocationLine = {
  batch: Batch;
  qty: number;
  unitPrice: number;
};

/** 试算 FEFO 扣减方案，不改动库存 */
export function planSale(stationId: string, items: CartItem[]): { ok: boolean; message: string; lines: AllocationLine[] } {
  const lines: AllocationLine[] = [];
  for (const item of items) {
    if (!Number.isInteger(item.qty) || item.qty <= 0) {
      return { ok: false, message: `${item.name} 数量须为正整数`, lines: [] };
    }
    const batches = saleableBatches(stationId, item.barcode);
    let remain = item.qty;
    for (const batch of batches) {
      if (remain === 0) break;
      const take = Math.min(batch.qty, remain);
      lines.push({ batch, qty: take, unitPrice: unitPrice(batch) });
      remain -= take;
    }
    if (remain > 0) {
      const available = batches.reduce((sum, batch) => sum + batch.qty, 0);
      return {
        ok: false,
        message: `${item.name} 在架可用 ${available} 件，不足 ${item.qty} 件（过期批次已自动下架）`,
        lines: []
      };
    }
  }
  return { ok: true, message: "", lines };
}

export function checkout(stationId: string, items: CartItem[]): OpResult {
  const plan = planSale(stationId, items);
  if (!plan.ok) return plan;
  for (const line of plan.lines) {
    line.batch.qty -= line.qty;
  }
  const record: SaleRecord = {
    id: crypto.randomUUID(),
    stationId,
    createdAt: new Date().toISOString(),
    voided: false,
    lines: plan.lines.map((line) => ({
      batchId: line.batch.id,
      stationId: line.batch.stationId,
      barcode: line.batch.barcode,
      name: line.batch.name,
      qty: line.qty,
      unitPrice: line.unitPrice,
      cost: line.batch.cost,
      expireDate: line.batch.expireDate
    }))
  };
  ledger.sales.push(record);
  persistState();
  return { ok: true, message: `成交 ¥${saleAmount(record).toFixed(2)}，已按最早到期批次扣减` };
}

export function saleAmount(record: SaleRecord): number {
  return round2(record.lines.reduce((sum, line) => sum + line.qty * line.unitPrice, 0));
}

/* ---------------- 撤销销售：退回原批次 ---------------- */

export function voidSale(saleId: string): OpResult {
  const record = ledger.sales.find((sale) => sale.id === saleId);
  if (!record) return { ok: false, message: "销售记录不存在" };
  if (record.voided) return { ok: false, message: "该销售已撤销" };
  for (const line of record.lines) {
    const batch = ledger.batches.find((item) => item.id === line.batchId);
    if (batch) {
      // 哪怕批次已过期或已调拨到别的站，仍退回原批次台账
      batch.qty += line.qty;
    } else {
      // 极端情况：批次台账被物理清理，按快照重建一条已下架记录，库存不丢失
      ledger.batches.push({
        id: line.batchId,
        stationId: line.stationId,
        barcode: line.barcode,
        name: line.name,
        cost: line.cost,
        qty: line.qty,
        receiveQty: line.qty,
        expireDate: line.expireDate,
        promoPrice: null,
        createdAt: record.createdAt
      });
    }
  }
  record.voided = true;
  persistState();
  return { ok: true, message: "销售已撤销，商品退回原批次" };
}

/* ---------------- 跨站调拨：整批 + 货位预留 ---------------- */

export function transferableBatches(stationId: string): Batch[] {
  // 必须整批可用：未售过（剩余等于在架数量）、未过期、有库存
  return sortFefo(
    ledger.batches.filter(
      (batch) => batch.stationId === stationId && isSaleable(batch) && batch.qty === batch.receiveQty
    )
  );
}

export function canTransfer(batchId: string, toStationId: string): OpResult {
  const batch = ledger.batches.find((item) => item.id === batchId);
  if (!batch) return { ok: false, message: "批次不存在" };
  if (batch.stationId === toStationId) return { ok: false, message: "接收站不能与调出站相同" };
  if (!stations.value.some((station) => station.id === toStationId)) {
    return { ok: false, message: "接收站不存在" };
  }
  if (isExpired(batch)) return { ok: false, message: "批次已过期，自动下架，不能调拨" };
  if (batch.qty !== batch.receiveQty) return { ok: false, message: "该批次已拆零销售，必须整批调拨" };
  if (batch.qty <= 0) return { ok: false, message: "批次无库存" };
  // 给接收站留出货位：不够就两边库存都保留（不移动）
  if (freeSlots(toStationId) < 1) {
    return { ok: false, message: `接收站货位已满（${stationCapacity(toStationId)} 个位），库存保留在调出站` };
  }
  return { ok: true, message: "" };
}

export function transferBatch(batchId: string, toStationId: string): OpResult {
  const check = canTransfer(batchId, toStationId);
  if (!check.ok) return check;
  const batch = ledger.batches.find((item) => item.id === batchId);
  if (!batch) return { ok: false, message: "批次不存在" };
  // 移动前再校验一次，任何一步不满足都整笔不动
  if (freeSlots(toStationId) < 1) return { ok: false, message: "接收站货位不足，已取消调拨" };
  const fromStationId = batch.stationId;
  batch.stationId = toStationId;
  ledger.transfers.push({
    id: crypto.randomUUID(),
    batchId: batch.id,
    barcode: batch.barcode,
    name: batch.name,
    qty: batch.qty,
    fromStationId,
    toStationId,
    createdAt: new Date().toISOString()
  });
  persistState();
  return { ok: true, message: `整批 ${batch.qty} 件已调入接收站，占用 1 个货位` };
}

/* ---------------- 页面查询：批次 / 折扣 / 当日销量 ---------------- */

export type DaySummary = {
  count: number;
  qty: number;
  amount: number;
  profit: number;
  voidedCount: number;
};

export function daySales(day: string, stationId?: string): SaleRecord[] {
  return ledger.sales
    .filter((sale) => (!stationId || sale.stationId === stationId) && sale.createdAt.slice(0, 10) === day)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function daySummary(day: string, stationId?: string): DaySummary {
  const sales = daySales(day, stationId).filter((sale) => !sale.voided);
  return {
    count: sales.length,
    qty: sales.reduce((sum, sale) => sum + sale.lines.reduce((n, line) => n + line.qty, 0), 0),
    amount: round2(sales.reduce((sum, sale) => sum + saleAmount(sale), 0)),
    profit: round2(
      sales.reduce(
        (sum, sale) =>
          sum + sale.lines.reduce((p, line) => p + line.qty * (line.unitPrice - line.cost), 0),
        0
      )
    ),
    voidedCount: daySales(day, stationId).filter((sale) => sale.voided).length
  };
}

/** 当前折扣批次（已过期的不再视为有效折扣） */
export function promoBatches(stationId?: string): Batch[] {
  return sortFefo(
    ledger.batches.filter(
      (batch) =>
        batch.promoPrice !== null && !isExpired(batch) && (!stationId || batch.stationId === stationId)
    )
  );
}

export function batchCountByStatus(stationId: string): { saleable: number; promo: number; expired: number } {
  const stationBatches = ledger.batches.filter((batch) => batch.stationId === stationId);
  return {
    saleable: stationBatches.filter(isSaleable).length,
    promo: promoBatches(stationId).length,
    expired: stationBatches.filter(isExpired).length
  };
}

export function productInUse(barcode: string): boolean {
  return ledger.batches.some((batch) => batch.barcode === barcode);
}

export function productLabel(product: Product): string {
  return `${product.barcode} ${product.name}`;
}
