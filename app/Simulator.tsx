"use client";

// 損益分岐シミュレータ — 「朱墨の帳場」の帳面本体。
// 計算は lib/soneki.ts の純関数へ委譲し、このコンポーネントは状態と表示に徹する。
// レイアウトは帳面グリッド（ツメ列 / 記入欄 / 集計欄）。入力は左、答えは右。
// 入力エラー時も直前の有効な勘定尻・線図は捨てず、「検算中」札つきで淡く保持する。

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  activeChannelIds,
  allocationProfit,
  breakEvenCopies,
  breakEvenExact,
  formatChobo,
  formatSavedDate,
  MAX_COPIES,
  netPerCopy,
  normalizeTier,
  parseChannelParams,
  parseFeePercent,
  parseNum,
  parseOptionalYen,
  parsePlannedCopies,
  perCopyAtSellout,
  priceRange,
  profitAt,
  resolveKensanView,
  resolveMainChannelId,
  selloutProfit,
  tableStep,
  type ChannelParams,
  type Tier,
} from "@/lib/soneki";
import { CONSIGN_PRESETS } from "./config";
import {
  clearSim,
  loadSim,
  saveSim,
  storageAvailable,
  type SavedChannel,
  type SavedTierRow,
  type SimSaved,
} from "./storage";
import { ProfitChart, type ChartSeries, type LegendRow } from "./ProfitChart";

// ---------------------------------------------------------------------------
// 既定値・サンプル値
// ---------------------------------------------------------------------------

const DIRECT_ID = "direct";

const DIRECT_CHANNEL: SavedChannel = {
  id: DIRECT_ID,
  name: "会場頒布",
  fee: "0",
  perItem: "0",
  planned: "",
  visible: true,
  kind: "direct",
};

const DEFAULT_STATE: SimSaved = {
  v: 1,
  price: "",
  tiers: [
    { id: "t1", copies: "", unit: "", total: "", basis: "unit" },
    { id: "t2", copies: "", unit: "", total: "", basis: "unit" },
  ],
  selectedTierId: "t1",
  channels: [DIRECT_CHANNEL],
  mainChannelId: DIRECT_ID,
  fixedEvent: "",
  fixedOther: "",
  isSample: false,
};

// サンプルは明示ボタン経由でのみ投入する（「見本」朱印を伴う）
const SAMPLE_STATE: SimSaved = {
  v: 1,
  price: "500",
  tiers: [
    { id: "t1", copies: "100", unit: "280", total: "", basis: "unit" },
    { id: "t2", copies: "200", unit: "180", total: "", basis: "unit" },
    { id: "t3", copies: "300", unit: "140", total: "", basis: "unit" },
  ],
  selectedTierId: "t2",
  channels: [
    { ...DIRECT_CHANNEL, planned: "150" },
    {
      id: "sample-c1",
      name: "委託A（例: とらのあな）",
      fee: "30",
      perItem: "0",
      planned: "50",
      visible: true,
      kind: "consign",
    },
  ],
  mainChannelId: DIRECT_ID,
  fixedEvent: "6000",
  fixedOther: "",
  isSample: true,
};

let idSeq = 0;
function newId(prefix: string): string {
  idSeq += 1;
  return `${prefix}-${Date.now().toString(36)}-${idSeq}`;
}

/**
 * 主チャネルの選択を計算対象と常に一致させる（表示 OFF・手数料未入力・
 * 色枠超過で計算対象から外れたら、有効な系列へ自動で付け替える）。
 * すべての状態変更（編集・復元・系列切替）で通す。
 */
function normalizeMain(s: SimSaved): SimSaved {
  const next = resolveMainChannelId(s.channels, MAX_CONSIGN, s.mainChannelId);
  return next === s.mainChannelId ? s : { ...s, mainChannelId: next };
}

// 系列の意匠（ブリーフ§4）: 会場=青墨実線 / 委託=藍破線・媚茶一点鎖線・桔梗点線。
// 朱は系列に使わない（朱の予算制: 赤字・警告・分岐・印判の4用途限定）。
const DIRECT_COLOR = {
  colorClass: "iro-aozumi",
  colorVar: "var(--aozumi)",
  dash: undefined as string | undefined,
};
const CONSIGN_COLORS: readonly {
  colorClass: string;
  colorVar: string;
  dash: string;
}[] = [
  { colorClass: "iro-ai", colorVar: "var(--ai)", dash: "8 4" },
  { colorClass: "iro-kobicha", colorVar: "var(--kobicha)", dash: "10 3 2 3" },
  { colorClass: "iro-kikyo", colorVar: "var(--kikyo)", dash: "2 4" },
];
const MAX_CONSIGN = CONSIGN_COLORS.length;

interface SeriesInfo extends ChartSeries {
  kind: "direct" | "consign";
  params: ChannelParams;
  breakEven: number | null;
  breakEvenExactK: number | null;
  sellout: number;
}

/** 直前の有効な勘定（検算中の継続表示に使うスナップショット）。 */
interface ViewSnap {
  copies: number;
  baseCost: number;
  price: number;
  seriesAll: SeriesInfo[];
  mainSeries: SeriesInfo | null;
  mainBreakEven: number | null;
  mainBreakEvenExact: number | null;
  mainSellout: number;
  mainPerCopy: number | null;
  neverProfits: boolean;
  range: { sellout: number; at70: number } | null;
  plans: { name: string; copies: number; ch: ChannelParams }[];
  plannedTotal: number;
  plannedBlocked: boolean;
  allocation: number | null;
  /** 凡例も線図と同じスナップショット由来（検算中の過渡不整合を作らない）。 */
  legend: LegendRow[];
}

// ---------------------------------------------------------------------------

