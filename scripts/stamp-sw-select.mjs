// 控える対象の選別だけを切り出したモジュール（副作用なし・テストから読む）。
// 本体は scripts/stamp-sw.mjs。

/**
 * アプリが実際に使う画像だけを控える。og.png は共有カード専用でアプリは描画せず、
 * icon-small.png は icon-32.png を作るための中間物。all-or-nothing なので、
 * 使わないものを混ぜるとその取得成功まで世代成立の条件になってしまう。
 */
export const APP_IMAGES = new Set([
  "icon-32.png",
  "icon-192.png",
  "icon-512.png",
  "icon-512-maskable.png",
  "apple-touch-icon.png",
]);

/**
 * 控える対象を選ぶ。
 *   - 各ルートの index.html（＝ページそのもの）と、その RSC ペイロード index.txt
 *     （クライアント遷移はこちらを読むため、無いと遷移だけ圏外で失敗する）
 *   - _next/static 配下すべて（ハッシュ付きで内容不変。HTML が参照する実体）
 *   - manifest とアプリのアイコン（ホーム画面から起動したときに要る）
 * sw.js 自身・sitemap・404 は控えない（404 の実体は 404.html で、当日開かない）。
 */
export function selectPrecache(files) {
  return files
    .filter(
      (f) =>
        ((f.endsWith("/index.html") ||
          f === "index.html" ||
          f.endsWith("/index.txt") ||
          f === "index.txt") &&
          !f.startsWith("404/")) ||
        f.startsWith("_next/static/") ||
        f === "manifest.webmanifest" ||
        APP_IMAGES.has(f),
    )
    .map((f) => (f === "index.html" ? "" : f.replace(/index\.html$/, "")))
    .sort();
}

/**
 * HTML が参照している `_next/static` の実体を抜き出す（scope 相対に直す）。
 * basePath 付きでも拾えるよう、`/_next/static/...` の位置から後ろを見る。
 */
export function referencedStatic(html) {
  const found = new Set();
  for (const m of html.matchAll(/\/_next\/static\/[A-Za-z0-9._\/-]+/g)) {
    found.add(m[0].replace(/^.*?\/_next\/static\//, "_next/static/"));
  }
  return [...found].sort();
}

/**
 * 控えを「必須」と「任意」に分ける。
 *
 * all-or-nothing は版ズレを防ぐ唯一の手段だが、対象が増えるほど
 * 「1件の取りこぼしで世代が作れない」確率が上がる。そこで当日の主戦場
 * （記帳画面とトップ、およびそれらが実際に読む実体）だけを必須にし、
 * 規約などの周辺ページは取れたら控える任意扱いにする。
 */
export function splitPrecache(precache, requiredStatic) {
  const requiredPages = ["", "tally/", "index.txt", "tally/index.txt"];
  const required = precache.filter(
    (p) =>
      requiredPages.includes(p) ||
      requiredStatic.includes(p) ||
      p === "manifest.webmanifest" ||
      APP_IMAGES.has(p),
  );
  const optional = precache.filter((p) => !required.includes(p));
  return { required, optional };
}
