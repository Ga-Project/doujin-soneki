"use client";

// 損益分岐シミュレータ（/ の主役）。
// 状態はこのコンポーネントに集約し、計算は lib/soneki.ts の純関数へ委譲する。
// 入力は即時反映（送信ボタンなし）・localStorage へ自動保存・復元。

import { useEffect, useMemo, useRef, useState } from "react";
import {
  allocationProfit,
  breakEvenCopies,
  breakEvenExact,
  formatSignedYen,
  normalizeTier,
  parseFeePercent,
  parseNum,
  perCopyAtSellout,
  priceRange,
  profitAt,
  selloutProfit,
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
import { ProfitChart, type ChartSeries, type SeriesColor } from "./ProfitChart";

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

// サンプルは明示ボタン経由でのみ投入する（badge-warn「サンプル値」を伴う）
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

const CONSIGN_COLORS: readonly { colorClass: SeriesColor; colorVar: string; dash: string }[] = [
  { colorClass: "series-c1", colorVar: "var(--chart-consign-1)", dash: "6 4" },
  { colorClass: "series-c2", colorVar: "var(--chart-consign-2)", dash: "2 4" },
  { colorClass: "series-c3", colorVar: "var(--chart-consign-3)", dash: "10 3 2 3" },
];
const MAX_CONSIGN = CONSIGN_COLORS.length;

interface SeriesInfo extends ChartSeries {
  kind: "direct" | "consign";
  params: ChannelParams;
  breakEven: number | null;
  breakEvenExactK: number | null;
  sellout: number;
}

// ---------------------------------------------------------------------------

export function Simulator() {
  const [state, setState] = useState<SimSaved>(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [restored, setRestored] = useState(false);
  const [restoreDismissed, setRestoreDismissed] = useState(false);
  const chartBlockRef = useRef<HTMLDivElement | null>(null);

  // 初回マウント時に前回値を復元（SSR とのハイドレーション不一致を避けるため effect で行う）
  useEffect(() => {
    const ok = storageAvailable();
    setStorageOk(ok);
    if (ok) {
      const saved = loadSim();
      if (saved !== null) {
        setState(saved);
        setRestored(true);
      }
    }
    setLoaded(true);
  }, []);

  // 変更を即時保存
  useEffect(() => {
    if (!loaded || !storageOk) return;
    saveSim(state);
  }, [state, loaded, storageOk]);

  /** ユーザー編集（サンプルバッジを外す）。 */
  const edit = (fn: (s: SimSaved) => SimSaved): void => {
    setState((s) => ({ ...fn(s), isSample: false }));
  };

  // --- 導出値 -------------------------------------------------------------

  const derived = useMemo(() => {
    const price = parseNum(state.price);
    const tiersNorm = new Map<string, Tier | null>(
      state.tiers.map((t) => [t.id, normalizeTier(t)]),
    );
    const selectedTier = tiersNorm.get(state.selectedTierId) ?? null;
    const fixedSum = (parseNum(state.fixedEvent) ?? 0) + (parseNum(state.fixedOther) ?? 0);
    const baseCost = selectedTier === null ? 0 : selectedTier.totalCost + fixedSum;
    const ready = price !== null && price > 0 && selectedTier !== null;

    // チャネル → 系列
    let consignIndex = 0;
    const seriesAll: SeriesInfo[] = [];
    const feeErrors: string[] = [];
    for (const ch of state.channels) {
      let color: { colorClass: SeriesColor; colorVar: string; dash?: string } = {
        colorClass: "series-direct",
        colorVar: "var(--chart-direct)",
      };
      if (ch.kind === "consign") {
        const c = CONSIGN_COLORS[consignIndex];
        consignIndex += 1;
        if (c === undefined) continue;
        color = c;
      }
      const feePct = ch.kind === "direct" ? 0 : parseFeePercent(ch.fee);
      const perItem = ch.kind === "direct" ? 0 : (parseNum(ch.perItem) ?? 0);
      if (feePct === null) {
        if (ch.fee !== "") {
          feeErrors.push(`「${ch.name}」: 手数料率は 0〜100 の間で入れてください`);
        }
        continue;
      }
      if (!ch.visible) continue;
      const params: ChannelParams = { feeRate: feePct / 100, perItemFee: perItem };
      const p = price ?? 0;
      seriesAll.push({
        id: ch.id,
        name: ch.name,
        kind: ch.kind,
        params,
        net: p * (1 - params.feeRate) - params.perItemFee,
        breakEven: ready ? breakEvenCopies(p, params, baseCost) : null,
        breakEvenExactK: ready ? breakEvenExact(p, params, baseCost) : null,
        sellout:
          ready && selectedTier !== null ? selloutProfit(selectedTier.copies, p, params, baseCost) : 0,
        ...color,
      });
    }

    const mainSeries =
      seriesAll.find((s) => s.id === state.mainChannelId) ?? seriesAll[0] ?? null;

    // 入力エラー（状態デザイン: 計算不能）
    const rowErrors: string[] = [];
    for (const t of state.tiers) {
      const anyInput = t.copies !== "" || t.unit !== "" || t.total !== "";
      if (anyInput && tiersNorm.get(t.id) === null) {
        rowErrors.push("部数と単価をセットで入れてください（例: 100部・単価320円）");
        break;
      }
    }
    const anyInput =
      state.price !== "" ||
      state.tiers.some((t) => t.copies !== "" || t.unit !== "" || t.total !== "");
    const missing: string[] = [];
    if (anyInput && (price === null || price <= 0)) {
      missing.push("頒価が入っていません。1冊いくらで頒布するかを入れてください");
    }
    if (anyInput && selectedTier === null) {
      missing.push("印刷費の単価表で「この部数で刷る」行を完成させて選んでください");
    }

    // 配分プラン（予定部数）
    const plans: { name: string; copies: number; ch: ChannelParams }[] = [];
    for (const s of seriesAll) {
      const chRow = state.channels.find((c) => c.id === s.id);
      const planned = chRow === undefined ? null : parseNum(chRow.planned);
      if (planned !== null && planned > 0 && Number.isInteger(planned)) {
        plans.push({ name: s.name, copies: planned, ch: s.params });
      }
    }
    const plannedTotal = plans.reduce((acc, p) => acc + p.copies, 0);
    const allocation =
      ready && plans.length > 0 && price !== null
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
      baseCost,
      ready,
      seriesAll,
      mainSeries,
      feeErrors,
      rowErrors,
      missing,
      plans,
      plannedTotal,
      allocation,
      range,
    };
  }, [state]);

  const {
    price,
    tiersNorm,
    selectedTier,
    baseCost,
    ready,
    seriesAll,
    mainSeries,
    feeErrors,
    rowErrors,
    missing,
    plans,
    plannedTotal,
    allocation,
    range,
  } = derived;

  // --- ハンドラ -----------------------------------------------------------

  /** 選択中の行が未完成なら、完成している最初の行に選択を移す。 */
  const ensureSelection = (s: SimSaved): SimSaved => {
    const selected = s.tiers.find((t) => t.id === s.selectedTierId);
    if (selected !== undefined && normalizeTier(selected) !== null) return s;
    const firstComplete = s.tiers.find((t) => normalizeTier(t) !== null);
    return firstComplete === undefined ? s : { ...s, selectedTierId: firstComplete.id };
  };

  const updateTier = (id: string, patch: Partial<SavedTierRow>): void => {
    edit((s) =>
      ensureSelection({
        ...s,
        tiers: s.tiers.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      }),
    );
  };

  const addTier = (): void => {
    edit((s) => ({
      ...s,
      tiers: [...s.tiers, { id: newId("t"), copies: "", unit: "", total: "", basis: "unit" }],
    }));
  };

  const removeTier = (id: string): void => {
    edit((s) => {
      if (s.tiers.length <= 2) return s; // 最低 2 行は維持
      return ensureSelection({ ...s, tiers: s.tiers.filter((t) => t.id !== id) });
    });
  };

  const updateChannel = (id: string, patch: Partial<SavedChannel>): void => {
    edit((s) => ({
      ...s,
      channels: s.channels.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    }));
  };

  const addChannel = (preset: { name: string; fee: string; perItem: string; note?: string; sourceUrl?: string }): void => {
    edit((s) => {
      if (s.channels.filter((c) => c.kind === "consign").length >= MAX_CONSIGN) return s;
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
    setState((s) => ({ ...s, mainChannelId: id }));
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
    setState({
      ...DEFAULT_STATE,
      tiers: DEFAULT_STATE.tiers.map((t) => ({ ...t })),
      channels: DEFAULT_STATE.channels.map((c) => ({ ...c })),
    });
    setRestored(false);
    setRestoreDismissed(true);
  };

  const scrollToChart = (): void => {
    chartBlockRef.current?.scrollIntoView({ block: "start" });
  };

  // --- 表示用の文言 --------------------------------------------------------

  const copies = selectedTier?.copies ?? 100;
  const mainBreakEven = mainSeries?.breakEven ?? null;
  const mainSellout = mainSeries?.sellout ?? 0;
  const mainPerCopy =
    ready && mainSeries !== null && selectedTier !== null && price !== null
      ? perCopyAtSellout(selectedTier.copies, price, mainSeries.params, baseCost)
      : null;
  const neverProfits = ready && mainSeries !== null && mainSeries.net <= 0;

  let sentence = "";
  if (ready && mainSeries !== null && selectedTier !== null) {
    if (neverProfits) {
      sentence =
        "この頒価と単価では、何部頒布しても黒字になりません。頒価・部数・チャネルを変えて試してみてください";
    } else if (mainBreakEven !== null && mainBreakEven <= selectedTier.copies) {
      sentence = `${mainBreakEven}部から黒字になります。完売なら ${formatSignedYen(mainSellout)} です`;
    } else {
      sentence = `${selectedTier.copies}部完売でも ${formatSignedYen(mainSellout)} です。赤字覚悟で刷るか、条件を変えて試すかはあなた次第です`;
    }
  }

  const chartAria =
    ready && mainSeries !== null
      ? neverProfits || mainBreakEven === null
        ? "損益グラフ。この条件では黒字になりません"
        : `損益グラフ。${mainSeries.name}は${mainBreakEven}部で黒字転換、完売時は${formatSignedYen(mainSellout)}`
      : "損益グラフ。入力が完了すると損益カーブが表示されます";

  const errorList = [...missing, ...rowErrors, ...feeErrors];
  const consignCount = seriesAll.filter((s) => s.kind === "consign").length;

  // ---------------------------------------------------------------------------

  return (
    <div>
      {/* 状態バー群（復元・保存不可・サンプル） */}
      {restored && !restoreDismissed && (
        <div className="alert restore-bar" role="status" style={{ marginBottom: "var(--sp-4)" }}>
          <span>前回の入力を復元しました</span>
          <button type="button" className="btn btn-secondary" onClick={resetAll}>
            最初からやり直す
          </button>
          <button
            type="button"
            className="btn btn-ghost dismiss"
            aria-label="この通知を閉じる"
            onClick={() => setRestoreDismissed(true)}
          >
            ×
          </button>
        </div>
      )}
      {loaded && !storageOk && (
        <div className="alert alert-warn" role="status" style={{ marginBottom: "var(--sp-4)" }}>
          この環境ではデータを保存できません。ページを閉じると入力が消えます
        </div>
      )}

      <div className="sim-layout">
        {/* ===== 入力レール（製図台の左） ===== */}
        <div className="panel-input">
          {state.isSample && (
            <p className="sample-row">
              <span className="badge badge-warn">サンプル値</span>
              サンプルの数字です。自分の見積もりに書き換えてください
            </p>
          )}

          {/* ① 頒価と刷り部数 */}
          <section className="panel-block" aria-labelledby="legend-price">
            <h3 className="panel-legend" id="legend-price">
              <span className="step-no" aria-hidden="true">
                1
              </span>
              頒価と刷り部数
            </h3>
            <div className="field">
              <label htmlFor="price-input">頒価（1冊の値段）</label>
              <div className="suffix-field">
                <input
                  id="price-input"
                  type="number"
                  inputMode="numeric"
                  min="0"
                  step="10"
                  value={state.price}
                  onChange={(e) => edit((s) => ({ ...s, price: e.target.value }))}
                  aria-invalid={state.price !== "" && (price === null || price <= 0)}
                  className="tabular"
                />
                <span className="suffix">円</span>
              </div>
              {state.price !== "" && (price === null || price <= 0) && (
                <p className="field-error">
                  頒価が入っていません。1冊いくらで頒布するかを入れてください
                </p>
              )}
            </div>
            <p className="field-hint">
              刷り部数は ② の単価表から「この部数で刷る」行を選びます
              {selectedTier !== null && (
                <>
                  （現在: <strong className="tabular">{selectedTier.copies}部</strong>）
                </>
              )}
            </p>
          </section>

          {/* ② 印刷費（階段単価テーブル） */}
          <section className="panel-block" aria-labelledby="legend-tiers">
            <h3 className="panel-legend" id="legend-tiers">
              <span className="step-no" aria-hidden="true">
                2
              </span>
              印刷費（部数ごとの単価表）
            </h3>
            <p className="field-hint">
              印刷所の見積にある「部数ごとの単価」をそのまま写します。部数が増えるほど1冊あたりは安くなるのが一般的です。単価か総額のどちらかを入れれば、もう一方は自動計算されます
            </p>
            <div className="table-scroll">
              <table className="tier-table">
                <thead>
                  <tr>
                    <th scope="col">
                      <span className="sr-only">この部数で刷る</span>選択
                    </th>
                    <th scope="col">部数</th>
                    <th scope="col">単価（円/冊）</th>
                    <th scope="col">総額（円）</th>
                    <th scope="col">
                      <span className="sr-only">行の削除</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {state.tiers.map((t, i) => {
                    const norm = tiersNorm.get(t.id) ?? null;
                    const selected = state.selectedTierId === t.id;
                    const unitValue =
                      t.basis === "unit"
                        ? t.unit
                        : norm === null
                          ? ""
                          : String(Math.round(norm.unitCost * 10) / 10);
                    const totalValue =
                      t.basis === "total"
                        ? t.total
                        : norm === null
                          ? ""
                          : String(Math.round(norm.totalCost));
                    return (
                      <tr key={t.id} className={selected ? "is-selected" : undefined}>
                        <td>
                          <label className="tier-select">
                            <input
                              type="radio"
                              name="tier-select"
                              checked={selected}
                              disabled={norm === null}
                              onChange={() =>
                                setState((s) => ({ ...s, selectedTierId: t.id }))
                              }
                              aria-label={`この部数で刷る（${t.copies === "" ? `${i + 1}行目` : `${t.copies}部`}）`}
                            />
                          </label>
                        </td>
                        <td>
                          <input
                            type="number"
                            inputMode="numeric"
                            min="1"
                            step="1"
                            className="col-copies tabular"
                            value={t.copies}
                            onChange={(e) => updateTier(t.id, { copies: e.target.value })}
                            aria-label={`${i + 1}行目の部数`}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            inputMode="decimal"
                            min="0"
                            className={`col-money tabular${t.basis === "total" ? " is-derived" : ""}`}
                            value={unitValue}
                            onChange={(e) =>
                              updateTier(t.id, { unit: e.target.value, basis: "unit" })
                            }
                            aria-label={`${i + 1}行目の単価（円/冊）`}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            inputMode="numeric"
                            min="0"
                            className={`col-money tabular${t.basis === "unit" ? " is-derived" : ""}`}
                            value={totalValue}
                            onChange={(e) =>
                              updateTier(t.id, { total: e.target.value, basis: "total" })
                            }
                            aria-label={`${i + 1}行目の総額（円）`}
                          />
                        </td>
                        <td>
                          <button
                            type="button"
                            className="btn-icon"
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
            {rowErrors.map((msg) => (
              <p key={msg} className="field-error">
                {msg}
              </p>
            ))}
            <div className="preset-row">
              <button type="button" className="btn btn-secondary" onClick={addTier}>
                ＋ 行を追加
              </button>
              <button type="button" className="btn btn-ghost" onClick={applySample}>
                サンプルの数字で試す
              </button>
            </div>
          </section>

          {/* ③ 頒布チャネル（手数料・配分） */}
          <section className="panel-block" aria-labelledby="legend-channels">
            <h3 className="panel-legend" id="legend-channels">
              <span className="step-no" aria-hidden="true">
                3
              </span>
              頒布チャネル（手数料）
            </h3>
            <p className="field-hint">
              手数料率は、頒価から差し引かれる販売手数料の割合です。委託先の最新の案内に記載の料率を入れてください
            </p>
            <div className="channel-list">
              {state.channels.map((ch) => {
                const s = seriesAll.find((x) => x.id === ch.id);
                const feeInvalid =
                  ch.kind === "consign" && ch.fee !== "" && parseFeePercent(ch.fee) === null;
                return (
                  <div
                    key={ch.id}
                    className={`channel-card${state.mainChannelId === ch.id ? " is-main" : ""}`}
                  >
                    <div className="channel-head">
                      <span className={s?.colorClass ?? "series-direct"} aria-hidden="true">
                        <span className="series-swatch" />
                      </span>
                      {ch.kind === "direct" ? (
                        <strong>{ch.name}（手数料 0%）</strong>
                      ) : (
                        <input
                          type="text"
                          value={ch.name}
                          onChange={(e) => updateChannel(ch.id, { name: e.target.value })}
                          aria-label="委託先の名前"
                        />
                      )}
                      {ch.kind === "consign" && (
                        <button
                          type="button"
                          className="btn-icon"
                          onClick={() => removeChannel(ch.id)}
                          aria-label={`${ch.name}を削除`}
                        >
                          ×
                        </button>
                      )}
                    </div>
                    <div className="channel-controls">
                      {ch.kind === "consign" && (
                        <>
                          <div className="field">
                            <label htmlFor={`fee-${ch.id}`}>手数料率</label>
                            <div className="suffix-field">
                              <input
                                id={`fee-${ch.id}`}
                                type="number"
                                inputMode="decimal"
                                min="0"
                                max="100"
                                step="0.1"
                                value={ch.fee}
                                onChange={(e) => updateChannel(ch.id, { fee: e.target.value })}
                                aria-invalid={feeInvalid}
                                className="tabular"
                              />
                              <span className="suffix">%</span>
                            </div>
                            {feeInvalid && (
                              <p className="field-error">
                                手数料率は 0〜100 の間で入れてください
                              </p>
                            )}
                          </div>
                          <div className="field">
                            <label htmlFor={`per-${ch.id}`}>定額手数料</label>
                            <div className="suffix-field">
                              <input
                                id={`per-${ch.id}`}
                                type="number"
                                inputMode="numeric"
                                min="0"
                                value={ch.perItem}
                                onChange={(e) =>
                                  updateChannel(ch.id, { perItem: e.target.value })
                                }
                                className="tabular"
                              />
                              <span className="suffix">円/冊</span>
                            </div>
                          </div>
                        </>
                      )}
                      <div className="field">
                        <label htmlFor={`plan-${ch.id}`}>予定部数（任意）</label>
                        <div className="suffix-field">
                          <input
                            id={`plan-${ch.id}`}
                            type="number"
                            inputMode="numeric"
                            min="0"
                            step="1"
                            value={ch.planned}
                            onChange={(e) => updateChannel(ch.id, { planned: e.target.value })}
                            className="tabular"
                          />
                          <span className="suffix">部</span>
                        </div>
                      </div>
                    </div>
                    <div className="channel-toggles">
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={ch.visible}
                          onChange={(e) => updateChannel(ch.id, { visible: e.target.checked })}
                        />
                        グラフに表示
                      </label>
                      <label className="check-label">
                        <input
                          type="radio"
                          name="main-channel"
                          checked={state.mainChannelId === ch.id}
                          onChange={() => selectMain(ch.id)}
                        />
                        主チャネル
                      </label>
                    </div>
                    {ch.note !== undefined && (
                      <p className="source-note">
                        {ch.note}
                        {ch.sourceUrl !== undefined && (
                          <>
                            {" "}
                            <a href={ch.sourceUrl} target="_blank" rel="noopener noreferrer">
                              出典 ↗
                            </a>
                          </>
                        )}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="preset-row" role="group" aria-label="委託先を追加">
              {CONSIGN_PRESETS.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className="btn btn-secondary"
                  disabled={consignCount >= MAX_CONSIGN}
                  onClick={() =>
                    addChannel({
                      name: p.name,
                      fee: p.fee,
                      perItem: p.perItem === "" ? "0" : p.perItem,
                      note: p.note,
                      ...(p.sourceUrl === null ? {} : { sourceUrl: p.sourceUrl }),
                    })
                  }
                >
                  ＋ {p.name}
                </button>
              ))}
              <button
                type="button"
                className="btn btn-ghost"
                disabled={consignCount >= MAX_CONSIGN}
                onClick={() => addChannel({ name: "委託先", fee: "", perItem: "0" })}
              >
                ＋ その他の委託先
              </button>
            </div>
            <p className="source-note">
              プリセットの料率は各委託先の公開情報にもとづく目安で、編集できます。料率は改定されることがあります。最新の料率は各委託先の公式の案内でご確認ください
            </p>
          </section>

          {/* 詳細オプション（固定費） */}
          <details className="panel-details">
            <summary>詳細オプション（イベント参加費などの固定費）</summary>
            <div className="details-body">
              <div className="field">
                <label htmlFor="fixed-event">イベント参加費</label>
                <div className="suffix-field">
                  <input
                    id="fixed-event"
                    type="number"
                    inputMode="numeric"
                    min="0"
                    value={state.fixedEvent}
                    onChange={(e) => edit((s) => ({ ...s, fixedEvent: e.target.value }))}
                    className="tabular"
                  />
                  <span className="suffix">円</span>
                </div>
              </div>
              <div className="field">
                <label htmlFor="fixed-other">その他の固定費（交通費・備品など）</label>
                <div className="suffix-field">
                  <input
                    id="fixed-other"
                    type="number"
                    inputMode="numeric"
                    min="0"
                    value={state.fixedOther}
                    onChange={(e) => edit((s) => ({ ...s, fixedOther: e.target.value }))}
                    className="tabular"
                  />
                  <span className="suffix">円</span>
                </div>
              </div>
              <p className="field-hint">既定は 0 円。オプション費用・送料などもここに加算できます</p>
            </div>
          </details>
        </div>

        {/* ===== 結果ステージ（製図台の右） ===== */}
        <div className="results-stage" aria-label="計算結果">
          {/* KPI ストリップ */}
          <div className="kpi-block">
            {errorList.length > 0 && (
              <div className="alert" role="status">
                <div>
                  {errorList.map((msg) => (
                    <p key={msg} style={{ margin: 0 }}>
                      {msg}
                    </p>
                  ))}
                </div>
              </div>
            )}
            <div className="kpi-strip">
              <div className="stat">
                <span className="stat-label">損益分岐</span>
                <span className="stat-value tabular">
                  {ready && !neverProfits && mainBreakEven !== null ? (
                    <>
                      {mainBreakEven}
                      <span className="stat-unit">部</span>
                    </>
                  ) : (
                    "—"
                  )}
                </span>
                {neverProfits && (
                  <span className="badge badge-warn">この条件では黒字になりません</span>
                )}
              </div>
              <div className="stat">
                <span className="stat-label">完売時</span>
                <span
                  className={`stat-value tabular${
                    ready ? (mainSellout >= 0 ? " is-ok" : " is-err") : ""
                  }`}
                >
                  {ready ? formatSignedYen(mainSellout) : "—"}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">1冊あたり</span>
                <span
                  className={`stat-value tabular${
                    ready && mainPerCopy !== null ? (mainPerCopy >= 0 ? " is-ok" : " is-err") : ""
                  }`}
                >
                  {ready && mainPerCopy !== null ? formatSignedYen(mainPerCopy) : "—"}
                </span>
              </div>
            </div>

            {/* 非主チャネルの分岐チップ */}
            {ready && seriesAll.length > 1 && (
              <div className="kpi-chips">
                {seriesAll
                  .filter((s) => s.id !== (mainSeries?.id ?? ""))
                  .map((s) => (
                    <span key={s.id} className="chip tabular">
                      <span className={s.colorClass} aria-hidden="true">
                        <span className="series-swatch" />
                      </span>
                      {s.name}: {s.breakEven === null ? "黒字化なし" : `${s.breakEven}部`}
                    </span>
                  ))}
              </div>
            )}

            <p className="result-sentence" aria-live="polite" aria-atomic="true">
              {sentence}
            </p>

            {range !== null && (
              <p className="price-range-row tabular">
                頒価の目安レンジ: ¥{range.sellout.toLocaleString("ja-JP")}〜¥
                {range.at70.toLocaleString("ja-JP")}
                （完売で±0〜7割頒布で±0になる頒価。入力値から算出した目安です）
              </p>
            )}

            {ready && allocation !== null && (
              <p className="price-range-row tabular">
                配分プラン: {plans.map((p) => `${p.name} ${p.copies}部`).join(" ＋ ")} →{" "}
                {formatSignedYen(allocation)}
                {selectedTier !== null && plannedTotal > selectedTier.copies && (
                  <>
                    {" "}
                    <span className="badge badge-warn">
                      予定部数の合計が刷り部数（{selectedTier.copies}部）を超えています
                    </span>
                  </>
                )}
              </p>
            )}
          </div>

          {/* 損益グラフ */}
          <div className="chart-block" ref={chartBlockRef} id="profit-chart">
            <ProfitChart
              ready={ready}
              copies={copies}
              baseCost={baseCost}
              series={seriesAll}
              mainId={mainSeries?.id ?? null}
              breakEvenExactMain={mainSeries?.breakEvenExactK ?? null}
              breakEvenLabel={
                mainBreakEven === null ? null : `損益分岐 ${mainBreakEven}部`
              }
              selloutLabel={ready ? `完売 ${formatSignedYen(mainSellout)}` : null}
              selloutPositive={mainSellout >= 0}
              onSelectMain={selectMain}
              ariaLabel={chartAria}
            >
              {!ready && (
                <div className="chart-empty-msg">
                  <p style={{ margin: 0 }}>単価表を入れると、ここに損益カーブが描かれます</p>
                  <button type="button" className="btn btn-secondary" onClick={applySample}>
                    サンプルの数字で試す
                  </button>
                </div>
              )}
            </ProfitChart>
          </div>

          {/* 表で見る（計算根拠の全数値開示） */}
          <div className="datatable-block">
            <details>
              <summary>表で見る（25部刻みの損益）</summary>
              {ready && selectedTier !== null && price !== null ? (
                <div className="table-scroll">
                  <table className="data-table tabular">
                    <thead>
                      <tr>
                        <th scope="col">頒布数</th>
                        {seriesAll.map((s) => (
                          <th key={s.id} scope="col">
                            {s.name}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {(() => {
                        const ks: number[] = [];
                        for (let k = 0; k < selectedTier.copies; k += 25) ks.push(k);
                        ks.push(selectedTier.copies);
                        return ks.map((k) => {
                          const isBe =
                            mainBreakEven !== null &&
                            k >= mainBreakEven &&
                            k - 25 < mainBreakEven;
                          return (
                            <tr key={k} className={isBe ? "is-breakeven" : undefined}>
                              <td>{k}部</td>
                              {seriesAll.map((s) => {
                                const v = profitAt(k, price, s.params, baseCost);
                                return (
                                  <td key={s.id} className={v >= 0 ? "is-ok" : "is-err"}>
                                    {formatSignedYen(v)}
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
              ) : (
                <p style={{ padding: "0 var(--sp-4) var(--sp-4)" }} className="field-hint">
                  入力が完了すると、部数ごとの損益を表で確認できます
                </p>
              )}
            </details>
          </div>
        </div>
      </div>

      {/* モバイル: 下端固定ミニ結果バー（タップでグラフへ） */}
      <button type="button" className="mini-result tabular" onClick={scrollToChart}>
        {ready ? (
          <span>
            {neverProfits || mainBreakEven === null ? "黒字化なし" : `分岐 ${mainBreakEven}部`}
            {" ・ "}完売 {formatSignedYen(mainSellout)}
          </span>
        ) : (
          <span className="mini-hint">入力を続けると損益が出ます</span>
        )}
        <span className="mini-arrow" aria-hidden="true">
          ↑ グラフ
        </span>
      </button>
    </div>
  );
}