export function Simulator() {
  const [state, setState] = useState<SimSaved>(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [restored, setRestored] = useState(false);
  // 復元した保存の保存時刻（旧データには無い → 日付なし文言に縮退）
  const [restoredAt, setRestoredAt] = useState<number | null>(null);
  const [restoreDismissed, setRestoreDismissed] = useState(false);
  const [confirmHakushi, setConfirmHakushi] = useState(false);
  // 「表で見る」は開いているときだけ表を組み立てる
  const [tableOpen, setTableOpen] = useState(false);
  // 勘定尻バー: 線図が視界内にある間は退避（IntersectionObserver・漸進的強化）
  const [barTaihi, setBarTaihi] = useState(false);
  const senzuRef = useRef<HTMLDivElement | null>(null);
  const senzuIORef = useRef<IntersectionObserver | null>(null);
  const shukeiRef = useRef<HTMLElement | null>(null);
  // 直前の有効な勘定（検算中の継続表示用）。白紙に戻すときは破棄する
  const lastValidRef = useRef<ViewSnap | null>(null);

  // 初回マウント時に前回値を復元（SSR とのハイドレーション不一致を避けるため effect で行う）
  useEffect(() => {
    const ok = storageAvailable();
    setStorageOk(ok);
    if (ok) {
      const saved = loadSim();
      if (saved !== null) {
        setState(normalizeMain(saved));
        setRestored(true);
        setRestoredAt(saved.savedAt ?? null);
      }
    }
    setLoaded(true);
  }, []);

  // 変更を即時保存
  useEffect(() => {
    if (!loaded || !storageOk) return;
    saveSim(state);
  }, [state, loaded, storageOk]);

  // 線図が視界内なら勘定尻バーを退避（未対応環境ではバーが常時出るだけ）。
  // 線図の div は記帳がそろうまでレンダーされないため、マウント時 1 回の effect では
  // observe できない（初回は対象が存在しない）。callback ref でノードの着脱に同期して
  // 接続・切断する。ノードが消えたらバーは通常表示に戻す。
  const attachSenzu = useCallback((node: HTMLDivElement | null): void => {
    senzuRef.current = node;
    senzuIORef.current?.disconnect();
    senzuIORef.current = null;
    if (node === null || typeof IntersectionObserver === "undefined") {
      setBarTaihi(false);
      return;
    }
    const io = new IntersectionObserver(([entry]) => {
      setBarTaihi(entry?.isIntersecting ?? false);
    });
    io.observe(node);
    senzuIORef.current = io;
  }, []);

  /** ユーザー編集（見本印を外す + 主チャネル整合）。 */
  const edit = (fn: (s: SimSaved) => SimSaved): void => {
    setState((s) => normalizeMain({ ...fn(s), isSample: false }));
  };

  // --- 導出値 -------------------------------------------------------------

  const derived = useMemo(() => {
    const price = parseNum(state.price);
    const tiersNorm = new Map<string, Tier | null>(
      state.tiers.map((t) => [t.id, normalizeTier(t)]),
    );
    const selectedTier = tiersNorm.get(state.selectedTierId) ?? null;
    // 固定費も定額手数料と同じ検証経路（空欄=0・不正な非空値は計算をブロック）
    const fixedEventVal = parseOptionalYen(state.fixedEvent);
    const fixedOtherVal = parseOptionalYen(state.fixedOther);
    const fixedInvalid = fixedEventVal === null || fixedOtherVal === null;
    const fixedSum = (fixedEventVal ?? 0) + (fixedOtherVal ?? 0);
    const baseCost =
      selectedTier === null ? 0 : selectedTier.totalCost + fixedSum;
    const ready =
      price !== null && price > 0 && selectedTier !== null && !fixedInvalid;

    // チャネル → 系列。計算対象（表示 ON・入力有効・委託は色枠 3 件まで）は
    // lib の activeChannelIds と同一判定になるよう構成する
    const activeIds = new Set(activeChannelIds(state.channels, MAX_CONSIGN));
    const overLimitIds = new Set<string>();
    let consignIndex = 0;
    const seriesAll: SeriesInfo[] = [];
    const feeErrors: { id: string; msg: string }[] = [];
    for (const ch of state.channels) {
      let color: { colorClass: string; colorVar: string; dash?: string } =
        DIRECT_COLOR;
      if (ch.kind === "consign") {
        const c = CONSIGN_COLORS[consignIndex];
        consignIndex += 1;
        if (c === undefined) {
          // 4 行目以降の委託（旧データ等）: 編集はできるが計算対象外（欄に明示）
          overLimitIds.add(ch.id);
          continue;
        }
        color = c;
      }
      // 手数料率・定額手数料を同じ検証経路で解決する。不正入力は黙って 0 に
      // 置き換えず、エラーを出してチャネルごと計算/線図から除外する。
      const parsed = parseChannelParams(ch.kind, ch.fee, ch.perItem);
      if (!parsed.ok) {
        if (parsed.reason === "fee-invalid") {
          feeErrors.push({
            id: `fee-${ch.id}`,
            msg: `「${ch.name}」の手数料率は0〜100の間で`,
          });
        } else if (parsed.reason === "per-item-invalid") {
          feeErrors.push({
            id: `per-${ch.id}`,
            msg: `「${ch.name}」の定額手数料は0以上の数値で`,
          });
        }
        // fee-empty は入力待ち（エラー表示なしで除外）
        continue;
      }
      if (!ch.visible) continue;
      const params: ChannelParams = parsed.params;
      // price が未確定/不正のときは ready=false で勘定尻・線図とも表示されない。
      // ここの 0 は「表示されない系列」の内部プレースホルダで、結果には出ない
      const p = price ?? 0;
      seriesAll.push({
        id: ch.id,
        name: ch.name,
        kind: ch.kind,
        params,
        net: netPerCopy(p, params),
        breakEven: ready ? breakEvenCopies(p, params, baseCost) : null,
        breakEvenExactK: ready ? breakEvenExact(p, params, baseCost) : null,
        sellout:
          ready && selectedTier !== null
            ? selloutProfit(selectedTier.copies, p, params, baseCost)
            : 0,
        ...color,
      });
    }

    const mainSeries =
      seriesAll.find((s) => s.id === state.mainChannelId) ??
      seriesAll[0] ??
      null;

    // 入力エラー（状態デザイン: 検算中）
    const rowErrors: { id: string; msg: string }[] = [];
    let rowIncomplete = false;
    let rowOverMax = false;
    for (const t of state.tiers) {
      const anyRowInput = t.copies !== "" || t.unit !== "" || t.total !== "";
      if (!anyRowInput) continue;
      const copiesN = Number(t.copies);
      if (Number.isInteger(copiesN) && copiesN > MAX_COPIES) {
        rowOverMax = true;
      } else if (tiersNorm.get(t.id) === null) {
        rowIncomplete = true;
      }
    }
    if (rowOverMax) {
      rowErrors.push({
        id: "row-max",
        msg: `部数は${MAX_COPIES.toLocaleString("ja-JP")}部まで`,
      });
    }
    if (rowIncomplete) {
      rowErrors.push({
        id: "row-incomplete",
        msg: "部数と単価をセットで（例: 100部・単価320円）",
      });
    }
    const anyInput =
      state.price !== "" ||
      state.tiers.some(
        (t) => t.copies !== "" || t.unit !== "" || t.total !== "",
      );
    const missing: { id: string; msg: string }[] = [];
    if (anyInput && (price === null || price <= 0)) {
      missing.push({ id: "missing-price", msg: "頒価が未記入です" });
    }
    if (anyInput && selectedTier === null) {
      missing.push({
        id: "missing-tier",
        msg: "第二丁で「この部数で刷る」行を仕上げて選んでください",
      });
    }
    if (fixedEventVal === null) {
      missing.push({
        id: "fixed-event",
        msg: "参加費は0以上の数値で",
      });
    }
    if (fixedOtherVal === null) {
      missing.push({
        id: "fixed-other",
        msg: "その他の固定費は0以上の数値で",
      });
    }

    // 配分プラン（予定部数）。不正な予定部数は黙ってスキップせず、
    // 欄エラー＋集計側エラーを出して配分サマリ全体をブロックする
    const plannedInvalidIds = new Set<string>();
    const plannedErrors: { id: string; msg: string }[] = [];
    for (const ch of state.channels) {
      if (!parsePlannedCopies(ch.planned).ok) {
        plannedInvalidIds.add(ch.id);
        plannedErrors.push({
          id: `plan-${ch.id}`,
          msg: `「${ch.name}」の予定部数は0以上の整数で`,
        });
      }
    }
    const plans: { name: string; copies: number; ch: ChannelParams }[] = [];
    let plannedBlocked = false;
    for (const s of seriesAll) {
      const chRow = state.channels.find((c) => c.id === s.id);
      if (chRow === undefined) continue;
      const planned = parsePlannedCopies(chRow.planned);
      if (!planned.ok) {
        plannedBlocked = true;
        continue;
      }
      if (planned.copies !== null) {
        plans.push({ name: s.name, copies: planned.copies, ch: s.params });
      }
    }
    const plannedTotal = plans.reduce((acc, p) => acc + p.copies, 0);
    const allocation =
      ready && !plannedBlocked && plans.length > 0 && price !== null
        ? allocationProfit(plans, price, baseCost)
        : null;

    const range =
      ready && selectedTier !== null && mainSeries !== null
        ? priceRange(selectedTier.copies, mainSeries.params, baseCost)
        : null;

    return {
      price,
      tiersNorm,
      selectedTier,
      fixedSum,
      fixedEventInvalid: fixedEventVal === null,
      fixedOtherInvalid: fixedOtherVal === null,
      baseCost,
      ready,
      seriesAll,
      mainSeries,
      activeIds,
      overLimitIds,
      feeErrors,
      rowErrors,
      missing,
      plans,
      plannedTotal,
      plannedInvalidIds,
      plannedErrors,
      plannedBlocked,
      allocation,
      range,
    };
  }, [state]);

  const {
    price,
    tiersNorm,
    selectedTier,
    fixedEventInvalid,
    fixedOtherInvalid,
    baseCost,
    ready,
    seriesAll,
    mainSeries,
    activeIds,
    overLimitIds,
    feeErrors,
    rowErrors,
    missing,
    plans,
    plannedTotal,
    plannedInvalidIds,
    plannedErrors,
    plannedBlocked,
    allocation,
    range,
  } = derived;

  // 頒価欄のエラー判定（aria-invalid と訂正文・aria-describedby の紐付けを共有）
  const priceInvalid = state.price !== "" && (price === null || price <= 0);

  // --- ハンドラ -----------------------------------------------------------

  /** 選択中の行が未完成なら、完成している最初の行に選択を移す。 */
  const ensureSelection = (s: SimSaved): SimSaved => {
    const selected = s.tiers.find((t) => t.id === s.selectedTierId);
    if (selected !== undefined && normalizeTier(selected) !== null) return s;
    const firstComplete = s.tiers.find((t) => normalizeTier(t) !== null);
    return firstComplete === undefined
      ? s
      : { ...s, selectedTierId: firstComplete.id };
  };

  // 入力中（キーストローク）には選択行を動かさない。選択の自動補正は blur / 行削除時に限定。
  const updateTier = (id: string, patch: Partial<SavedTierRow>): void => {
    edit((s) => ({
      ...s,
      tiers: s.tiers.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    }));
  };

  const fixSelectionOnBlur = (): void => {
    setState((s) => ensureSelection(s));
  };

  const addTier = (): void => {
    edit((s) => ({
      ...s,
      tiers: [
        ...s.tiers,
        { id: newId("t"), copies: "", unit: "", total: "", basis: "unit" },
      ],
    }));
  };

  const removeTier = (id: string): void => {
    edit((s) => {
      if (s.tiers.length <= 2) return s; // 最低 2 行は維持
      return ensureSelection({
        ...s,
        tiers: s.tiers.filter((t) => t.id !== id),
      });
    });
  };

  const updateChannel = (id: string, patch: Partial<SavedChannel>): void => {
    edit((s) => ({
      ...s,
      channels: s.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  };

  const addChannel = (preset: {
    name: string;
    fee: string;
    perItem: string;
    note?: string;
    sourceUrl?: string;
  }): void => {
    edit((s) => {
      if (s.channels.filter((c) => c.kind === "consign").length >= MAX_CONSIGN)
        return s;
      const ch: SavedChannel = {
        id: newId("c"),
        name: preset.name,
        fee: preset.fee,
        perItem: preset.perItem,
        planned: "",
        visible: true,
        kind: "consign",
      };
      if (preset.note !== undefined) ch.note = preset.note;
      if (preset.sourceUrl !== undefined) ch.sourceUrl = preset.sourceUrl;
      return { ...s, channels: [...s.channels, ch] };
    });
  };

  const removeChannel = (id: string): void => {
    edit((s) => ({
      ...s,
      channels: s.channels.filter((c) => c.id !== id),
      mainChannelId: s.mainChannelId === id ? DIRECT_ID : s.mainChannelId,
    }));
  };

  const selectMain = (id: string): void => {
    setState((s) => normalizeMain({ ...s, mainChannelId: id }));
  };

  const applySample = (): void => {
    setState({
      ...SAMPLE_STATE,
      tiers: SAMPLE_STATE.tiers.map((t) => ({ ...t })),
      channels: SAMPLE_STATE.channels.map((c) => ({ ...c })),
    });
  };

  const resetAll = (): void => {
    clearSim();
    // 白紙に戻したら旧勘定のスナップショットも破棄する（検算中として蘇らせない）
    lastValidRef.current = null;
    setState({
      ...DEFAULT_STATE,
      tiers: DEFAULT_STATE.tiers.map((t) => ({ ...t })),
      channels: DEFAULT_STATE.channels.map((c) => ({ ...c })),
    });
    setRestored(false);
    setRestoreDismissed(true);
    setConfirmHakushi(false);
  };

  // --- 表示（勘定のスナップショットと検算中の継続表示） ---------------------

  const mainBreakEven = mainSeries?.breakEven ?? null;
  const mainSellout = mainSeries?.sellout ?? 0;
  const mainPerCopy =
    ready && mainSeries !== null && selectedTier !== null && price !== null
      ? perCopyAtSellout(
          selectedTier.copies,
          price,
          mainSeries.params,
          baseCost,
        )
      : null;
  const neverProfits = ready && mainSeries !== null && mainSeries.net <= 0;

  // 凡例（線図表示のトグルは第三丁と同一 state = 双方向同期）。
  // 検算中の過渡不整合を作らないため、線図と同じくスナップショットに含める。
  const legend: LegendRow[] = (() => {
    let ci = 0;
    const rows: LegendRow[] = [];
    for (const ch of state.channels) {
      let colorVar = DIRECT_COLOR.colorVar;
      let dash: string | undefined = undefined;
      if (ch.kind === "consign") {
        const c = CONSIGN_COLORS[ci];
        ci += 1;
        if (c === undefined) continue; // 色枠外は凡例にも出ない（欄側に「対象外」明示）
        colorVar = c.colorVar;
        dash = c.dash;
      }
      rows.push({
        id: ch.id,
        name: ch.name,
        colorVar,
        dash,
        visible: ch.visible,
        isMain: state.mainChannelId === ch.id,
        active: activeIds.has(ch.id),
      });
    }
    return rows;
  })();

  const liveView: ViewSnap | null =
    ready && selectedTier !== null && price !== null
      ? {
          copies: selectedTier.copies,
          baseCost,
          price,
          seriesAll,
          mainSeries,
          mainBreakEven,
          mainBreakEvenExact: mainSeries?.breakEvenExactK ?? null,
          mainSellout,
          mainPerCopy,
          neverProfits,
          range,
          plans,
          plannedTotal,
          plannedBlocked,
          allocation,
          legend,
        }
      : null;
  useEffect(() => {
    if (liveView !== null) lastValidRef.current = liveView;
  });

  const errorList = [...missing, ...rowErrors, ...feeErrors, ...plannedErrors];
  // 検算中: 訂正エラーが出ている間だけ直前の有効な勘定を淡く保持する。
  // 白紙・既定に戻した（エラーも入力も無い）ときは旧勘定を再利用せず空状態へ
  const { view, kensanchu } = resolveKensanView(
    liveView,
    lastValidRef.current,
    errorList.length > 0,
  );
  // エラー id → 訂正すべき欄のアンカー（既定はエラー id と同名の入力 id）
  const errHref = (id: string): string => {
    if (id === "missing-price") return "#price-input";
    if (id === "missing-tier" || id.startsWith("row-")) return "#cho-2";
    return `#${id}`;
  };

  // 上限判定は「委託チャネルの行数」基準（表示 OFF・手数料未入力の行も数える）
  const consignRows = state.channels.filter((c) => c.kind === "consign").length;

  const chartAria =
    view !== null
      ? view.neverProfits || view.mainBreakEven === null
        ? "損益グラフ。この条件では黒字になりません。"
        : `損益グラフ。損益分岐点は${view.mainBreakEven}部、完売時損益は${formatChobo(view.mainSellout).aria}。`
      : "損益グラフ。記帳がそろうと表示されます。";

  // KPI の桁あふれ段階縮小（8桁以上で該当セルのみ縮小）
  const chijimi = (n: number): string =>
    Math.abs(Math.round(n)).toLocaleString("ja-JP").length >= 10
      ? " chijimi"
      : "";

  // 帳面全体で有効な記入がまだ無い（完全な空） — 集計欄は骨格ごと出さない
  const empty = view === null && errorList.length === 0;

  // 単価表が実質空か（空状態の帳票演出用）
  const tiersEmpty = state.tiers.every(
    (t) => t.copies === "" && t.unit === "" && t.total === "",
  );

  const scrollToShukei = (): void => {
    // 検算中（旧値の淡表示）や計算不能のときは、まず訂正すべき欄へ誘導する
    if ((kensanchu || view === null) && errorList.length > 0) {
      const first = errorList[0];
      if (first !== undefined) {
        document
          .querySelector(errHref(first.id))
          ?.scrollIntoView({ block: "center" });
        return;
      }
    }
    (senzuRef.current ?? shukeiRef.current)?.scrollIntoView({
      block: "start",
    });
  };

  // ---------------------------------------------------------------------------

  return (
    <>
      <div className="chomen">
        {/* ツメ列（丁番号アンカー） */}
        <nav className="tsume-retsu" aria-label="丁の一覧">
          <a className="tsume-ban" href="#cho-1">
            一
          </a>
          <a className="tsume-ban" href="#cho-2">
            二
          </a>
          <a className="tsume-ban" href="#cho-3">
            三
          </a>
          <a className="tsume-ban" href="#cho-4">
            四
          </a>
        </nav>

        {/* ===== 記入欄 ===== */}
        <div className="kinyu-ran">
          {restored && !restoreDismissed && (
            <div className="fukugen" role="status">
              <span>
                前回の帳面を開きました
                {formatSavedDate(restoredAt) !== null && (
                  <>（{formatSavedDate(restoredAt)}）</>
                )}
              </span>
              <span className="migiyose">
                {confirmHakushi ? (
                  <>
                    <span className="sai">本当に白紙へ？</span>
                    <button
                      type="button"
                      className="bt bt-shu bt-sm"
                      onClick={resetAll}
                    >
                      戻す
                    </button>
                    <button
                      type="button"
                      className="bt bt-sub bt-sm"
                      onClick={() => setConfirmHakushi(false)}
                    >
                      やめる
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      className="bt bt-sub bt-sm"
                      onClick={() => setConfirmHakushi(true)}
                    >
                      白紙に戻す
                    </button>
                    <button
                      type="button"
                      className="bt-kesu"
                      aria-label="この知らせを閉じる"
                      onClick={() => setRestoreDismissed(true)}
                    >
                      ×
                    </button>
                  </>
                )}
              </span>
            </div>
          )}
          {loaded && !storageOk && (
            <div className="fusen fusen-shu" role="status">
              ※
              この環境では帳面を保存できません。ページを閉じると記帳が消えます。
            </div>
          )}
          {state.isSample && (
            <p className="sai" style={{ marginTop: "var(--ma-2)" }}>
              <span className="mihon">見本</span>{" "}
              見本の数字で計算中。どこか1欄でも書き直すと消えます。
            </p>
          )}

          {/* 第一丁 頒価 */}
          <section className="cho" id="cho-1" aria-labelledby="cho-1-midashi">
            <h2 className="cho-midashi" id="cho-1-midashi">
              <span className="kansuji">一</span>頒価
            </h2>
            <div className="cho-body">
              <div className="kinyu" style={{ maxWidth: "16rem" }}>
                <label className="ran" htmlFor="price-input">
                  1冊の頒価（円）
                </label>
                <div className="kinyu-tani">
                  <input
                    id="price-input"
                    type="number"
                    inputMode="numeric"
                    min="0"
                    step="10"
                    className="suji"
                    value={state.price}
                    onChange={(e) =>
                      edit((s) => ({ ...s, price: e.target.value }))
                    }
                    aria-invalid={priceInvalid}
                    // エラー非表示時に空参照を残さない（存在するときだけ紐付ける）
                    aria-describedby={priceInvalid ? "price-teisei" : undefined}
                  />
                  <span className="tani">円</span>
                </div>
                {priceInvalid && (
                  <p className="teisei" id="price-teisei">
                    訂正：頒価が未記入です
                  </p>
                )}
              </div>
              <p className="sai">
                刷り部数は第二丁の単価表から「この部数で刷る」行を選びます
                {selectedTier !== null && (
                  <>
                    （現在:{" "}
                    <strong className="suji">{selectedTier.copies}</strong> 部）
                  </>
                )}
              </p>
            </div>
          </section>

          {/* 第二丁 印刷費（単価表） */}
          <section className="cho" id="cho-2" aria-labelledby="cho-2-midashi">
            <h2 className="cho-midashi" id="cho-2-midashi">
              <span className="kansuji">二</span>印刷費（単価表）
              {/* 見本印はスクロール中も見本値と分かるよう各丁の右肩にも捺す */}
              {state.isSample && <span className="mihon">見本</span>}
            </h2>
            <p className="cho-hosoku sai">
              印刷所の見積の、部数と単価をそのまま書き写せば足ります。単価か総額、書きやすいほうで。
            </p>
            <div className="cho-body">
              {tiersEmpty ? (
                <div className="karacho">
                  <div className="karacho-sen" />
                  <div className="karacho-sen" />
                  <div className="karacho-sen" />
                  <p className="karacho-moji">
                    まだ単価が記帳されていません。まずは1行、部数と単価を。
                  </p>
                  <div
                    style={{
                      display: "flex",
                      gap: "var(--ma-2)",
                      flexWrap: "wrap",
                    }}
                  >
                    <button
                      type="button"
                      className="bt bt-sub"
                      onClick={addTier}
                    >
                      ＋ 行を足す
                    </button>
                    <button
                      type="button"
                      className="bt bt-sub"
                      onClick={applySample}
                    >
                      サンプルの数字で試す
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="hyo-waku">
                    <table className="hyo">
                      <thead>
                        <tr>
                          <th scope="col">刷る</th>
                          <th scope="col" className="suji-col">
                            部数（部）
                          </th>
                          <th scope="col">記入（円）</th>
                          <th scope="col" className="suji-col">
                            換算
                          </th>
                          <th scope="col">
                            <span className="sr-only">行の削除</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {state.tiers.map((t, i) => {
                          const norm = tiersNorm.get(t.id) ?? null;
                          const erabi = state.selectedTierId === t.id;
                          return (
                            <tr
                              key={t.id}
                              className={erabi ? "is-erabi" : undefined}
                            >
                              <td>
                                <label
                                  className="shu-radio"
                                  title="この部数で刷る"
                                >
                                  <input
                                    type="radio"
                                    name="tier-select"
                                    checked={erabi}
                                    disabled={norm === null}
                                    // 他の入力と同じく edit() 経由（見本印の解除
                                    // ＋主チャネル整合を通す）
                                    onChange={() =>
                                      edit((s) => ({
                                        ...s,
                                        selectedTierId: t.id,
                                      }))
                                    }
                                    aria-label={`この部数で刷る（${t.copies === "" ? `${i + 1}行目` : `${t.copies}部`}）`}
                                  />
                                </label>
                              </td>
                              <td style={{ minWidth: "6.5rem" }}>
                                <input
                                  type="number"
                                  inputMode="numeric"
                                  min="1"
                                  step="1"
                                  className="kinyu-input suji"
                                  value={t.copies}
                                  onChange={(e) =>
                                    updateTier(t.id, {
                                      copies: e.target.value,
                                    })
                                  }
                                  onBlur={fixSelectionOnBlur}
                                  aria-label={`${i + 1}行目の部数`}
                                />
                              </td>
                              <td>
                                <div
                                  style={{
                                    display: "flex",
                                    gap: "var(--ma-1)",
                                    alignItems: "center",
                                  }}
                                >
                                  <div
                                    className="kubun-toggle"
                                    role="group"
                                    aria-label={`${i + 1}行目の記入方法`}
                                  >
                                    <button
                                      type="button"
                                      aria-pressed={t.basis === "unit"}
                                      onClick={() =>
                                        updateTier(t.id, { basis: "unit" })
                                      }
                                    >
                                      単価
                                    </button>
                                    <button
                                      type="button"
                                      aria-pressed={t.basis === "total"}
                                      onClick={() =>
                                        updateTier(t.id, { basis: "total" })
                                      }
                                    >
                                      総額
                                    </button>
                                  </div>
                                  <input
                                    type="number"
                                    inputMode="decimal"
                                    min="0"
                                    className="kinyu-input suji"
                                    style={{ minWidth: "6.5rem" }}
                                    value={
                                      t.basis === "unit" ? t.unit : t.total
                                    }
                                    onChange={(e) =>
                                      updateTier(
                                        t.id,
                                        t.basis === "unit"
                                          ? { unit: e.target.value }
                                          : { total: e.target.value },
                                      )
                                    }
                                    onBlur={fixSelectionOnBlur}
                                    aria-label={`${i + 1}行目の${t.basis === "unit" ? "単価（円/部）" : "総額（円）"}`}
                                  />
                                </div>
                              </td>
                              <td className="suji-col sai suji">
                                {norm === null
                                  ? "—"
                                  : t.basis === "unit"
                                    ? `総額 ${Math.round(norm.totalCost).toLocaleString("ja-JP")}`
                                    : `単価 ${(Math.round(norm.unitCost * 10) / 10).toLocaleString("ja-JP")}`}
                              </td>
                              <td>
                                <button
                                  type="button"
                                  className="bt-kesu"
                                  disabled={state.tiers.length <= 2}
                                  onClick={() => removeTier(t.id)}
                                  aria-label={`${i + 1}行目を削除`}
                                >
                                  ×
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  {rowErrors.map((e) => (
                    <p key={e.id} className="teisei">
                      訂正：{e.msg}
                    </p>
                  ))}
                  <button
                    type="button"
                    className="bt-gyotasu"
                    onClick={addTier}
                  >
                    ＋ 行を足す
                  </button>
                  <div>
                    <button
                      type="button"
                      className="bt bt-sub bt-sm"
                      onClick={applySample}
                    >
                      サンプルの数字で試す
                    </button>
                  </div>
                </>
              )}
            </div>
          </section>

          {/* 第三丁 頒布チャネル */}
          <section className="cho" id="cho-3" aria-labelledby="cho-3-midashi">
            <h2 className="cho-midashi" id="cho-3-midashi">
              <span className="kansuji">三</span>頒布チャネル
              {state.isSample && <span className="mihon">見本</span>}
            </h2>
            <p className="cho-hosoku sai">
              委託価格×料率＋定額が1冊ごとに引かれます。料率は各委託先の最新の案内に記載の値を。
            </p>
            <div className="cho-body">
              {state.channels.map((ch) => {
                const isMain = state.mainChannelId === ch.id;
                const feeInvalid =
                  ch.kind === "consign" &&
                  ch.fee !== "" &&
                  parseFeePercent(ch.fee) === null;
                const perItemInvalid =
                  ch.kind === "consign" &&
                  ch.perItem.trim() !== "" &&
                  parseNum(ch.perItem) === null;
                const seriesRow = seriesAll.find((s) => s.id === ch.id);
                const colorClass =
                  seriesRow?.colorClass ??
                  (ch.kind === "direct" ? "iro-aozumi" : "iro-ai");
                return (
                  <div
                    key={ch.id}
                    className={`itaku-hyo${isMain ? " is-shu" : ""}`}
                  >
                    <div className="itaku-head">
                      <span
                        className={`iro-mihon ${colorClass}`}
                        aria-hidden="true"
                      />
                      {ch.kind === "direct" ? (
                        <strong>{ch.name}（手数料なし）</strong>
                      ) : (
                        <input
                          type="text"
                          value={ch.name}
                          onChange={(e) =>
                            updateChannel(ch.id, { name: e.target.value })
                          }
                          aria-label="委託先の名前"
                        />
                      )}
                      {ch.kind === "consign" && (
                        <button
                          type="button"
                          className="bt-kesu"
                          onClick={() => removeChannel(ch.id)}
                          aria-label={`${ch.name}を削除`}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <div className="itaku-body">
                      {ch.kind === "consign" && (
                        <>
                          <div className="kinyu">
                            <label className="ran" htmlFor={`fee-${ch.id}`}>
                              手数料率（%）
                            </label>
                            <input
                              id={`fee-${ch.id}`}
                              type="number"
                              inputMode="decimal"
                              min="0"
                              max="100"
                              step="0.1"
                              className="kinyu-input suji"
                              value={ch.fee}
                              onChange={(e) =>
                                updateChannel(ch.id, { fee: e.target.value })
                              }
                              aria-invalid={feeInvalid}
                            />
                            {feeInvalid && (
                              <p className="teisei">
                                訂正：手数料率は0〜100の間で
                              </p>
                            )}
                          </div>
                          <div className="kinyu">
                            <label className="ran" htmlFor={`per-${ch.id}`}>
                              定額（円/冊）
                            </label>
                            <input
                              id={`per-${ch.id}`}
                              type="number"
                              inputMode="numeric"
                              min="0"
                              className="kinyu-input suji"
                              value={ch.perItem}
                              onChange={(e) =>
                                updateChannel(ch.id, {
                                  perItem: e.target.value,
                                })
                              }
                              aria-invalid={perItemInvalid}
                            />
                            {perItemInvalid && (
                              <p className="teisei">
                                訂正：定額手数料は0以上の数値で
                              </p>
                            )}
                          </div>
                        </>
                      )}
                      <div className="kinyu">
                        <label className="ran" htmlFor={`plan-${ch.id}`}>
                          予定部数（部・任意）
                        </label>
                        <input
                          id={`plan-${ch.id}`}
                          type="number"
                          inputMode="numeric"
                          min="0"
                          step="1"
                          className="kinyu-input suji"
                          value={ch.planned}
                          onChange={(e) =>
                            updateChannel(ch.id, { planned: e.target.value })
                          }
                          aria-invalid={plannedInvalidIds.has(ch.id)}
                        />
                        {plannedInvalidIds.has(ch.id) && (
                          <p className="teisei">
                            訂正：予定部数は0以上の整数で
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="itaku-ashi">
                      <label className="sumi-check">
                        <input
                          type="checkbox"
                          checked={ch.visible}
                          onChange={(e) =>
                            updateChannel(ch.id, {
                              visible: e.target.checked,
                            })
                          }
                        />
                        線図に表示
                      </label>
                      <label className="sumi-check">
                        <input
                          type="radio"
                          name="main-channel"
                          checked={isMain}
                          disabled={!activeIds.has(ch.id)}
                          onChange={() => selectMain(ch.id)}
                        />
                        主チャネル
                      </label>
                    </div>
                    {overLimitIds.has(ch.id) && (
                      <p className="itaku-chu sai">
                        <span className="fuda fuda-akaji">対象外</span>{" "}
                        4件目以降の委託は線図・計算の対象外です（委託は
                        {MAX_CONSIGN}
                        件まで）。不要な委託先を削除すると反映されます
                      </p>
                    )}
                    {ch.note !== undefined && (
                      <p className="itaku-chu sai">
                        {ch.note}
                        {ch.sourceUrl !== undefined && (
                          <>
                            {" "}
                            <a
                              href={ch.sourceUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              出典 ↗
                            </a>
                          </>
                        )}
                      </p>
                    )}
                  </div>
                );
              })}

              <div className="tsume-obi" role="group" aria-label="委託先を追加">
                {CONSIGN_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className="tsume"
                    disabled={consignRows >= MAX_CONSIGN}
                    onClick={() =>
                      addChannel({
                        name: p.name,
                        fee: p.fee,
                        perItem: p.perItem === "" ? "0" : p.perItem,
                        note: p.note,
                        ...(p.sourceUrl === null
                          ? {}
                          : { sourceUrl: p.sourceUrl }),
                      })
                    }
                  >
                    ＋ {p.name}
                  </button>
                ))}
                <button
                  type="button"
                  className="tsume"
                  disabled={consignRows >= MAX_CONSIGN}
                  onClick={() =>
                    addChannel({ name: "委託先", fee: "", perItem: "0" })
                  }
                >
                  ＋ その他
                </button>
              </div>
              {consignRows >= MAX_CONSIGN && (
                <p className="sai">
                  委託は{MAX_CONSIGN}
                  件まで記帳できます。入れ替えるには不要な委託先を削除してください。
                </p>
              )}
              <p className="sai">
                プリセットの料率は公開情報にもとづく目安で、書き直せます。料率は改定されることがあります。最新の料率は各委託先の公式の案内で。
              </p>
            </div>
          </section>

          {/* 第四丁 固定費（折畳・不正入力がある間は開いたまま） */}
          <section className="cho" id="cho-4" aria-labelledby="cho-4-midashi">
            <details
              className="tatami"
              open={fixedEventInvalid || fixedOtherInvalid || undefined}
            >
              <summary id="cho-4-midashi">
                <span className="cho-midashi" style={{ fontSize: "inherit" }}>
                  <span className="kansuji">四</span>固定費（任意）
                </span>
              </summary>
              <div className="tatami-body">
                <p className="sai">
                  参加費・交通費・送料など、部数によらず掛かる費用。既定は0円。
                </p>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(10rem, 1fr))",
                    gap: "var(--ma-2)",
                  }}
                >
                  <div className="kinyu">
                    <label className="ran" htmlFor="fixed-event">
                      イベント参加費（円）
                    </label>
                    <input
                      id="fixed-event"
                      type="number"
                      inputMode="numeric"
                      min="0"
                      className="kinyu-input suji"
                      value={state.fixedEvent}
                      onChange={(e) =>
                        edit((s) => ({ ...s, fixedEvent: e.target.value }))
                      }
                      aria-invalid={fixedEventInvalid}
                    />
                    {fixedEventInvalid && (
                      <p className="teisei">訂正：参加費は0以上の数値で</p>
                    )}
                  </div>
                  <div className="kinyu">
                    <label className="ran" htmlFor="fixed-other">
                      その他の固定費（円）
                    </label>
                    <input
                      id="fixed-other"
                      type="number"
                      inputMode="numeric"
                      min="0"
                      className="kinyu-input suji"
                      value={state.fixedOther}
                      onChange={(e) =>
                        edit((s) => ({ ...s, fixedOther: e.target.value }))
                      }
                      aria-invalid={fixedOtherInvalid}
                    />
                    {fixedOtherInvalid && (
                      <p className="teisei">
                        訂正：その他の固定費は0以上の数値で
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </details>
          </section>
        </div>

        {/* ===== 集計欄 ===== */}
        <aside className="shukei-ran" aria-label="集計欄" ref={shukeiRef}>
          {errorList.length > 0 && (
            <div
              className="fusen fusen-shu"
              role="status"
              style={{ marginBottom: "var(--ma-2)" }}
            >
              訂正が必要な欄があります
              <ul>
                {errorList.map((e) => (
                  <li key={e.id}>
                    <a href={errHref(e.id)}>訂正：{e.msg}</a>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {empty ? (
            <p className="sai">記帳がそろうと、ここに勘定尻と線図が出ます。</p>
          ) : view === null ? (
            <div className="kanjo-jiri">
              <div className="kanjo-kashira">
                <span className="ran">勘定尻</span>
                <span className="fuda fuda-akaji">検算中</span>
              </div>
              <div className="kanjo-dai">
                <div className="ran">損益分岐部数</div>
                <div className="kanjo-suji">
                  <span className="oki suji" style={{ color: "var(--sumi-2)" }}>
                    ―
                  </span>
                </div>
                <p className="kanjo-hochu sai">
                  検算中 — 訂正すると自動で計算し直します
                </p>
              </div>
            </div>
          ) : (
            <div className={kensanchu ? "kensanchu" : undefined}>
              {/* 勘定尻（KPI 1+2・二重罫の締め） */}
              <div className="kanjo-jiri">
                <div className="kanjo-kashira">
                  <span className="ran">勘定尻</span>
                  <span
                    style={{
                      display: "flex",
                      gap: "var(--ma-1)",
                      alignItems: "center",
                    }}
                  >
                    {state.isSample && !kensanchu && (
                      <span className="sai">見本の数字で計算中</span>
                    )}
                    {kensanchu && (
                      <span className="fuda fuda-akaji">検算中</span>
                    )}
                  </span>
                </div>
                <div className="kanjo-dai">
                  <div className="ran">損益分岐部数</div>
                  <div className="kanjo-suji">
                    {view.neverProfits || view.mainBreakEven === null ? (
                      <span
                        className="oki suji"
                        style={{ color: "var(--sumi-2)" }}
                      >
                        ―
                      </span>
                    ) : (
                      <>
                        <span
                          className={`oki suji${chijimi(view.mainBreakEven)}`}
                        >
                          {view.mainBreakEven.toLocaleString("ja-JP")}
                        </span>
                        <span className="tani">部</span>
                      </>
                    )}
                  </div>
                  <p
                    className="kanjo-hochu sai"
                    aria-live="polite"
                    // 黒字化不能は朱補注（§7）。朱の予算制の「警告」用途
                    style={
                      view.neverProfits || view.mainBreakEven === null
                        ? { color: "var(--shu)" }
                        : undefined
                    }
                  >
                    {view.neverProfits || view.mainBreakEven === null
                      ? "この条件では黒字になりません"
                      : view.mainBreakEven <= view.copies
                        ? `${view.mainBreakEven}部目から黒字`
                        : `完売しても届きません（分岐 ${view.mainBreakEven}部）`}
                  </p>
                </div>
                <div className="kanjo-fuku">
                  <div>
                    <div className="ran">完売時損益</div>
                    <div className="kanjo-suji">
                      {/* △表記は視覚用に伏せ、読み上げは formatChobo(...).aria を併記 */}
                      <span
                        className={`naka suji${chijimi(view.mainSellout)} ${view.mainSellout < 0 ? "akaji-ji" : "kuroji-ji"}`}
                      >
                        <span aria-hidden="true">
                          {formatChobo(view.mainSellout).text}
                        </span>
                        <span className="sr-only">
                          {formatChobo(view.mainSellout).aria}
                        </span>
                      </span>
                      <span className="tani" aria-hidden="true">
                        円
                      </span>
                      <span
                        className={`fuda ${view.mainSellout < 0 ? "fuda-akaji" : "fuda-kuroji"}`}
                      >
                        {view.mainSellout < 0 ? "赤字" : "黒字"}
                      </span>
                    </div>
                    <p className="kanjo-hochu sai suji" aria-live="polite">
                      <span aria-hidden="true">
                        完売で {formatChobo(view.mainSellout).text}円
                      </span>
                      <span className="sr-only">
                        完売で {formatChobo(view.mainSellout).aria}
                      </span>
                    </p>
                  </div>
                  <div>
                    <div className="ran">1冊あたり</div>
                    <div className="kanjo-suji">
                      {view.mainPerCopy === null ? (
                        <span
                          className="naka suji"
                          style={{ color: "var(--sumi-2)" }}
                        >
                          ―
                        </span>
                      ) : (
                        <>
                          <span
                            className={`naka suji ${view.mainPerCopy < 0 ? "akaji-ji" : "kuroji-ji"}`}
                          >
                            <span aria-hidden="true">
                              {formatChobo(view.mainPerCopy).text}
                            </span>
                            <span className="sr-only">
                              {formatChobo(view.mainPerCopy).aria}
                            </span>
                          </span>
                          <span className="tani" aria-hidden="true">
                            円
                          </span>
                          <span
                            className={`fuda ${view.mainPerCopy < 0 ? "fuda-akaji" : "fuda-kuroji"}`}
                          >
                            {view.mainPerCopy < 0 ? "赤字" : "黒字"}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              </div>

              {view.neverProfits && (
                <div
                  className="fusen fusen-shu"
                  style={{ marginTop: "var(--ma-2)" }}
                >
                  ※
                  この条件では何部刷っても黒字になりません。頒価を上げるか、印刷費・委託料率を見直してください。
                  {view.range !== null && (
                    <>
                      {" "}
                      <a href="#meyasu">頒価の目安レンジを見る</a>
                    </>
                  )}
                </div>
              )}

              {/* 損益線図 */}
              <div ref={attachSenzu}>
                <h3 className="shukei-komidashi">損益線図</h3>
                <ProfitChart
                  ready
                  copies={view.copies}
                  baseCost={view.baseCost}
                  series={view.seriesAll}
                  mainId={view.mainSeries?.id ?? null}
                  breakEvenMain={view.neverProfits ? null : view.mainBreakEven}
                  breakEvenExactMain={
                    view.neverProfits ? null : view.mainBreakEvenExact
                  }
                  legend={view.legend}
                  frozen={kensanchu}
                  onSelectMain={selectMain}
                  onToggleVisible={(id, visible) =>
                    updateChannel(id, { visible })
                  }
                  ariaLabel={chartAria}
                />
              </div>

              {/* 頒価の目安（横帯） */}
              {view.range !== null &&
                (() => {
                  const r = view.range;
                  const scaleMax = Math.max(r.at70, view.price) * 1.25;
                  const pct = (v: number): number =>
                    Math.min(100, Math.max(0, (v / scaleMax) * 100));
                  const inRange =
                    view.price >= r.sellout && view.price <= r.at70;
                  return (
                    <div id="meyasu">
                      <h3 className="shukei-komidashi">頒価の目安</h3>
                      <div className="meyasu-obi" aria-hidden="true">
                        <div
                          className="meyasu-nuri"
                          style={{
                            left: `${pct(r.sellout)}%`,
                            width: `${Math.max(1, pct(r.at70) - pct(r.sellout))}%`,
                          }}
                        />
                        <div
                          className="meyasu-ima"
                          style={{ left: `${pct(view.price)}%` }}
                        />
                      </div>
                      <p className="sai suji" style={{ marginTop: "4px" }}>
                        目安レンジ {r.sellout.toLocaleString("ja-JP")}〜
                        {r.at70.toLocaleString("ja-JP")}
                        円（完売で±0〜7割頒布で±0）。いまの頒価{" "}
                        {view.price.toLocaleString("ja-JP")}円は
                        {inRange
                          ? "目安レンジ内"
                          : view.price < r.sellout
                            ? "目安レンジより低め"
                            : "目安レンジより高め"}
                        。
                      </p>
                    </div>
                  );
                })()}

              {/* 配分プラン */}
              {(view.plannedBlocked || view.allocation !== null) && (
                <div>
                  <h3 className="shukei-komidashi">配分プラン</h3>
                  {view.plannedBlocked ? (
                    <p className="sai" style={{ color: "var(--shu)" }}>
                      予定部数を修正するまで計算できません（訂正が必要な行があります）
                    </p>
                  ) : (
                    view.allocation !== null && (
                      <div className="haibun-gyo">
                        <span>
                          {view.plans
                            .map((p) => `${p.name} ${p.copies}部`)
                            .join(" ＋ ")}{" "}
                          →
                        </span>
                        <strong
                          className={`suji ${view.allocation < 0 ? "akaji-ji" : "kuroji-ji"}`}
                          style={{
                            color:
                              view.allocation < 0
                                ? "var(--shu)"
                                : "var(--kuroji)",
                          }}
                        >
                          <span aria-hidden="true">
                            {formatChobo(view.allocation).text}
                          </span>
                          <span className="sr-only">
                            {formatChobo(view.allocation).aria}
                          </span>
                        </strong>
                        <span
                          className={`fuda ${view.allocation < 0 ? "fuda-akaji" : "fuda-kuroji"}`}
                        >
                          {view.allocation < 0 ? "赤字" : "黒字"}
                        </span>
                        {view.plannedTotal > view.copies && (
                          <span className="fuda fuda-akaji">
                            刷り部数 {view.copies}部 を超過
                          </span>
                        )}
                      </div>
                    )
                  )}
                </div>
              )}

              {/* 表で見る（25部刻み） */}
              <details
                className="tatami"
                style={{ marginTop: "var(--ma-3)" }}
                onToggle={(e) => setTableOpen(e.currentTarget.open)}
              >
                <summary>
                  表で見る（{tableStep(view.copies)}部刻みの損益）
                </summary>
                <div className="tatami-body">
                  {tableOpen && (
                    <div className="hyo-waku">
                      <table className="hyo suji">
                        <thead>
                          <tr>
                            <th scope="col" className="suji-col">
                              頒布数（部）
                            </th>
                            {view.seriesAll.map((s) => (
                              <th key={s.id} scope="col" className="suji-col">
                                {s.name}（円）
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {(() => {
                            const step = tableStep(view.copies);
                            const ks: number[] = [];
                            for (let k = 0; k < view.copies; k += step)
                              ks.push(k);
                            ks.push(view.copies);
                            return ks.map((k, ki) => {
                              const isBe =
                                view.mainBreakEven !== null &&
                                k >= view.mainBreakEven &&
                                k - step < view.mainBreakEven;
                              const isLast = ki === ks.length - 1;
                              return (
                                <tr
                                  key={k}
                                  className={isLast ? "shime" : undefined}
                                >
                                  <td className="suji-col">
                                    {k.toLocaleString("ja-JP")}
                                    {isBe && (
                                      <span className="fuda fuda-akaji">
                                        分岐
                                      </span>
                                    )}
                                  </td>
                                  {view.seriesAll.map((s) => {
                                    const v = profitAt(
                                      k,
                                      view.price,
                                      s.params,
                                      view.baseCost,
                                    );
                                    const c = formatChobo(v);
                                    return (
                                      <td
                                        key={s.id}
                                        className="suji-col"
                                        style={
                                          v < 0
                                            ? { color: "var(--shu)" }
                                            : undefined
                                        }
                                      >
                                        <span aria-hidden="true">{c.text}</span>
                                        <span className="sr-only">
                                          {c.aria}
                                        </span>
                                      </td>
                                    );
                                  })}
                                </tr>
                              );
                            });
                          })()}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </details>
            </div>
          )}
        </aside>
      </div>

      {/* 勘定尻バー（モバイル固定・線図が視界内の間は退避）。
          検算中は集計欄（§7）と同じく旧値を淡くし、朱の「検算中」で明示する */}
      <button
        type="button"
        className={`kanjo-bar suji${barTaihi ? " is-taihi" : ""}`}
        onClick={scrollToShukei}
      >
        {view !== null ? (
          <span>
            {kensanchu && <span className="shu-ji">検算中・訂正あり </span>}
            <span className={kensanchu ? "kensan-usui" : undefined}>
              分岐{" "}
              {view.neverProfits || view.mainBreakEven === null
                ? "―"
                : `${view.mainBreakEven.toLocaleString("ja-JP")}部`}
              ｜完売 {formatChobo(view.mainSellout).text}円
            </span>
          </span>
        ) : errorList.length > 0 ? (
          <span className="shu-ji">入力に訂正あり ▲</span>
        ) : (
          <span>記帳がそろうと損益が出ます</span>
        )}
        <span aria-hidden="true">↑</span>
      </button>
      <div className="kanjo-bar-yohaku" aria-hidden="true" />
    </>
  );
}
