"use client";

// 損益線図（「朱墨の帳場」の実用線図・インライン SVG・ライブラリ不使用）。
// 思想: 統計年鑑の線図。飾らない。ゼロ線＝水平線が最強の線で、その上下＝黒字/赤字が
// 一目で分かることが全て。赤字ゾーンは朱の斜線ハッチ（帳簿の訂正斜線の引用）。
// 詳細データの完全な代替は「表で見る」（25部刻みの損益表）が兼ねる。
//
// 読み取り: 25部刻みスナップの読取罫＋読取札（右上固定・カーソル追従させない）。
// タップでピン留め・再タップで解除。キーボードは ←→ で25部刻み、Home/End で 0/完売。

import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import {
  formatAxis,
  formatAxisTick,
  formatChobo,
  niceStep,
  tickValues,
} from "@/lib/soneki";

export interface ChartSeries {
  id: string;
  name: string;
  /** 系列色（CSS 変数参照）。朱は系列に使わない（朱の予算制）。 */
  colorVar: string;
  /** 色見本 span 用のクラス（.iro-aozumi 等） */
  colorClass: string;
  /** stroke-dasharray（会場=実線は undefined）。色×線種の二重符号。 */
  dash?: string;
  /** 1 冊あたり手取り（円）。損益(k) = k × net − baseCost。 */
  net: number;
}

/** 凡例行（非表示・入力待ちの系列もトグル操作対象として並べる）。 */
export interface LegendRow {
  id: string;
  name: string;
  colorVar: string;
  dash?: string;
  visible: boolean;
  isMain: boolean;
  /** 計算対象（表示ON・入力有効・色枠内）か。主ラジオの活性に使う。 */
  active: boolean;
}

interface Props {
  ready: boolean;
  copies: number;
  baseCost: number;
  series: ChartSeries[];
  mainId: string | null;
  /** 主チャネルの損益分岐（整数部・札用）と厳密交点（マーカー位置用）。 */
  breakEvenMain: number | null;
  breakEvenExactMain: number | null;
  legend: LegendRow[];
  /**
   * 検算中（直前有効値のスナップショット表示）。凡例の操作を留め置き、
   * 凍結された線図と操作結果が食い違う過渡状態を作らない。
   */
  frozen?: boolean;
  onSelectMain: (id: string) => void;
  onToggleVisible: (id: string, visible: boolean) => void;
  ariaLabel: string;
  /** 空状態オーバーレイ等。 */
  children?: ReactNode;
}

const W = 400;
const H = 300;
const PAD_T = 16;
const PAD_R = 24;
const PAD_B = 40;
const PAD_L = 64;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

// SVG 内テキストの文字サイズ（viewBox 単位）。375px 実機では約 0.86 倍で描画される
// ため、ブリーフ§4 の 13px 級を満たすよう 14〜15 を基準にする（11〜12 は 9〜10px に
// 潰れて不可）。Y 目盛のみ左余白 64px に「-80,000」級を収めるため 14。
const JI_MEMORI = 14; // Y 目盛数字
const JI_SVG = 15; // 単位注記・ゾーン名・X 目盛・「部」
const JI_FUDA = 14; // 分岐・完売の札

/** 読取のスナップ刻み（部）。 */
const YOMI_KIZAMI = 25;

