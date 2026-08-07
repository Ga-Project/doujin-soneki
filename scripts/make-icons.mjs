// アプリアイコン（public/icon-*.png・apple-touch-icon.png）を scripts/icon.html から生成する。
// 意匠の正は icon.html。PNG は生成物なので、意匠を直したらこれを流し直す。
//
// 実行: node scripts/make-icons.mjs
// 必要: macOS の Google Chrome（撮影）と sips（縮小）。どちらも標準環境にある。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const src = fileURLToPath(new URL("./icon.html", import.meta.url));
const pub = (name) => fileURLToPath(new URL(`../public/${name}`, import.meta.url));

/**
 * 512×512 で撮る。headless Chrome は既定で dark として描画するため
 * preferredColorScheme=1（light）を明示する（地紙の生成り色で撮るため）。
 */
async function shoot(query, out) {
  await run(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--blink-settings=preferredColorScheme=1",
    "--window-size=512,512",
    `--screenshot=${out}`,
    `file://${src}${query}`,
  ]);
  console.log(`[make-icons] ${out}`);
}

await shoot("", pub("icon-512.png"));
await shoot("?maskable=1", pub("icon-512-maskable.png"));
// タブの favicon 用。縮小に耐えるよう枠を落として判を一字にした別意匠
await shoot("?small=1", pub("icon-small.png"));

// any の意匠を縮小して 192（manifest）と 180（iOS のホーム画面）を作る
for (const [size, name, from] of [
  [192, "icon-192.png", "icon-512.png"],
  [180, "apple-touch-icon.png", "icon-512.png"],
  [32, "icon-32.png", "icon-small.png"],
]) {
  await run("sips", ["-Z", String(size), pub(from), "--out", pub(name)]);
  console.log(`[make-icons] ${pub(name)} (${size}px)`);
}
