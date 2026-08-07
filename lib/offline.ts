// doujin-soneki — 当日そなえ（アプリ本体の控え）の純ロジック。DOM/React 非依存。
//
// 会場（即売会）は通信が混むため、当日タリーを「開けない」事故が起こりうる。
// Service Worker でアプリシェルの控えを端末に持たせ、一度ひらいた端末なら
// 接続が無くても開けるようにする。ここには「どこに登録するか」と「いまどの状態か」
// の判定だけを置き、副作用は呼び出し側（app/tally/Sonae.tsx）が持つ。
//
// 語彙の規約（混線を防ぐため厳守）:
//   記帳データ（localStorage）… 「保存」と呼ぶ
//   アプリ本体（SW の控え）  … 「控え」「そなえ」と呼ぶ。「保存」とは呼ばない
//
// 単体テストは test/offline.test.mjs。

/**
 * 当日そなえの状態。
 *   ari   … この端末に控えがある＝接続が無くても開ける
 *   junbi … 登録済みだが、まだ控えが行き渡っていない
 *   fuka  … 控えが取れない環境（非対応ブラウザ・非セキュア文脈・登録失敗）
 */
export type SonaeState = "ari" | "junbi" | "fuka";

/**
 * basePath を正規化する。GitHub Pages のプロジェクトページ配信では
 * `/doujin-soneki` のようなサブパスが入り、ルート配信では空になる。
 * 前後の揺れ（末尾スラッシュ有無・先頭スラッシュ欠落・空白）を吸収し、
 * 「空文字」または「/で始まり/で終わらない文字列」に揃える。
 */
export function normalizeBasePath(raw: string | undefined | null): string {
  const s = (raw ?? "").trim();
  if (s === "" || s === "/") return "";
  const withLead = s.startsWith("/") ? s : `/${s}`;
  return withLead.endsWith("/") ? withLead.slice(0, -1) : withLead;
}

/**
 * Service Worker 本体の URL。`public/sw.js` は basePath 直下に配信される。
 * ページ相対で解決すると /tally/ から登録したときに /tally/sw.js を見に行って
 * しまうため、必ず basePath 基準の絶対パスで組み立てる。
 */
export function swPath(basePath: string | undefined | null): string {
  return `${normalizeBasePath(basePath)}/sw.js`;
}

/**
 * Service Worker の制御範囲。製品のルート（basePath 直下）に固定する。
 * これによりトップからでもタリーからでも同じ 1 つの登録を共有する。
 */
export function swScope(basePath: string | undefined | null): string {
  return `${normalizeBasePath(basePath)}/`;
}

/**
 * 端末に控えるページ（アプリシェル）。sw.js の SHELL と同一物（scope 相対）。
 * トップだけ開いた人が当日 /tally/ を開けないと、この増分の意味が無くなるので
 * 両方を必ず含める。trailingSlash:true のため各ルートは `<path>/index.html`。
 */
export const SHELL_PATHS: readonly string[] = [
  "", // トップ（シミュレータ）
  "tally/", // 頒布カウンター（当日の主戦場）
  "terms/",
  "privacy/",
];

/**
 * 登録の結果から状態を決める。
 *
 * 「ari＝接続が無くても開ける」と言い切れるのは、sw がこのページを実際に
 * 制御している時だけ。登録しただけの段階を ari と呼ばない（まだ控えの無い
 * 端末に「電波が無くても開けます」と表示して当日に裏切らないため）。
 */
export function resolveSonaeState(input: {
  supported: boolean;
  failed: boolean;
  controlled: boolean;
}): SonaeState {
  if (!input.supported || input.failed) return "fuka";
  return input.controlled ? "ari" : "junbi";
}

/**
 * 状態行に添える札の表示。取れていない状態でも札を消さない
 * （控えが無いことを黙るのは、当日に事故る側へ倒れるため）。
 *
 * 朱は使わない（「赤字・警告・分岐・印判」の4用途外＝朱の予算制）。
 * 未完了・不可はいずれも枠罫の破線（.fuda-junbi）で墨のまま表す。
 */
export function sonaeFuda(state: SonaeState): {
  text: string;
  sr: string;
  className: string;
} {
  switch (state) {
    case "ari":
      return {
        text: "そなえ済",
        sr: "（この端末に控えあり。電波がなくても開けます）",
        className: "fuda",
      };
    case "junbi":
      return {
        text: "そなえ中",
        sr: "（控えを取っています。しばらく開いたままにしてください）",
        className: "fuda fuda-junbi",
      };
    case "fuka":
      return {
        text: "そなえ不可",
        sr: "（この環境では控えを取れません。会場では電波が必要です）",
        className: "fuda fuda-junbi",
      };
  }
}
