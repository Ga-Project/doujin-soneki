// localStorage 永続化スキーマ（バージョン付き）と型安全なロード/セーブ。
// シミュレータとタリーの両方から参照される共有モジュール。
// 壊れたデータ・旧バージョンは黙って読み捨てる（クラッシュさせない）。

import {
  deriveSimMoneyCore,
  parseFeePercent,
  type SimMoneyResult,
  type TallyEvent,
  type TallyItem,
} from "@/lib/soneki";
import { SIM_STORAGE_NAME, TALLY_STORAGE_NAME } from "./config";

export type { SimMoneyResult };

// ---------------------------------------------------------------------------
// スキーマ v1
// ---------------------------------------------------------------------------

export interface SavedTierRow {
  id: string;
  copies: string;
  unit: string;
  total: string;
  basis: "unit" | "total";
}

export interface SavedChannel {
  id: string;
  name: string;
  /** 手数料率 %（文字列のまま保持・表示に忠実） */
  fee: string;
  /** 1 冊あたり定額手数料 円 */
  perItem: string;
  /** 予定部数（委託配分） */
  planned: string;
  visible: boolean;
  kind: "direct" | "consign";
  /** プリセット由来の注記（任意） */
  note?: string;
  sourceUrl?: string;
}

export interface SimSaved {
  v: 1;
  price: string;
  tiers: SavedTierRow[];
  selectedTierId: string;
  channels: SavedChannel[];
  mainChannelId: string;
  fixedEvent: string;
  fixedOther: string;
  isSample: boolean;
  /**
   * 保存時刻（epoch ms・省略可）。saveSim が自動付与し、復元バーの
   * 「（7月10日）」表示に使う。旧データには無く、その場合は日付なし文言に縮退する。
   */
  savedAt?: number;
}

export interface TallySaved {
  v: 1;
  items: TallyItem[];
  history: TallyEvent[];
  activeId: string | null;
  showMoney: boolean;
}

