"use client";

// 損益グラフ（インライン SVG・ライブラリ不使用）。
// X 軸 = 頒布数（0〜刷り部数）、Y 軸 = 損益（円）。各チャネルは一次直線。
// 黒字/赤字ゾーンの塗り分け・ゼロライン・損益分岐マーカー・完売点を描く。
// 系列の切替ボタンとツールチップは HTML 要素（フォーカス可視化・44px タップ領域の確保）。
// 同じ数値は KPI と「表で見る」の DOM テキストでも必ず取得できる（このグラフは強化表現）。

import {
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { compactYen, formatSignedYen, tickValues } from "@/lib/soneki";

export type SeriesColor =
  | "series-direct"
  | "series-c1"
  | "series-c2"
  | "series-c3";

export interface ChartSeries {
  id: string;
  name: string;
  colorClass: SeriesColor;
  colorVar: string;
  /** stroke-dasharray（実線は undefined）。色・線種・末端ラベルの三重符号化。 */
  dash?: string;
  /** 1 冊あたり手取り（円）。損益(k) = k × net − baseCost。 */
  net: number;
}

interface Props {
  ready: boolean;
  /** 刷り部数（X 軸上限）。ready=false のときは座標平面表示用のダミー。 */
  copies: number;
  /** 印刷総額 + 固定費。 */
  baseCost: number;
  series: ChartSeries[];
  mainId: string | null;
  /** 主チャネルの損益分岐の厳密交点（部・非整数可）。無ければ null。 */
  breakEvenExactMain: number | null;
  /** マーカーのピル文言（例:「損益分岐 320部」）。 */
  breakEvenLabel: string | null;
  /** 完売点の文言（例:「完売 +¥12,400」）。 */
  selloutLabel: string | null;
  selloutPositive: boolean;
  onSelectMain: (id: string) => void;
  ariaLabel: string;
  /** 空状態オーバーレイ（軸だけの座標平面の上に重ねる）。 */
  children?: ReactNode;
}

const W = 720;
const H = 450;
const PAD_L = 64;
const PAD_R = 88;
const PAD_T = 24;
const PAD_B = 40;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

/** ピル幅の概算（CJK 11px / それ以外 6.5px + 余白）。 */
function estimatePillWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += ch.charCodeAt(0) > 0x2000 ? 11 : 6.5;
  }
  return w + 20;
}

interface HoverState {
  k: number;
  mode: "mouse" | "touch";
}

