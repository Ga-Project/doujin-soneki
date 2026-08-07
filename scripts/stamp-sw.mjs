// ビルド後に out/sw.js へ「世代」を焼き込む。Node 標準ライブラリだけで動く。
//
// なぜ要るか: Service Worker で控えを持つとき、HTML と、その HTML が読み込む
// JS/CSS の世代がズレると「画面は出るのに操作が効かない」という無音の故障になる。
// ビルドのたびに一意な世代名を与え、その世代の資産を一括で控えさせることで、
// 控えは常に自己完結した1セットになる。
//
// 実行: next build のあと（package.json の build スクリプト）。
//   node --experimental-strip-types scripts/stamp-sw.mjs

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SHELL_PATHS } from "../lib/offline.ts";

const OUT = fileURLToPath(new URL("../out/", import.meta.url));

/** out/ 配下の全ファイルを再帰列挙し、out からの相対パス（POSIX 区切り）で返す。 */
async function walk(dir) {
  const found = [];
  for (const name of await readdir(dir)) {
    const full = join(dir, name);
    if ((await stat(full)).isDirectory()) found.push(...(await walk(full)));
    else found.push(relative(OUT, full).split(sep).join("/"));
  }
  return found;
}

/**
 * 控える対象を選ぶ。
 *   - 各ルートの index.html（＝ページそのもの）と、その RSC ペイロード index.txt
 *     （クライアント遷移はこちらを読むため、無いと遷移だけ圏外で失敗する）
 *   - _next/static 配下すべて（ハッシュ付きで内容不変。HTML が参照する実体）
 *   - manifest とアイコン（ホーム画面から起動したときに要る）
 * sw.js 自身と sitemap は控えない（前者は自分、後者は当日不要）。
 */
function selectPrecache(files) {
  return files
    .filter(
      (f) =>
        f.endsWith("/index.html") ||
        f === "index.html" ||
        f.endsWith("/index.txt") ||
        f === "index.txt" ||
        f.startsWith("_next/static/") ||
        f === "manifest.webmanifest" ||
        (f.endsWith(".png") && !f.includes("/")),
    )
    .map((f) => (f === "index.html" ? "" : f.replace(/index\.html$/, "")))
    .sort();
}

const files = await walk(OUT);
const precache = selectPrecache(files);

// 必須ルートが欠けた状態で世代を作らない（控えたつもりで当日開けない、を防ぐ）
const missing = SHELL_PATHS.filter((p) => !precache.includes(p));
if (missing.length > 0) {
  console.error(
    `[stamp-sw] 必須ルートが out/ にありません: ${missing.map((m) => `/${m}`).join(", ")}`,
  );
  process.exit(1);
}

// 世代名 = 控える全ファイルの内容ハッシュ。中身が1バイトでも変われば別世代になる。
const digest = createHash("sha256");
for (const f of files.filter((f) => f !== "sw.js").sort()) {
  digest.update(f);
  digest.update(await readFile(join(OUT, f)));
}
const build = digest.digest("hex").slice(0, 12);

// 置換は「定数の宣言そのもの」を狙う。単に "__BUILD__" を置換すると、
// 先に現れる説明コメントの方が差し替わり、定数はプレースホルダのまま残る
// ＝全ビルドが同じ世代名を共有して版ズレが復活する（実際に一度踏んだ）。
const BUILD_DECL = 'const BUILD = "__BUILD__";';
const PRECACHE_DECL = '["__PRECACHE__"]';

const swPath = join(OUT, "sw.js");
const src = await readFile(swPath, "utf8");
if (!src.includes(BUILD_DECL) || !src.includes(PRECACHE_DECL)) {
  console.error("[stamp-sw] out/sw.js に置換対象がありません（二重実行？）");
  process.exit(1);
}
const stamped = src
  .replace(BUILD_DECL, `const BUILD = "${build}";`)
  .replace(PRECACHE_DECL, JSON.stringify(precache));

// 焼き込み後にプレースホルダが残っていないことを確かめる（黙って素通りさせない）
if (/const BUILD = "__BUILD__"/.test(stamped) || stamped.includes(PRECACHE_DECL)) {
  console.error("[stamp-sw] 焼き込みに失敗しました（プレースホルダが残存）");
  process.exit(1);
}
await writeFile(swPath, stamped);

console.log(`[stamp-sw] 世代 ${build} / 控える資産 ${precache.length} 件`);