// ---------------------------------------------------------------------------
// 型ガード（unknown → 型）。any を使わず、欠け・型違いは null 扱い。
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function str(v: unknown): v is string {
  return typeof v === "string";
}
function bool(v: unknown): v is boolean {
  return typeof v === "boolean";
}
function num(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function asTierRow(v: unknown): SavedTierRow | null {
  if (!isRecord(v)) return null;
  const { id, copies, unit, total, basis } = v;
  if (!str(id) || !str(copies) || !str(unit) || !str(total)) return null;
  if (basis !== "unit" && basis !== "total") return null;
  return { id, copies, unit, total, basis };
}

function asChannel(v: unknown): SavedChannel | null {
  if (!isRecord(v)) return null;
  const { id, name, fee, perItem, planned, visible, kind } = v;
  if (!str(id) || !str(name) || !str(fee) || !str(perItem) || !str(planned))
    return null;
  if (!bool(visible)) return null;
  if (kind !== "direct" && kind !== "consign") return null;
  const out: SavedChannel = { id, name, fee, perItem, planned, visible, kind };
  if (str(v.note)) out.note = v.note;
  if (str(v.sourceUrl)) out.sourceUrl = v.sourceUrl;
  return out;
}

function asSimSaved(v: unknown): SimSaved | null {
  if (!isRecord(v) || v.v !== 1) return null;
  const {
    price,
    selectedTierId,
    mainChannelId,
    fixedEvent,
    fixedOther,
    isSample,
  } = v;
  if (!str(price) || !str(selectedTierId) || !str(mainChannelId)) return null;
  if (!str(fixedEvent) || !str(fixedOther) || !bool(isSample)) return null;
  if (!Array.isArray(v.tiers) || !Array.isArray(v.channels)) return null;
  const tiers: SavedTierRow[] = [];
  for (const t of v.tiers) {
    const row = asTierRow(t);
    if (row === null) return null;
    tiers.push(row);
  }
  const channels: SavedChannel[] = [];
  for (const c of v.channels) {
    const ch = asChannel(c);
    if (ch === null) return null;
    channels.push(ch);
  }
  if (tiers.length === 0 || channels.length === 0) return null;
  const out: SimSaved = {
    v: 1,
    price,
    tiers,
    selectedTierId,
    channels,
    mainChannelId,
    fixedEvent,
    fixedOther,
    isSample,
  };
  // savedAt は省略可（旧データ互換）。不正値は無かったものとして読み捨てる
  if (num(v.savedAt)) out.savedAt = v.savedAt;
  return out;
}

function asTallyItem(v: unknown): TallyItem | null {
  if (!isRecord(v)) return null;
  const { id, name, carryIn, count, price } = v;
  if (!str(id) || !str(name) || !num(count)) return null;
  if (carryIn !== null && !num(carryIn)) return null;
  return {
    id,
    name,
    carryIn: carryIn === null ? null : carryIn,
    count,
    // 旧データ（price なし）や不正値は「未設定」に読み替える（後方互換）
    price: num(price) && price >= 0 ? price : null,
  };
}

function asTallyEvent(v: unknown): TallyEvent | null {
  if (!isRecord(v) || !str(v.itemId)) return null;
  if (v.type === "inc") return { type: "inc", itemId: v.itemId };
  if (v.type === "set" && num(v.from) && num(v.to)) {
    return { type: "set", itemId: v.itemId, from: v.from, to: v.to };
  }
  return null;
}

function asTallySaved(v: unknown): TallySaved | null {
  if (!isRecord(v) || v.v !== 1) return null;
  if (!Array.isArray(v.items) || !Array.isArray(v.history)) return null;
  const items: TallyItem[] = [];
  for (const it of v.items) {
    const item = asTallyItem(it);
    if (item === null) return null;
    items.push(item);
  }
  const history: TallyEvent[] = [];
  for (const ev of v.history) {
    const e = asTallyEvent(ev);
    if (e === null) return null;
    history.push(e);
  }
  const activeId = str(v.activeId) ? v.activeId : null;
  const showMoney = bool(v.showMoney) ? v.showMoney : false;
  return { v: 1, items, history, activeId, showMoney };
}

// ---------------------------------------------------------------------------
// localStorage アクセス（利用不可環境＝プライベートモード等でも落とさない）
// ---------------------------------------------------------------------------

/** localStorage が使えるか（プライベートモード等では false）。 */
export function storageAvailable(): boolean {
  try {
    const probe = "soneki.probe";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

function loadRaw(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function saveRaw(key: string, value: unknown): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function loadSim(): SimSaved | null {
  return asSimSaved(loadRaw(SIM_STORAGE_NAME));
}
export function saveSim(state: SimSaved): boolean {
  // 保存時刻を自動付与（復元バーの日付表示用）
  return saveRaw(SIM_STORAGE_NAME, { ...state, savedAt: Date.now() });
}
export function clearSim(): void {
  try {
    window.localStorage.removeItem(SIM_STORAGE_NAME);
  } catch {
    /* 保存不可環境では何もしない */
  }
}

export function loadTally(): TallySaved | null {
  return asTallySaved(loadRaw(TALLY_STORAGE_NAME));
}
export function saveTally(state: TallySaved): boolean {
  return saveRaw(TALLY_STORAGE_NAME, state);
}
export function clearTally(): void {
  try {
    window.localStorage.removeItem(TALLY_STORAGE_NAME);
  } catch {
    /* 保存不可環境では何もしない */
  }
}

// ---------------------------------------------------------------------------
// タリー ⇄ シミュレータの接続（実売サマリ用の導出・純関数）
// ---------------------------------------------------------------------------

/**
 * 保存済みシミュレータ入力から、タリーの実売サマリに必要な値を導出する。
 * 実体は lib の deriveSimMoneyCore（保存経路も入力経路と同じ検証規約）。
 *   - ok: true            … price / baseCost が確定
 *   - reason: "not-configured" … 未入力（案内表示）
 *   - reason: "invalid"        … 保存値に不正な入力（損益計算をブロックし修正を促す）
 */
export function deriveSimMoney(saved: SimSaved | null): SimMoneyResult {
  return deriveSimMoneyCore(saved);
}

/** 保存済みチャネルの手数料率が妥当か（UI の復元時バリデーション補助）。 */
export function channelFeeValid(ch: SavedChannel): boolean {
  return ch.fee === "" || parseFeePercent(ch.fee) !== null;
}
