import { ref } from "vue";

/**
 * 油站网点数据访问（原网点功能继续使用同一个 localStorage key，
 * 老用户浏览器里的数据无需迁移即可见）。
 */

export type StationRecord = {
  id: string;
  status: string;
  notes: string;
  createdAt: string;
  [key: string]: string | number;
};

export const STATION_STORAGE_KEY = "hxwlfront-21-station-map";

const stationSeed = [
  { station: "东区一站", area: "东区", stock: 36000, manager: "刘站长", status: "营业中", notes: "库存正常" },
  { station: "机场快线站", area: "机场线", stock: 9000, manager: "王站长", status: "库存紧张", notes: "柴油待补" }
];

function loadStations(): StationRecord[] {
  const raw = localStorage.getItem(STATION_STORAGE_KEY);
  if (!raw) {
    return stationSeed.map((record, index) => ({
      ...record,
      id: `seed-${index + 1}`,
      createdAt: new Date(Date.now() - index * 86400000).toISOString()
    })) as StationRecord[];
  }
  try {
    return JSON.parse(raw) as StationRecord[];
  } catch {
    return [];
  }
}

export const stations = ref<StationRecord[]>(loadStations());

// 首次加载即把网点数据写回旧 key，保证沿用原存储位置（后续仍只在变更时覆盖）
if (!localStorage.getItem(STATION_STORAGE_KEY)) {
  localStorage.setItem(STATION_STORAGE_KEY, JSON.stringify(stations.value));
}

export function persistStations() {
  localStorage.setItem(STATION_STORAGE_KEY, JSON.stringify(stations.value));
}

export function stationName(id: string): string {
  const found = stations.value.find((station) => station.id === id);
  return found ? String(found.station ?? "") : "已撤点油站";
}
