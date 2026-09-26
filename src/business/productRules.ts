// 商品规则：保质期状态、临期折扣、进价底价与先进先出（FEFO）排序。
// 只放纯业务规则，不碰界面和存储，供批次台账与油站页面复用。

export interface Batch {
  id: string;
  stationId: string;
  barcode: string;
  name: string;
  purchasePrice: number; // 进价，即折扣底价
  quantity: number; // 剩余数量
  initialQuantity: number; // 登记数量
  expiryDate: string; // 到期日 YYYY-MM-DD
  createdAt: string;
}

export interface SaleLine {
  batchId: string;
  quantity: number;
  purchasePrice: number; // 扣减时该批次的进价，核价与撤销退回时用
}

export interface SaleRecord {
  id: string;
  stationId: string;
  barcode: string;
  name: string;
  quantity: number;
  listPrice: number; // 标价
  discountRate: number; // 折扣率，1 为无折扣
  salePrice: number; // 实收单价 = 标价 × 折扣率，且不得低于进价
  lines: SaleLine[]; // 实际扣减的批次明细，撤销时原路退回
  canceled: boolean;
  createdAt: string;
}

export interface TransferRecord {
  id: string;
  batchId: string;
  barcode: string;
  name: string;
  quantity: number;
  fromStationId: string;
  toStationId: string;
  status: "已调拨" | "已拒绝";
  reason: string;
  createdAt: string;
}

export const NEAR_EXPIRY_DAYS = 3;

export function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function todayString(): string {
  return localDateString(new Date());
}

export function isSameDay(iso: string, day = todayString()): boolean {
  return localDateString(new Date(iso)) === day;
}

/** 保质期过后（到期日早于今天）即过期，自动下架。 */
export function isExpired(batch: Batch, today = todayString()): boolean {
  return batch.expiryDate < today;
}

export function daysToExpiry(batch: Batch, today = todayString()): number {
  const a = new Date(`${batch.expiryDate}T00:00:00`).getTime();
  const b = new Date(`${today}T00:00:00`).getTime();
  return Math.round((a - b) / 86400000);
}

export type BatchStatus = "在架" | "临期" | "已过期下架";

export function batchStatus(batch: Batch, today = todayString()): BatchStatus {
  if (isExpired(batch, today)) return "已过期下架";
  if (daysToExpiry(batch, today) <= NEAR_EXPIRY_DAYS) return "临期";
  return "在架";
}

/** 销售扣减顺序：最早到期批次先卖，同天到期按登记先后。 */
export function fefoOrder(batches: Batch[]): Batch[] {
  return [...batches].sort((a, b) =>
    a.expiryDate === b.expiryDate
      ? a.createdAt.localeCompare(b.createdAt)
      : a.expiryDate.localeCompare(b.expiryDate)
  );
}

/** 临期建议折扣率：1 天内到期 5 折，3 天内 8 折，其余不打折。 */
export function suggestDiscountRate(batch: Batch, today = todayString()): number {
  const days = daysToExpiry(batch, today);
  if (days <= 1) return 0.5;
  if (days <= NEAR_EXPIRY_DAYS) return 0.8;
  return 1;
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 折扣价底线：实收单价不得低于进价。 */
export function validateSalePrice(salePrice: number, purchasePrices: number[]): string | null {
  if (!Number.isFinite(salePrice) || salePrice <= 0) return "实收单价必须大于 0";
  const floor = Math.max(...purchasePrices);
  if (salePrice < floor - 1e-9) {
    return `折扣后单价 ${salePrice} 元低于进价底价 ${floor} 元，禁止出售`;
  }
  return null;
}

export function discountText(rate: number): string {
  if (rate >= 1) return "无折扣";
  return `${round2(rate * 10)} 折`;
}