export function ProfitChart({
  ready,
  copies,
  baseCost,
  series,
  mainId,
  breakEvenMain,
  breakEvenExactMain,
  legend,
  frozen = false,
  onSelectMain,
  onToggleVisible,
  ariaLabel,
  children,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverK, setHoverK] = useState<number | null>(null);
  const [pinK, setPinK] = useState<number | null>(null);

  const xMax = Math.max(1, copies);
  const kizami = xMax < YOMI_KIZAMI ? 1 : YOMI_KIZAMI;

  // Y ドメイン: 全系列の端点と 0 を含め、上下 8% 余白
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
  if (yMax - yMin < 1) yMax = yMin + 1;
  const pad = (yMax - yMin) * 0.08;
  const yTop = yMax + pad;
  const yBot = yMin - pad;

  const x = (k: number): number => PAD_L + (k / xMax) * PLOT_W;
  const y = (v: number): number =>
    PAD_T + ((yTop - v) / (yTop - yBot)) * PLOT_H;
  const y0 = y(0);

  // 軸: Y は nice-step、単位は最大絶対値で円/万円を切替（formatAxis）
  const axis = formatAxis(Math.max(Math.abs(yTop), Math.abs(yBot)));
  const yTicks = tickValues(yBot, yTop, 5);
  // X 主目盛: 標準は 50 部ごと、部数が多いときはキリ値に自動拡大。
  // 50 部未満の小部数では「0」しか出なくなるため、キリ値の細目盛に切り替える
  const xStep =
    xMax < 50
      ? Math.max(1, niceStep(xMax, 5))
      : Math.max(50, ...tickValues(0, xMax, 8).slice(1, 2));
  const xTicks: number[] = [];
  for (let k = 0; k <= xMax; k += xStep) xTicks.push(k);

  const main = series.find((s) => s.id === mainId) ?? null;
  const yomiK = pinK ?? hoverK;

  // ポインタ位置 → 25部刻みスナップ
  const snapFromEvent = (e: ReactPointerEvent<Element>): number | null => {
    const svg = svgRef.current;
    if (svg === null) return null;
    const rect = svg.getBoundingClientRect();
    const relX = ((e.clientX - rect.left) / rect.width) * W;
    const raw = ((relX - PAD_L) / PLOT_W) * xMax;
    const snapped = Math.round(raw / kizami) * kizami;
    return Math.min(xMax, Math.max(0, snapped));
  };
  const handleMove = (e: ReactPointerEvent<Element>): void => {
    if (!ready) return;
    const k = snapFromEvent(e);
    if (k !== null) setHoverK(k);
  };
  const handleDown = (e: ReactPointerEvent<Element>): void => {
    if (!ready) return;
    const k = snapFromEvent(e);
    if (k === null) return;
    setPinK((prev) => (prev === k ? null : k)); // タップでピン留め・再タップで解除
  };
  const handleLeave = (): void => setHoverK(null);
  const handleKey = (e: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!ready) return;
    const cur = pinK ?? hoverK ?? 0;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = Math.min(xMax, cur + kizami);
    if (e.key === "ArrowLeft") next = Math.max(0, cur - kizami);
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = xMax;
    if (next !== null) {
      e.preventDefault();
      setPinK(next);
    }
    if (e.key === "Escape") setPinK(null);
  };

  const yomiRows =
    yomiK !== null && ready
      ? series.map((s) => {
          const v = yomiK * s.net - baseCost;
          return { id: s.id, name: s.name, v, chobo: formatChobo(v) };
        })
      : [];
  const yomiAria =
    yomiK !== null && yomiRows.length > 0
      ? `${yomiK}部。` +
        yomiRows.map((r) => `${r.name} ${r.chobo.aria}`).join("、")
      : "";

  // マーカー（主チャネル）
  const bex =
    ready && breakEvenExactMain !== null && breakEvenExactMain <= xMax
      ? x(breakEvenExactMain)
      : null;
  const mainEndV = main !== null ? xMax * main.net - baseCost : 0;

  return (
    <>
      {/* 凡例（盤面上部1行・第三丁のトグルと双方向同期） */}
      <div className="hanrei">
        {legend.map((row) => (
          <span key={row.id} className="hanrei-kumi">
            <svg
              className="hanrei-sen"
              viewBox="0 0 24 12"
              aria-hidden="true"
              focusable="false"
            >
              <line
                x1="0"
                y1="6"
                x2="24"
                y2="6"
                stroke={row.colorVar}
                strokeWidth="2.5"
                strokeDasharray={row.dash}
              />
            </svg>
            <span>{row.name}</span>
            <label className="shu-radio">
              <input
                type="radio"
                name="hanrei-main"
                checked={row.isMain}
                disabled={frozen || !row.active}
                onChange={() => onSelectMain(row.id)}
                aria-label={`${row.name}を主チャネルにする`}
              />
              <span aria-hidden="true">主</span>
            </label>
            <label className="sumi-check">
              <input
                type="checkbox"
                checked={row.visible}
                disabled={frozen}
                onChange={(e) => onToggleVisible(row.id, e.target.checked)}
                aria-label={`${row.name}を線図に表示`}
              />
              表示
            </label>
          </span>
        ))}
      </div>

      <div
        className="senzu-waku"
        style={{ position: "relative" }}
        tabIndex={0}
        role="img"
        aria-label={`${ariaLabel}${yomiAria === "" ? "" : ` 読取: ${yomiAria}`}`}
        onKeyDown={handleKey}
      >
        <svg
          ref={svgRef}
          className="senzu-svg"
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="xMidYMid meet"
          aria-hidden="true"
          focusable="false"
        >
          <defs>
            {/* 朱の斜線ハッチ（帳簿の訂正斜線） */}
            <pattern
              id="hatch-akaji"
              width="6"
              height="6"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <line
                x1="0"
                y1="0"
                x2="0"
                y2="6"
                stroke="var(--hatch)"
                strokeWidth="1"
              />
            </pattern>
          </defs>

          {/* 黒字ゾーン（淡）・赤字ゾーン（朱6%＋ハッチ）: 位置×模様の二重符号 */}
          {yTop > 0 && (
            <rect
              x={PAD_L}
              y={PAD_T}
              width={PLOT_W}
              height={Math.max(0, y0 - PAD_T)}
              fill="var(--zone-kuroji)"
            />
          )}
          {yBot < 0 && (
            <>
              <rect
                x={PAD_L}
                y={y0}
                width={PLOT_W}
                height={Math.max(0, H - PAD_B - y0)}
                fill="var(--zone-akaji)"
              />
              <rect
                x={PAD_L}
                y={y0}
                width={PLOT_W}
                height={Math.max(0, H - PAD_B - y0)}
                fill="url(#hatch-akaji)"
              />
            </>
          )}
          {/* ゾーン名の直置きラベル */}
          {y0 - PAD_T > 24 && (
            <text
              x={PAD_L + 8}
              y={PAD_T + 18}
              fontSize={JI_SVG}
              fill="var(--sumi-2)"
            >
              黒字
            </text>
          )}
          {H - PAD_B - y0 > 24 && (
            <text
              x={PAD_L + 8}
              y={H - PAD_B - 8}
              fontSize={JI_SVG}
              fill="var(--sumi-2)"
            >
              赤字
            </text>
          )}

          {/* 単位注記（統計年鑑様式） */}
          <text x={8} y={13} fontSize={JI_SVG} fill="var(--sumi-2)">
            （単位：{axis.unit}）
          </text>

          {/* Y 目盛（糸罫）＋数字 */}
          {yTicks.map((v) => (
            <g key={`y${v}`}>
              <line
                x1={PAD_L}
                x2={W - PAD_R}
                y1={y(v)}
                y2={y(v)}
                stroke="var(--keisen-ito)"
                strokeWidth="1"
                shapeRendering="crispEdges"
              />
              <text
                x={PAD_L - 6}
                y={y(v) + 5}
                fontSize={JI_MEMORI}
                fill="var(--sumi-2)"
                textAnchor="end"
                className="suji"
              >
                {formatAxisTick(v, axis.divisor)}
              </text>
            </g>
          ))}

          {/* X 目盛 */}
          {xTicks.map((k) => (
            <g key={`x${k}`}>
              <line
                x1={x(k)}
                x2={x(k)}
                y1={PAD_T}
                y2={H - PAD_B}
                stroke="var(--keisen-ito)"
                strokeWidth="1"
                shapeRendering="crispEdges"
              />
              <text
                x={x(k)}
                y={H - PAD_B + 17}
                fontSize={JI_SVG}
                fill="var(--sumi-2)"
                textAnchor="middle"
                className="suji"
              >
                {k}
              </text>
            </g>
          ))}
          <text
            x={W - PAD_R}
            y={H - PAD_B + 34}
            fontSize={JI_SVG}
            fill="var(--sumi-2)"
            textAnchor="end"
          >
            部
          </text>

          {/* ゼロ線 — 盤面で最も強い線 */}
          <line
            x1={PAD_L}
            x2={W - PAD_R}
            y1={y0}
            y2={y0}
            stroke="var(--sumi)"
            strokeWidth="2"
            shapeRendering="crispEdges"
          />

          {/* 系列線（主 3px・他 2px、色×線種の二重符号） */}
          {ready &&
            [...series]
              .sort(
                (a, b) => (a.id === mainId ? 1 : 0) - (b.id === mainId ? 1 : 0),
              )
              .map((s) => (
                <path
                  key={s.id}
                  className="senzu-line"
                  d={`M ${x(0)} ${y(-baseCost)} L ${x(xMax)} ${y(xMax * s.net - baseCost)}`}
                  stroke={s.colorVar}
                  strokeWidth={s.id === mainId ? 3 : 2}
                  strokeDasharray={s.dash}
                  strokeLinecap="butt"
                />
              ))}

          {/* 損益分岐点: 朱の合印（白抜き丸）＋X軸への朱破線＋札 */}
          {bex !== null && (
            <g>
              <line
                x1={bex}
                x2={bex}
                y1={y0}
                y2={H - PAD_B}
                stroke="var(--shu-hade)"
                strokeWidth="1"
                strokeDasharray="4 3"
              />
              <circle
                cx={bex}
                cy={y0}
                r="4.5"
                fill="var(--kami-2)"
                stroke="var(--shu-hade)"
                strokeWidth="2"
              />
              {breakEvenMain !== null && (
                <g>
                  <rect
                    x={Math.min(W - PAD_R - 104, Math.max(PAD_L, bex - 52))}
                    y={H - PAD_B - 28}
                    width="104"
                    height="22"
                    fill="var(--kami-2)"
                    stroke="var(--shu)"
                    strokeWidth="1"
                  />
                  <text
                    x={
                      Math.min(W - PAD_R - 104, Math.max(PAD_L, bex - 52)) + 52
                    }
                    y={H - PAD_B - 12}
                    fontSize={JI_FUDA}
                    fill="var(--shu)"
                    textAnchor="middle"
                    className="suji"
                  >
                    分岐 {breakEvenMain}部
                  </text>
                </g>
              )}
            </g>
          )}

          {/* 完売点: 墨の菱形＋札 */}
          {ready && main !== null && (
            <g>
              <rect
                x={x(xMax) - 3}
                y={y(mainEndV) - 3}
                width="6"
                height="6"
                fill="var(--sumi)"
                transform={`rotate(45 ${x(xMax)} ${y(mainEndV)})`}
              />
              <rect
                x={W - PAD_R - 100}
                y={Math.max(PAD_T + 2, y(mainEndV) - 32)}
                width="98"
                height="22"
                fill="var(--kami-2)"
                stroke="var(--sumi)"
                strokeWidth="1"
              />
              <text
                x={W - PAD_R - 51}
                y={Math.max(PAD_T + 2, y(mainEndV) - 32) + 16}
                fontSize={JI_FUDA}
                fill="var(--sumi)"
                textAnchor="middle"
                className="suji"
              >
                完売 {xMax}部
              </text>
            </g>
          )}

          {/* 読取罫＋交点（25部刻みスナップ・ピン留め対応） */}
          {yomiK !== null && ready && (
            <g>
              <line
                x1={x(yomiK)}
                x2={x(yomiK)}
                y1={PAD_T}
                y2={H - PAD_B}
                stroke="var(--keisen-waku)"
                strokeWidth="1"
              />
              {series.map((s) => (
                <circle
                  key={s.id}
                  cx={x(yomiK)}
                  cy={y(yomiK * s.net - baseCost)}
                  r="3.5"
                  fill={s.colorVar}
                />
              ))}
              {pinK !== null && (
                <circle
                  cx={x(yomiK)}
                  cy={H - PAD_B}
                  r="3"
                  fill="var(--keisen-waku)"
                />
              )}
            </g>
          )}

          {/* ポインタ捕捉レイヤ（44px 相当のスナップ幅・盤面全域） */}
          {ready && (
            <rect
              x={PAD_L}
              y={PAD_T}
              width={PLOT_W}
              height={PLOT_H}
              fill="transparent"
              onPointerMove={handleMove}
              onPointerDown={handleDown}
              onPointerLeave={handleLeave}
            />
          )}
        </svg>

        {/* 読取札（desktop: 盤面右上固定。カーソル追従させない） */}
        {yomiK !== null && ready && (
          <div className="yomitori-fuda suji" aria-hidden="true">
            <div className="yomi-kashira">
              {yomiK}部 の損益{pinK !== null ? "（留）" : ""}
            </div>
            {yomiRows.map((r) => (
              <div key={r.id} className="yomi-gyo">
                <span className="yomi-na">{r.name}</span>
                <span className={r.v < 0 ? "akaji-ji" : ""}>
                  {r.chobo.text}
                </span>
              </div>
            ))}
          </div>
        )}

        {children}
      </div>

      {/* 読取帯（mobile: 盤面直下・指の遮蔽回避） */}
      <div className="yomitori-obi suji">
        {yomiK !== null && ready ? (
          <>
            <span>
              {yomiK}部{pinK !== null ? "（留）" : ""}
            </span>
            {yomiRows.map((r) => (
              <span key={r.id}>
                {r.name} {r.chobo.text}
              </span>
            ))}
          </>
        ) : (
          <span className="sai">
            {ready
              ? "盤面に触れると25部刻みで読み取れます（タップで留め置き）"
              : ""}
          </span>
        )}
      </div>

      {/* 読み上げ（読取値の変化を通知） */}
      <span className="sr-only" aria-live="polite">
        {yomiAria}
      </span>
    </>
  );
}