export function ProfitChart({
  ready,
  copies,
  baseCost,
  series,
  mainId,
  breakEvenExactMain,
  breakEvenLabel,
  selloutLabel,
  selloutPositive,
  onSelectMain,
  ariaLabel,
  children,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  const xMax = Math.max(1, copies);

  // Y ドメイン: 全系列の端点と 0 を含め、上下に 8% 余白。
  let yMin = Math.min(0, -baseCost);
  let yMax = 0;
  for (const s of series) {
    const end = xMax * s.net - baseCost;
    yMin = Math.min(yMin, end);
    yMax = Math.max(yMax, end);
  }
  if (!ready) {
    yMin = -10000;
    yMax = 10000;
  }
  if (yMax - yMin < 1) {
    yMax = yMin + 1;
  }
  const pad = (yMax - yMin) * 0.08;
  const yTop = yMax + pad;
  const yBot = yMin - pad;

  const x = (k: number): number => PAD_L + (k / xMax) * PLOT_W;
  const y = (v: number): number =>
    PAD_T + ((yTop - v) / (yTop - yBot)) * PLOT_H;
  const y0 = y(0);

  const xTicks = tickValues(0, xMax, 5).filter((v) => v >= 0 && v <= xMax);
  const yTicks = tickValues(yBot, yTop, 5);

  // 主チャネルを最後（最前面）に描く
  const ordered = [...series].sort(
    (a, b) => (a.id === mainId ? 1 : 0) - (b.id === mainId ? 1 : 0),
  );
  const main = series.find((s) => s.id === mainId) ?? null;

  // ポインタ位置 → 最近傍の部数スナップ
  const handlePointer = (e: ReactPointerEvent<SVGRectElement>): void => {
    const svg = svgRef.current;
    if (svg === null || !ready) return;
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    const k = Math.min(
      xMax,
      Math.max(0, Math.round(((relX - PAD_L) / PLOT_W) * xMax)),
    );
    setHover({ k, mode: e.pointerType === "touch" ? "touch" : "mouse" });
  };
  const handleLeave = (): void => {
    // タッチはグラフ直下の固定読み出し行に残す（指で隠れない）。マウスのみ消す。
    setHover((h) => (h !== null && h.mode === "mouse" ? null : h));
  };

  // 線末端ラベル（HTML ボタン）の縦位置を重ならないように分散（最小間隔 10%）
  const endLabels = series
    .map((s) => ({
      s,
      topPct: (y(ready ? xMax * s.net - baseCost : 0) / H) * 100,
    }))
    .sort((a, b) => a.topPct - b.topPct);
  for (let i = 0; i < endLabels.length; i += 1) {
    const item = endLabels[i];
    if (item === undefined) continue;
    const prev = endLabels[i - 1];
    const minTop = prev === undefined ? 6 : prev.topPct + 10;
    item.topPct = Math.min(94, Math.max(item.topPct, minTop));
  }

  // 損益分岐マーカー
  const bex =
    ready && breakEvenExactMain !== null && breakEvenExactMain <= xMax
      ? x(breakEvenExactMain)
      : null;
  const pillText = breakEvenLabel ?? "";
  const pillW = estimatePillWidth(pillText);
  const pillCx =
    bex === null
      ? 0
      : Math.min(W - PAD_R - pillW / 2, Math.max(PAD_L + pillW / 2, bex));
  const pillAbove = bex !== null && y0 - PAD_T > 56;
  const pillY = pillAbove ? y0 - 44 : y0 + 16;

  // 完売点（主チャネル）
  const mainEndY = main !== null ? y(xMax * main.net - baseCost) : 0;

  const tipRows =
    hover !== null && ready
      ? series.map((s) => ({
          id: s.id,
          name: s.name,
          colorClass: s.colorClass,
          value: formatSignedYen(hover.k * s.net - baseCost),
        }))
      : [];

  return (
    <>
      <div className="chart-card">
        <div className="chart-wrap">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={ariaLabel}
            preserveAspectRatio="xMidYMid meet"
          >
            {/* 黒字/赤字ゾーン（淡色 tint。情報の主担体にはしない） */}
            {yTop > 0 && (
              <rect
                x={PAD_L}
                y={PAD_T}
                width={PLOT_W}
                height={Math.max(0, y0 - PAD_T)}
                fill="var(--chart-zone-profit)"
              />
            )}
            {yBot < 0 && (
              <rect
                x={PAD_L}
                y={y0}
                width={PLOT_W}
                height={Math.max(0, H - PAD_B - y0)}
                fill="var(--chart-zone-loss)"
              />
            )}
            {/* ゾーンラベル（色だけに頼らないための直書きテキスト） */}
            {y0 - PAD_T > 26 && (
              <text
                x={PAD_L + 10}
                y={PAD_T + 16}
                fontSize="11"
                fill="var(--text-dim)"
              >
                黒字
              </text>
            )}
            {H - PAD_B - y0 > 26 && (
              <text
                x={PAD_L + 10}
                y={H - PAD_B - 10}
                fontSize="11"
                fill="var(--text-dim)"
              >
                赤字
              </text>
            )}

            {/* グリッド（キリ値・製図的に細く） */}
            {yTicks.map((v) => (
              <g key={`y${v}`}>
                <line
                  x1={PAD_L}
                  x2={W - PAD_R}
                  y1={y(v)}
                  y2={y(v)}
                  stroke="var(--chart-grid)"
                  strokeWidth="1"
                  shapeRendering="crispEdges"
                />
                <text
                  x={PAD_L - 8}
                  y={y(v) + 4}
                  fontSize="11"
                  fill="var(--text-dim)"
                  textAnchor="end"
                  className="tabular"
                >
                  {compactYen(v)}
                </text>
              </g>
            ))}
            {xTicks.map((v) => (
              <g key={`x${v}`}>
                <line
                  x1={x(v)}
                  x2={x(v)}
                  y1={PAD_T}
                  y2={H - PAD_B}
                  stroke="var(--chart-grid)"
                  strokeWidth="1"
                  shapeRendering="crispEdges"
                />
                <text
                  x={x(v)}
                  y={H - PAD_B + 18}
                  fontSize="11"
                  fill="var(--text-dim)"
                  textAnchor="middle"
                  className="tabular"
                >
                  {v === 0 ? "0" : `${v}部`}
                </text>
              </g>
            ))}

            {/* ゼロライン（グリッドより明確に強く） */}
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={y0}
              y2={y0}
              stroke="var(--chart-zero)"
              strokeWidth="1.5"
              shapeRendering="crispEdges"
            />

            {/* クロスヘア（最近傍の部数にスナップ） */}
            {hover !== null && ready && (
              <line
                x1={x(hover.k)}
                x2={x(hover.k)}
                y1={PAD_T}
                y2={H - PAD_B}
                stroke="var(--chart-zero)"
                strokeWidth="1"
                strokeDasharray="4 4"
              />
            )}

            {/* 系列線（色 + 線種 + 末端ラベルの三重符号化） */}
            {ready &&
              ordered.map((s) => (
                <path
                  key={s.id}
                  className="chart-line"
                  d={`M ${x(0)} ${y(-baseCost)} L ${x(xMax)} ${y(xMax * s.net - baseCost)}`}
                  stroke={s.colorVar}
                  strokeDasharray={s.dash}
                  strokeLinecap="round"
                  opacity={s.id === mainId || mainId === null ? 1 : 0.75}
                />
              ))}

            {/* 損益分岐マーカー（主チャネル線と y=0 の交点） */}
            {bex !== null && (
              <g>
                <line
                  x1={bex}
                  x2={bex}
                  y1={PAD_T}
                  y2={y0}
                  stroke="var(--accent)"
                  strokeWidth="1"
                  strokeDasharray="4 4"
                />
                <circle
                  cx={bex}
                  cy={y0}
                  r="5"
                  fill="var(--accent)"
                  stroke="var(--bg)"
                  strokeWidth="2"
                />
                {breakEvenLabel !== null && (
                  <g>
                    <rect
                      x={pillCx - pillW / 2}
                      y={pillY}
                      width={pillW}
                      height={22}
                      rx={11}
                      fill="var(--accent-tint)"
                      stroke="var(--accent)"
                      strokeOpacity="0.35"
                    />
                    <text
                      x={pillCx}
                      y={pillY + 15}
                      fontSize="11"
                      fontWeight="700"
                      fill="var(--accent)"
                      textAnchor="middle"
                      className="tabular"
                    >
                      {pillText}
                    </text>
                  </g>
                )}
              </g>
            )}

            {/* 完売点（主チャネルの線末端） */}
            {ready && main !== null && (
              <g>
                <circle
                  cx={x(xMax)}
                  cy={mainEndY}
                  r="3.5"
                  fill={selloutPositive ? "var(--ok)" : "var(--err)"}
                />
                {selloutLabel !== null && (
                  <text
                    x={x(xMax) - 6}
                    y={mainEndY < PAD_T + 24 ? mainEndY + 18 : mainEndY - 10}
                    fontSize="11"
                    fontWeight="700"
                    fill={selloutPositive ? "var(--ok)" : "var(--err)"}
                    textAnchor="end"
                    className="tabular"
                  >
                    {selloutLabel}
                  </text>
                )}
              </g>
            )}

            {/* ポインタ捕捉レイヤ（ホバー/タップ/ドラッグでスナップ読み取り） */}
            {ready && (
              <rect
                x={PAD_L}
                y={PAD_T}
                width={PLOT_W}
                height={PLOT_H}
                fill="transparent"
                onPointerMove={handlePointer}
                onPointerDown={handlePointer}
                onPointerLeave={handleLeave}
              />
            )}
          </svg>

          {/* 系列末端ラベル（HTML ボタン: クリックで主チャネル切替・44px タップ領域）。
              left + max-width = 100% を対で指定し、コンテナ外へのはみ出しをゼロにする */}
          {ready &&
            endLabels.map(({ s, topPct }) => {
              const leftPct = ((W - PAD_R + 2) / W) * 100;
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`chart-endlabel ${s.colorClass}`}
                  style={{
                    left: `${leftPct}%`,
                    top: `${topPct}%`,
                    maxWidth: `${100 - leftPct}%`,
                  }}
                  aria-pressed={s.id === mainId}
                  aria-label={`${s.name}を主チャネルにする`}
                  onClick={() => onSelectMain(s.id)}
                >
                  <span className="endlabel-pill">
                    <span className="endlabel-text">{s.name}</span>
                  </span>
                </button>
              );
            })}

          {/* ツールチップ（マウスのみ。タッチは下の固定読み出し行へ） */}
          {hover !== null && hover.mode === "mouse" && ready && (
            <div
              className="chart-tip tabular"
              style={{
                left: `${Math.min(80, Math.max(20, (x(hover.k) / W) * 100))}%`,
                top: "10%",
                transform: "translateX(-50%)",
              }}
            >
              <div className="tip-title">{hover.k}部頒布時</div>
              {tipRows.map((r) => (
                <div key={r.id}>
                  <span className={r.colorClass}>
                    <span className="series-swatch" />
                  </span>{" "}
                  {r.name}: {r.value}
                </div>
              ))}
            </div>
          )}

          {/* 空状態オーバーレイ（軸とグリッドだけの座標平面の上） */}
          {children}
        </div>
      </div>

      {/* タッチ用の固定読み出し行（指で隠れない位置に表示） */}
      <div className="chart-readout tabular" aria-live="off">
        {hover !== null && ready ? (
          <>
            <span>{hover.k}部頒布時</span>
            {tipRows.map((r) => (
              <span key={r.id}>
                {r.name}: {r.value}
              </span>
            ))}
          </>
        ) : (
          <span>
            {ready ? "グラフに触れると部数ごとの損益を確認できます" : ""}
          </span>
        )}
      </div>
    </>
  );
}
