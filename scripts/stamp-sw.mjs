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
import { PRIMARY_SHELL, SHELL_PATHS } from "../lib/offline.ts";
import {
  referencedStatic,
  selectPrecache,
  splitPrecache,
} from "./stamp-sw-select.mjs";

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

// 各ページの HTML を読み、**その HTML が実際に参照している実体**を控えられて
// いるかを検査する。「_next/static を全部拾ったか」ではなく「参照を覆えたか」で
// なければ、「画面は出るが操作が効かない」世代を緑のビルドで通してしまう。
const requiredStatic = new Set();
for (const page of ["", "tally/"]) {
  const html = await readFile(join(OUT, `${page}index.html`), "utf8");
  const refs = referencedStatic(html);
  if (refs.length === 0) {
    console.error(`[stamp-sw] /${page} が資産を1つも参照していません（解析失敗？）`);
    process.exit(1);
  }
  for (const r of refs) requiredStatic.add(r);
}
const uncovered = [...requiredStatic].filter((r) => !precache.includes(r));
if (uncovered.length > 0) {
  console.error(`[stamp-sw] 参照されているのに控えない資産: ${uncovered.join(", ")}`);
  process.exit(1);
}

// 必須（当日の主戦場）と任意（周辺ページ）に分ける。
const { required, optional } = splitPrecache(precache, [...requiredStatic]);

const swPath = join(OUT, "sw.js");
const src = await readFile(swPath, "utf8");

// 世代名 = 控えるものの内容ハッシュ。中身が1バイトでも変われば別世代になる。
// 控えないファイル（og.png・sitemap 等）は含めない。
// なお Next の buildId は毎ビルド変わり、それが HTML と index.txt の本文に
// 入るため、**同じソースからビルドし直すだけで世代名は変わる**。
// 「差し替えないファイルなら世代を跨げる」ことは期待できない。
// 結果として main への push は内容によらず全端末に控えの取り直しを起こす。
const digest = createHash("sha256");
// Service Worker 自身も世代名に含める。含めないと、sw.js だけを直した配信で
// 世代名が据え置かれ、install 中の版が **現に動いている版の控えを開く**。
// その版の put が1つでも失敗すると caches.delete(CACHE) が走り、
// 取り直しに失敗した端末が、それまで持っていた完全な控えごと失う
// （直しを配ったことが、当日ひらけなくなる原因になる）。
// 焼き込み前の中身を使う。焼き込み後は世代名を含むので循環する。
digest.update(src);
for (const p of precache) {
  digest.update(p);
  digest.update(await readFile(join(OUT, p === "" ? "index.html" : p.endsWith("/") ? `${p}index.html` : p)));
}
const build = digest.digest("hex").slice(0, 12);

// 置換は「定数の宣言そのもの」を狙う。単に "__BUILD__" を置換すると、
// 先に現れる説明コメントの方が差し替わり、定数はプレースホルダのまま残る
// ＝全ビルドが同じ世代名を共有して版ズレが復活する（実際に一度踏んだ）。
const BUILD_DECL = 'const BUILD = "__BUILD__";';
const SHELL_MAIN_DECL = 'const SHELL_MAIN = "__SHELL_MAIN__";';
const REQUIRED_DECL = '["__REQUIRED__"]';
const OPTIONAL_DECL = '["__OPTIONAL__"]';

if (
  !src.includes(BUILD_DECL) ||
  !src.includes(SHELL_MAIN_DECL) ||
  !src.includes(REQUIRED_DECL) ||
  !src.includes(OPTIONAL_DECL)
) {
  console.error("[stamp-sw] out/sw.js に置換対象がありません（二重実行？）");
  process.exit(1);
}
const stamped = src
  .replace(BUILD_DECL, `const BUILD = "${build}";`)
  .replace(SHELL_MAIN_DECL, `const SHELL_MAIN = ${JSON.stringify(PRIMARY_SHELL)};`)
  .replace(REQUIRED_DECL, JSON.stringify(required))
  .replace(OPTIONAL_DECL, JSON.stringify(optional));

// 焼き込み後にプレースホルダが残っていないことを確かめる（黙って素通りさせない）
if (
  /const BUILD = "__BUILD__"/.test(stamped) ||
  stamped.includes(SHELL_MAIN_DECL) ||
  stamped.includes(REQUIRED_DECL) ||
  stamped.includes(OPTIONAL_DECL)
) {
  console.error("[stamp-sw] 焼き込みに失敗しました（プレースホルダが残存）");
  process.exit(1);
}
await writeFile(swPath, stamped);

console.log(
  `[stamp-sw] 世代 ${build} / 必須 ${required.length} 件・任意 ${optional.length} 件`,
);
