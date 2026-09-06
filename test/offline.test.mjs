// doujin-soneki — オフライン（当日そなえ）ロジックの単体テスト。
// 実行: pnpm test（Node が .ts を型ストリップして読み込む）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import {
  selectPrecache,
  splitPrecache,
  referencedStatic,
} from "../scripts/stamp-sw-select.mjs";
import {
  normalizeBasePath,
  swPath,
  swScope,
  resolveSonaeState,
  shouldRegisterSonae,
  readSonaeWorkers,
  isSonaeGenerationCache,
  hasSonaeGeneration,
  watchSonaeInstall,
  PRIMARY_SHELL,
  sonaeFuda,
  tallyShellUrl,
  SHELL_PATHS,
} from "../lib/offline.ts";

const SW_SRC = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");
const KILL_SRC = readFileSync(
  new URL("../scripts/sw-kill.js", import.meta.url),
  "utf8",
);

/**
 * いま配っているのが「取り消し版（kill switch）」か。
 *
 * 控えが壊れたときは `public/sw.js` を `scripts/sw-kill.js` の中身で上書きして
 * push する。そのとき控えの仕組みを見る検査は当然通らない。回復の手順を踏むと
 * CI が赤くなる作りにしてしまうと、**まさに回復が要る場面で手が止まる**ので、
 * 取り消し版を配っている間は控えの検査を飛ばし、代わりに「片方だけになって
 * いないか（ページ側の登録も止めたか）」を見る。
 */
const SW_IS_KILL = !SW_SRC.includes("REQUIRED_TIMEOUT_MS");
const skipOnKill = SW_IS_KILL
  ? { skip: "取り消し版を配っている間は控えの検査を飛ばす" }
  : {};

/**
 * 「返らない相手」を試す検査に付ける。期限が消えた版では待ち続けることに
 * なるので、上限を置いて**落とす**（黙って止まると CI ごと固まり、
 * 期限を失ったことが誰にも見えない）。
 */
const stalls = { ...skipOnKill, timeout: 5000 };

/**
 * 注釈を落としてコードだけを見る（keepStrings=false で文字列の中身も落とす）。
 *
 * 正規表現で `//.*` を消す簡便版は、文字列の中の `//`（`https://…` など）で
 * 行の残りごと消してしまう。それをやると、構文の検査が「消えた行」を見て
 * 素通しし、守っているつもりで守れていない状態になる。
 * 走査しきれなかった（＝閉じていない文字列で終わった）場合は投げる。
 */
/** テンプレートの本文を空白に潰し、`${...}` の中身だけ残す。 */
function keepInterpolations(body) {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const at = body.indexOf("${", i);
    if (at === -1) return `${out}${" ".repeat(body.length - i)}`;
    out += " ".repeat(at - i);
    const close = body.indexOf("}", at);
    if (close === -1) return `${out}${" ".repeat(body.length - at)}`;
    out += body.slice(at, close + 1);
    i = close + 1;
  }
  return out;
}

function codeOnly(src, keepStrings = true) {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) throw new Error("閉じていないブロック注釈");
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const from = i;
      i += 1;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") i += 1;
        i += 1;
      }
      if (i >= src.length) throw new Error("閉じていない文字列");
      i += 1;
      const raw = src.slice(from, i);
      if (keepStrings) out += raw;
      // 文字列の中身は「書いてあるだけで実行されない」。説明文や HTML の
      // 中の語で誤検出しないよう落とす。ただしテンプレートの `${...}` は
      // **実行されるコード**なので残す（落とすと埋め込みに書かれた新しい
      // 構文が検査をすり抜ける）。
      else if (c === "`") out += `\`${keepInterpolations(raw.slice(1, -1))}\``;
      else out += `${c}${c}`;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}


test("normalizeBasePath: ルート配信は空文字に畳む", () => {
  assert.equal(normalizeBasePath(""), "");
  assert.equal(normalizeBasePath("/"), "");
  assert.equal(normalizeBasePath(undefined), "");
  assert.equal(normalizeBasePath(null), "");
  assert.equal(normalizeBasePath("   "), "");
});

test("normalizeBasePath: サブパスは /で始まり/で終わらない形に揃える", () => {
  assert.equal(normalizeBasePath("/doujin-soneki"), "/doujin-soneki");
  assert.equal(normalizeBasePath("/doujin-soneki/"), "/doujin-soneki");
  assert.equal(normalizeBasePath("doujin-soneki"), "/doujin-soneki");
  assert.equal(normalizeBasePath("doujin-soneki/"), "/doujin-soneki");
  assert.equal(normalizeBasePath(" /doujin-soneki/ "), "/doujin-soneki");
});

test("swPath: basePath 直下の sw.js を絶対パスで指す", () => {
  // ルート配信（ローカル開発）
  assert.equal(swPath(""), "/sw.js");
  // Pages のプロジェクトページ配信。/tally/ から登録しても /tally/sw.js にならない
  assert.equal(swPath("/doujin-soneki"), "/doujin-soneki/sw.js");
  assert.equal(swPath("/doujin-soneki/"), "/doujin-soneki/sw.js");
});

test("swScope: 製品ルートに固定し、トップとタリーで登録を共有する", () => {
  assert.equal(swScope(""), "/");
  assert.equal(swScope("/doujin-soneki"), "/doujin-soneki/");
  assert.equal(swScope("/doujin-soneki/"), "/doujin-soneki/");
});

test("SHELL_PATHS: 当日ひらく2画面（トップ・タリー）を必ず含む", () => {
  assert.ok(SHELL_PATHS.includes(""));
  assert.ok(SHELL_PATHS.includes("tally/"));
  // scope 相対で解決するため、先頭スラッシュを付けない
  for (const p of SHELL_PATHS) {
    assert.ok(!p.startsWith("/"), `${p} は scope 相対であるべき`);
  }
});

test("resolveSonaeState: 非対応・登録失敗はどちらも fuka", () => {
  assert.equal(
    resolveSonaeState({
      supported: false,
      failed: false,
      controlled: true,
      cached: true,
    }),
    "fuka",
  );
  // 対応環境でも登録に失敗したら控えは無い
  assert.equal(
    resolveSonaeState({
      supported: true,
      failed: true,
      controlled: true,
      cached: true,
    }),
    "fuka",
  );
});

test("resolveSonaeState: 制御＋控えの実在が揃って初めて ari と言い切る", () => {
  const base = { supported: true, failed: false };
  // 登録しただけ＝まだ控えが無い端末。「電波が無くても開けます」と表示しない
  assert.equal(
    resolveSonaeState({ ...base, controlled: false, cached: false }),
    "junbi",
  );
  // 制御は付いたが控えが無い（precache が丸ごと失敗した端末）＝まだ ari ではない
  assert.equal(
    resolveSonaeState({ ...base, controlled: true, cached: false }),
    "junbi",
  );
  // 控えはあるが制御が付いていない（初回訪問の途中）＝まだ ari ではない
  assert.equal(
    resolveSonaeState({ ...base, controlled: false, cached: true }),
    "junbi",
  );
  assert.equal(
    resolveSonaeState({ ...base, controlled: true, cached: true }),
    "ari",
  );
});

test("tallyShellUrl: 控えの実在を確かめる先は当日ひらく /tally/", () => {
  assert.equal(
    tallyShellUrl("", "https://example.test"),
    "https://example.test/tally/",
  );
  assert.equal(
    tallyShellUrl("/doujin-soneki", "https://ga-project.github.io"),
    "https://ga-project.github.io/doujin-soneki/tally/",
  );
});

test("sw.js: 世代の焼き込み口（ビルド印・控える一覧）が残っている", () => {
  // stamp-sw.mjs はこの2つを置換する。名前を変えると世代付けが黙って失われ、
  // 全ビルドが同じ控えを共有して版ズレを起こすので、置換対象を固定する。
  assert.ok(SW_SRC.includes("__BUILD__"), "ビルド印の置換対象が無い");
  assert.ok(SW_SRC.includes('["__REQUIRED__"]'), "必須一覧の置換対象が無い");
  assert.ok(SW_SRC.includes('["__OPTIONAL__"]'), "任意一覧の置換対象が無い");
});

test("sw.js: 控える一覧を手で持たない（lib との二重定義を作らない）", () => {
  // 控える対象はビルド成果物から stamp-sw.mjs が生成する。sw.js 側に
  // 手書きの一覧が復活すると、lib/offline.ts の SHELL_PATHS と静かに乖離する。
  for (const p of SHELL_PATHS.filter((p) => p !== "")) {
    assert.ok(
      !SW_SRC.includes(`"${p}"`),
      `sw.js に手書きの控え一覧（"${p}"）がある`,
    );
  }
});

test("sw.js: 逃げ道（?nosw）と別オリジン不介入を持っている", skipOnKill, () => {
  assert.ok(SW_SRC.includes('searchParams.has("nosw")'), "逃げ道が無い");
  assert.ok(SW_SRC.includes("url.origin !== scope.origin"), "別オリジンに介入する");
});

test("sonaeFuda: どの状態でも札を消さない（控えが無いことを黙らない）", () => {
  for (const s of ["ari", "junbi", "fuka"]) {
    const f = sonaeFuda(s);
    assert.ok(f.text.length > 0, `${s} の札に文言が要る`);
    assert.ok(f.sr.length > 0, `${s} の札に読み上げ補足が要る`);
    assert.ok(f.className.startsWith("fuda"), `${s} は札様式で出す`);
  }
});

test("sonaeFuda: 朱（akaji/shu）を使わない — 朱の予算制の4用途外", () => {
  for (const s of ["ari", "junbi", "fuka"]) {
    assert.ok(
      !sonaeFuda(s).className.includes("akaji"),
      `${s} に朱の札様式を使わない`,
    );
  }
});

test("sonaeFuda: 控えの側に「保存」の語を使わない（記帳データと混線させない）", () => {
  for (const s of ["ari", "junbi", "fuka"]) {
    const f = sonaeFuda(s);
    assert.ok(!`${f.text}${f.sr}`.includes("保存"), `${s} の文言に「保存」`);
  }
});

test("selectPrecache: ページ・RSC・資産・アプリのアイコンを拾う", () => {
  const got = selectPrecache([
    "index.html",
    "index.txt",
    "tally/index.html",
    "tally/index.txt",
    "_next/static/chunks/main-abc.js",
    "_next/static/css/x.css",
    "manifest.webmanifest",
    "icon-192.png",
  ]);
  assert.ok(got.includes(""), "トップ");
  assert.ok(got.includes("tally/"), "記帳画面");
  assert.ok(got.includes("tally/index.txt"), "遷移用の RSC");
  assert.ok(got.includes("_next/static/chunks/main-abc.js"), "JS 実体");
  assert.ok(got.includes("manifest.webmanifest"));
  assert.ok(got.includes("icon-192.png"));
});

test("selectPrecache: 当日使わないものは拾わない", () => {
  const got = selectPrecache([
    "sw.js",
    "sitemap.xml",
    "404.html",
    "404/index.html",
    "og.png",
    "icon-small.png",
  ]);
  assert.deepEqual(got, [], `拾ってはいけないものを拾った: ${got.join(", ")}`);
});


// --- 必須／任意の振り分け ------------------------------------------------
// ここを誤ると「HTML だけ必須・チャンクは任意」という世代が成立し、
// install は成功するのに圏外で操作が効かない（＝札は「そなえ済」のまま）。
// この増分が最も恐れている故障が、緑のビルドで通ってしまう。

test("splitPrecache: 当日の主戦場と、それが読む実体だけを必須にする", () => {
  const precache = [
    "",
    "tally/",
    "terms/",
    "index.txt",
    "tally/index.txt",
    "_next/static/chunks/a.js",
    "_next/static/chunks/b.js",
    "manifest.webmanifest",
    "icon-192.png",
  ];
  const { required, optional } = splitPrecache(precache, [
    "_next/static/chunks/a.js",
  ]);
  for (const p of ["", "tally/", "index.txt", "tally/index.txt", "_next/static/chunks/a.js"]) {
    assert.ok(required.includes(p), `必須に入るべき: ${p}`);
  }
  for (const p of ["terms/", "_next/static/chunks/b.js", "manifest.webmanifest", "icon-192.png"]) {
    assert.ok(optional.includes(p), `任意に落ちるべき: ${p}`);
  }
  assert.equal(required.length + optional.length, precache.length);
});

test("splitPrecache: ページが参照する実体は必ず必須に入る（版ズレ不変条件）", () => {
  const html = '<link href="/doujin-soneki/_next/static/css/x.css"><script src="/doujin-soneki/_next/static/chunks/y.js">';
  const refs = referencedStatic(html);
  assert.deepEqual(refs, [
    "_next/static/chunks/y.js",
    "_next/static/css/x.css",
  ]);
  const { required } = splitPrecache(["", "tally/", ...refs], refs);
  for (const r of refs) assert.ok(required.includes(r), `参照実体が必須から漏れた: ${r}`);
});

test("referencedStatic: basePath 無しの配信でも scope 相対に揃う", () => {
  assert.deepEqual(referencedStatic('<script src="/_next/static/chunks/z.js">'), [
    "_next/static/chunks/z.js",
  ]);
});

// --- 逃げ道（?nosw） -----------------------------------------------------
// 「控えを配ったが壊れていた」ときに利用者が自力で戻れる唯一の即時手段。
// sw 側の unregister だけでは、同じページの JS が即座に登録し直してしまう。

test("shouldRegisterSonae: ?nosw のときだけ登録しない（その読み込み限り）", () => {
  assert.equal(shouldRegisterSonae({ enabled: true, search: "" }), true);
  assert.equal(shouldRegisterSonae({ enabled: true, search: "?nosw" }), false);
  assert.equal(
    shouldRegisterSonae({ enabled: true, search: "?utm_source=x" }),
    true,
  );
  // 端末に離脱を焼き付けない。焼き付けると、以後どの訪問でも札が
  // 「そなえ不可（要電波）」になり、原因が自分の操作だと画面から分からない。
  assert.equal(shouldRegisterSonae({ enabled: true, search: "" }), true);
});

test("shouldRegisterSonae: 止め方が効いている配信では登録しない", () => {
  // 取り消し版は制御下のページを開き直させる。開き直した先がまた登録すると
  // 取り消し版が入り直し、解除と再読み込みを繰り返して素のサイトへ戻れない。
  assert.equal(shouldRegisterSonae({ enabled: false, search: "" }), false);
  assert.equal(
    shouldRegisterSonae({ enabled: false, search: "?utm_source=x" }),
    false,
  );
});

test("isSonaeGenerationCache: 別置きを世代と読み違えない", () => {
  // 別置きに同じ URL が入っていると、世代が無いのに札が「そなえ済」になる。
  assert.equal(isSonaeGenerationCache("soneki-abc123"), true);
  assert.equal(isSonaeGenerationCache("soneki-rt-abc123"), false);
  assert.equal(isSonaeGenerationCache("other-abc123"), false);
});

// --- 世代キャッシュの不変条件 --------------------------------------------

test("sw.js: 焼き込まれていない版は install で落とす（黙って劣化モードで動かない）", skipOnKill, () => {
  assert.match(SW_SRC, /BUILD === "__BUILD__" \|\| REQUIRED\.length === 0/);
  assert.match(SW_SRC, /throw new Error\("sw is not stamped"\)/);
});

test("sw.js: 世代の控えを書くのは install だけ（navigate の書き戻しを持たない）", skipOnKill, () => {
  // 対象の存在を先に固定する。関数名が変わると indexOf が -1 になり、
  // 検査対象ゼロの空文字列を調べて「通る」テストに化ける。
  assert.ok(
    SW_SRC.includes("async function networkFirstWithFallback"),
    "検査対象の関数が見つからない（テストが不活性化している）",
  );
  const nf = SW_SRC.slice(SW_SRC.indexOf("async function networkFirstWithFallback"));
  const body = nf.slice(0, nf.indexOf("\nself.addEventListener"));
  assert.ok(
    !body.includes("putSafe("),
    "navigate 経路が世代キャッシュに書き戻すと、HTML だけ新世代・資産は旧世代の版ズレを作れてしまう",
  );
});

test("sw.js: オフラインの受け皿の出口は scope 基準の絶対パス", skipOnKill, () => {
  assert.ok(
    !SW_SRC.includes('href="./tally/"'),
    "相対リンクは /terms/ や未知パスから開いたときに解決先が外れる",
  );
  assert.match(SW_SRC, /new URL\(SHELL_MAIN, self\.registration\.scope\)\.pathname/);
  // 必須一覧から辞書順で拾う位置依存に戻さない（ページが増えた日に
  // 出口だけ黙って別ページへ移り、ラベルは「頒布カウンター」のまま残る）
  assert.ok(
    !SW_SRC.includes("REQUIRED.find("),
    "出口を必須一覧の並び順から推測してはいけない",
  );
  assert.ok(SW_SRC.includes('const SHELL_MAIN = "__SHELL_MAIN__";'));
});

test("受け皿の出口は PRIMARY_SHELL に解決する（本番 scope で実測）", () => {
  const href = new URL(
    PRIMARY_SHELL,
    "https://ga-project.github.io/doujin-soneki/",
  ).pathname;
  assert.equal(href, "/doujin-soneki/tally/");
});

test("sw.js: 照合は書き手と同じ ignoreVary（有る控えを無いと読まない）", skipOnKill, () => {
  // 控えは `cache.put(url, res)` で「見出しの無い要求」として書かれる。
  // 読む側だけ Vary を見ると、有る控えを無いと読んで札が「そなえ中」から
  // 動かなくなる。両方の照合で無視する。
  const body = codeOnly(SW_SRC);
  const matchers = [...body.matchAll(/function (matchPage|matchAsset)\(/g)];
  assert.equal(matchers.length, 2, "照合の入口を見つけられていない（空振り）");
  for (const m of matchers) {
    const slice = body.slice(m.index, body.indexOf("}", m.index) + 1);
    assert.ok(
      slice.includes("ignoreVary: true"),
      `${m[1]} が Vary を見ている`,
    );
  }
});

test("sw.js: RSC ペイロードはクエリを無視して照合する（?_rsc で永久に外さない）", skipOnKill, () => {
  assert.match(SW_SRC, /index\.txt"\)/);
  assert.match(SW_SRC, /isRscPayload \? \{ ignoreSearch: true \}/);
});

test("sw-kill.js: 焼き込みの口を持つ（回復手段がビルドで落ちない）", () => {
  const kill = readFileSync(new URL("../scripts/sw-kill.js", import.meta.url), "utf8");
  assert.ok(kill.includes('const BUILD = "__BUILD__";'));
  assert.ok(kill.includes('["__REQUIRED__"]'));
  assert.ok(kill.includes('["__OPTIONAL__"]'));
});

test("sw.js: install の後は世代キャッシュに一切書かない（別置きにだけ書く）", skipOnKill, () => {
  // navigate だけでなく資産の経路も同じ。裏の更新で新しいデプロイの実体を
  // 旧世代に混ぜると、all-or-nothing が守っている版の一致が世代の内側で崩れる
  // （RSC ペイロードは ignoreSearch で照合するので、混ざると特に当たりやすい）。
  const afterInstall = codeOnly(SW_SRC).slice(
    codeOnly(SW_SRC).indexOf('self.addEventListener("activate"'),
  );
  // 控えへ書く入口は putSafe と fetchInto の2つ。どちらも別置き（runtime）
  // にしか向いてはならない（fetchInto は install の外でも呼べてしまう）。
  const writes = [
    ...afterInstall.matchAll(/(?:putSafe|fetchInto)\(\s*([A-Za-z]+)/g),
  ].map((m) => m[1]);
  assert.ok(writes.length > 0, "書き込み経路を見つけられていない（検査が空振り）");
  for (const target of writes) {
    // 書き先は別置き（runtime）そのものか、そこから導いた writable だけ。
    assert.ok(
      target === "runtime" || target === "writable",
      `install の後で ${target} に書いている`,
    );
  }
  // writable は別置きから導く（世代を指す変数を代入できないようにする）。
  assert.match(
    codeOnly(SW_SRC),
    /const writable = [^;]*\bruntime\b[^;]*;/,
    "書き先が別置き以外から導かれている",
  );
  assert.ok(
    !afterInstall.includes("cache.put("),
    "install の後で世代のキャッシュに直接書いている",
  );
  // 別置きは世代と別名で、掃除のときに巻き添えで消さない
  assert.ok(SW_SRC.includes("const RUNTIME ="), "別置きの宣言が無い");
  // 掃除は install と activate が同じ関数（sweepStale）を呼ぶ。残す集合を
  // その1か所で検査し、activate がその関数を通っていることも確かめる
  // （直に caches.delete を並べ直すと、規則が二重になって片方だけ腐る）。
  const sweep = codeOnly(SW_SRC).slice(
    codeOnly(SW_SRC).indexOf("async function sweepStale()"),
    codeOnly(SW_SRC).indexOf("function scoped("),
  );
  assert.ok(sweep.length > 0, "掃除を切り出せない（検査が空振り）");
  assert.ok(
    sweep.includes("n !== CACHE && n !== RUNTIME"),
    "掃除が現世代か別置きまで消している",
  );
  const activate = codeOnly(SW_SRC).slice(
    codeOnly(SW_SRC).indexOf('self.addEventListener("activate"'),
    codeOnly(SW_SRC).indexOf("function offlineNotice"),
  );
  assert.ok(activate.length > 0, "activate を切り出せない（検査が空振り）");
  assert.ok(activate.includes("sweepStale()"), "activate が掃除を通っていない");
  assert.ok(
    !activate.includes("caches.delete("),
    "activate が掃除の規則を書き直している（二重管理）",
  );
});

/**
 * ページ遷移の取り出し（offlineNotice / networkFirstWithFallback）を
 * 素の JS として取り出す。周りの定数と照合は引数で差し替える。
 */
function pageStrategy({ fetch, timeoutMs = 40 }) {
  const start = SW_SRC.indexOf("function offlineNotice");
  const end = SW_SRC.indexOf('self.addEventListener("fetch"');
  assert.ok(start > 0 && end > start, "遷移の経路を切り出せない（検査が空振り）");
  // discardBody は上の助け関数群にあるので、一緒に取り出して渡す。
  const helperStart = SW_SRC.indexOf("function discardBody");
  const helperEnd = SW_SRC.indexOf("/** 控えに入れられなくても");
  assert.ok(helperStart > 0 && helperEnd > helperStart, "discardBody を切り出せない");
  return new Function(
    "self",
    "fetch",
    "matchPage",
    "NETWORK_TIMEOUT_MS",
    "SHELL_MAIN",
    "Response",
    "URL",
    `${SW_SRC.slice(helperStart, helperEnd)}
     ${SW_SRC.slice(start, end)}
     return { networkFirstWithFallback, offlineNotice };`,
  )(
    { registration: { scope: "https://example.test/app/" } },
    fetch,
    async (cache) => cache.page,
    timeoutMs,
    "tally/",
    Response,
    URL,
  );
}

/** 本文を持つ応答と、その本文が閉じられたかを見る印。 */
function watchedBody(text, status) {
  const seen = { cancelled: false };
  const res = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
      cancel() {
        seen.cancelled = true;
      },
    }),
    { status },
  );
  return { res, seen };
}

test("ページ遷移: 非OK 応答は控えより優先せず、本文も閉じる", skipOnKill, async () => {
  // 配信面や経路が一時的に返したエラーページで、控えのある画面を置き換えない
  // （控えがあるのに当日ひらけなくなる）。使わない応答は流れを閉じる。
  const { res, seen } = watchedBody("<html>error</html>", 503);
  const { networkFirstWithFallback } = pageStrategy({ fetch: async () => res });
  const got = await networkFirstWithFallback({}, { page: "CACHED" });
  assert.equal(got, "CACHED", "非OK 応答を「取れた」に数えている");
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.cancelled, true, "使わない応答の本文を閉じていない");
});

test("ページ遷移: OK 応答は控えより優先する（更新が届かなくならない）", skipOnKill, async () => {
  const fresh = new Response("FRESH");
  const { networkFirstWithFallback } = pageStrategy({ fetch: async () => fresh });
  const got = await networkFirstWithFallback({}, { page: "CACHED" });
  assert.equal(got, fresh);
});

test("ページ遷移: 沈黙した回線は待たずに控えを出す", skipOnKill, async () => {
  // 遅い会場回線で待たされないための時間切れ。控えがあるなら待つ理由が無い。
  const started = Date.now();
  const { networkFirstWithFallback } = pageStrategy({
    fetch: () => new Promise(() => {}),
    timeoutMs: 40,
  });
  const got = await networkFirstWithFallback({}, { page: "CACHED" });
  assert.equal(got, "CACHED");
  assert.ok(Date.now() - started < 1000, "時間切れが効いていない");
});

test("ページ遷移: 時間切れで見切った応答も、後から届いたら閉じる", skipOnKill, async () => {
  // 会場で常に通るのはこちらの経路。ここを抜かすと、読まれない流れが
  // 遷移のたびに worker へ溜まる。
  let deliver;
  const { res, seen } = watchedBody("<html>late</html>", 200);
  const { networkFirstWithFallback } = pageStrategy({
    fetch: () =>
      new Promise((resolve) => {
        deliver = () => resolve(res);
      }),
    timeoutMs: 30,
  });
  const got = await networkFirstWithFallback({}, { page: "CACHED" });
  assert.equal(got, "CACHED");
  deliver();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(seen.cancelled, true, "見切った応答の本文を閉じていない");
});

test("ページ遷移: 控えが無ければ受け皿を出し、出口は焼き込んだ値にする", skipOnKill, async () => {
  const { networkFirstWithFallback } = pageStrategy({
    fetch: async () => {
      throw new Error("offline");
    },
  });
  const got = await networkFirstWithFallback({}, { page: undefined });
  assert.equal(got.status, 503);
  const html = await got.text();
  // 唯一の出口は scope 基準の絶対パスで、焼き込んだ行き先を指す。
  assert.ok(html.includes('href="/app/tally/"'), "受け皿の出口が違う");
});

/**
 * sw.js を焼き込んで別コンテキストで読み込み、install を実際に走らせる。
 *
 * 正規表現では「throw する／世代を捨てる」といった要の不変条件を守れない
 * （どちらも消してもテストは緑のままになる）。Service Worker の API は
 * 最小限を偽物で与える。本文の転送は put の中で起きるので、控えは
 * `res.text()` を通してから記録する（実物と同じ順序にするため）。
 */
function loadWorker({
  required,
  optional = [],
  respond,
  budgetMs = 200,
  /** false にすると中断の仕組みが無い端末を模す（古い実装の環境）。 */
  withAbort = true,
  /** 既に活きている版が居る端末（更新のとき）。 */
  active = null,
  /** 端末に既にある控え（世代名 → URL の配列）。 */
  existing = {},
  /** true にすると Cache Storage が読めない端末を模す。 */
  storageFails = false,
  /**
   * 一部の操作だけを壊す端末を模す。
   * "keys" | "delete" | "open" | "match"（世代）| "match-rt"（別置き）
   */
  storageBroken = [],
  /** 一部の操作だけが返らない端末を模す（値は storageBroken と同じ）。 */
  storageSilent = [],
  /** 登録の解除が返らない端末を模す。 */
  unregisterSilent = false,
  /** 制御の引き取りが返らない端末を模す。 */
  claimSilent = false,
  /** false にすると本文を読めない実装（response.body 無し）を模す。 */
  withStreams = true,
}) {
  // 差し替えは1つでも空振りすると、検査が別物（本番の 30 秒待ちなど）を
  // 見たまま緑になる。当たったことを毎回確かめる。
  const swap = (text, from, to) => {
    const out = text.replace(from, to);
    assert.notEqual(out, text, `焼き込みが空振り: ${from}`);
    return out;
  };
  let src = SW_SRC;
  src = swap(src, 'const BUILD = "__BUILD__";', 'const BUILD = "testgen";');
  src = swap(src, 'const SHELL_MAIN = "__SHELL_MAIN__";', 'const SHELL_MAIN = "tally/";');
  src = swap(src, '["__REQUIRED__"]', JSON.stringify(required));
  src = swap(src, '["__OPTIONAL__"]', JSON.stringify(optional));
  src = swap(src, /const REQUIRED_TIMEOUT_MS = [\d_]+;/, `const REQUIRED_TIMEOUT_MS = ${budgetMs};`);
  src = swap(src, /const OPTIONAL_TIMEOUT_MS = [\d_]+;/, `const OPTIONAL_TIMEOUT_MS = ${budgetMs};`);
  src = swap(src, /const RUNTIME_TIMEOUT_MS = [\d_]+;/, `const RUNTIME_TIMEOUT_MS = ${budgetMs};`);
  src = swap(src, /const STEP_TIMEOUT_MS = [\d_]+;/, `const STEP_TIMEOUT_MS = ${budgetMs};`);

  const stores = new Map();
  for (const [name, urls] of Object.entries(existing)) {
    // 書き込みと同じ形で置く。文字列のまま置くと、読み返しが本文の無い
    // 200 になり、控えの中身を見る検査が「空」と比べて通ってしまう。
    stores.set(
      name,
      new Map(
        urls.map((u) => [
          u,
          { body: `held:${u}`, status: 200, statusText: "", headers: [] },
        ]),
      ),
    );
  }
  const fail = () => {
    throw new Error("storage unavailable");
  };
  /** その操作が壊れている／黙っている端末を演じる。 */
  const gate = async (op) => {
    if (storageFails || storageBroken.includes(op)) fail();
    if (storageSilent.includes(op)) await new Promise(() => {});
  };
  let jammed = false;
  const caches = {
    async open(name) {
      await gate("open");
      if (!stores.has(name)) stores.set(name, new Map());
      const held = stores.get(name);
      // 鍵は URL 文字列。実物は Request でも URL でも受けるので合わせる。
      const asKey = (key) => (typeof key === "string" ? key : key.url);
      return {
        // 本文の転送は put の中で起きる（実物と同じ順序にする）。
        // 状態と見出しも実物と同じく保つ（本文だけ保つと、控えから出した
        // 応答の Content-Type が落ちても検査に出ない）。
        put: async (key, res) => {
          const stored = {
            body: await res.text(),
            status: res.status,
            statusText: res.statusText,
            headers: [...res.headers],
          };
          // 記憶域が詰まって返らない形（書き込みだけが返らない）
          if (jammed) await new Promise(() => {});
          held.set(asKey(key), stored);
        },
        delete: async (key) => held.delete(asKey(key)),
        match: async (key, options) => {
          // 世代と別置きを別々に壊す／黙らせる（片方だけ読めない端末を作る）。
          await gate(name.startsWith("soneki-rt-") ? "match-rt" : "match");
          const url = asKey(key);
          const stored =
            options && options.ignoreSearch
              ? held.get(url.split("?")[0])
              : held.get(url);
          if (stored === undefined) return undefined;
          return new Response(stored.body, {
            status: stored.status,
            statusText: stored.statusText,
            headers: stored.headers,
          });
        },
      };
    },
    async keys() {
      await gate("keys");
      return [...stores.keys()];
    },
    async delete(name) {
      await gate("delete");
      return stores.delete(name);
    },
  };

  const handlers = new Map();
  const calls = { skipWaiting: 0, claim: 0, unregister: 0, navigated: [] };
  const self = {
    addEventListener: (type, fn) => handlers.set(type, fn),
    registration: {
      scope: "https://example.test/app/",
      active,
      unregister: async () => {
        calls.unregister += 1;
        if (unregisterSilent) await new Promise(() => {});
        return true;
      },
    },
    skipWaiting: async () => {
      calls.skipWaiting += 1;
    },
    clients: {
      matchAll: async () => [],
      claim: async () => {
        calls.claim += 1;
        if (claimSilent) await new Promise(() => {});
      },
    },
  };
  // sw.js は install では URL 文字列、取り出しでは Request を渡す。
  // 試験側の相手は URL 文字列だけを見ればよいようにする。
  // silenced のあいだは、応答を一切返さない相手を演じる。
  let silenced = false;
  let cut = false;
  let waitUntilBroken = false;
  const fetchStub = async (input, init) => {
    if (cut) throw new Error("offline");
    const options = init || {};
    const answer = silenced
      ? new Promise(() => {})
      : respond(typeof input === "string" ? input : input.url, options);
    // 本物と同じく、中断されたら投げる（signal を無視すると、期限の付け方の
    // 違いが検査に出なくなる）。
    const res = options.signal
      ? await Promise.race([
          answer,
          new Promise((_resolve, reject) => {
            const fail = () => reject(new Error("aborted"));
            if (options.signal.aborted) fail();
            else options.signal.addEventListener("abort", fail);
          }),
        ])
      : await answer;
    // 本文を読めない実装（古い Safari 等）では response.body を持たない。
    return withStreams ? res : hideBody(res);
  };
  const sandbox = {
    self,
    caches,
    fetch: fetchStub,
    Response,
    URL,
    setTimeout,
    clearTimeout,
  };
  // 渡さなければ `typeof AbortController === "undefined"` の端末になる。
  if (withAbort) sandbox.AbortController = AbortController;
  runInNewContext(src, sandbox);

  /** ハンドラを1つ動かし、waitUntil に渡された仕事の決着を返す。 */
  const dispatch = async (type, extra = {}) => {
    let waited = Promise.resolve();
    handlers.get(type)({
      waitUntil: (p) => {
        waited = p;
      },
      ...extra,
    });
    // 例外は別コンテキストで作られる（＝別レルム）ので instanceof は使えない。
    // 成功なら null、失敗ならその例外を返す。
    return waited.then(
      () => null,
      (e) => e,
    );
  };

  /** 取り出しを1回動かし、返された応答（または例外）を得る。 */
  const request = async (url, { mode = "no-cors", method = "GET", silent = false } = {}) => {
    if (silent) silenced = true;
    let answered;
    const background = [];
    handlers.get("fetch")({
      request: { url, method, mode },
      respondWith: (p) => {
        answered = p;
      },
      waitUntil: (p) => {
        background.push(p);
        // 引き延ばしを受け付けない状態（イベントが既に決着している等）。
        if (waitUntilBroken) throw new Error("waitUntil unavailable");
      },
    });
    const res =
      answered === undefined
        ? undefined
        : await answered.then(
            (r) => r,
            (e) => ({ error: e }),
          );
    await Promise.all(background.map((p) => p.catch(() => {})));
    return res;
  };

  return {
    stores,
    calls,
    dispatch,
    request,
    self,
    /** 書き込みだけが返らない記憶域にする。 */
    jam: () => {
      jammed = true;
    },
    /** 以後の取得を必ず失敗させる（圏外）。 */
    offline: () => {
      cut = true;
    },
    /** 以後、裏仕事の引き延ばしを受け付けない状態にする。 */
    breakWaitUntil: () => {
      waitUntilBroken = true;
    },
  };
}

async function runInstall(options) {
  const worker = loadWorker(options);
  return { outcome: await worker.dispatch("install"), stores: worker.stores };
}

const GENERATIONS = (stores) =>
  [...stores.keys()].filter((n) => n.startsWith("soneki-"));

test("install: 必須が全部取れたら、その世代の控えに一式が入る", skipOnKill, async () => {
  const { outcome, stores } = await runInstall({
    required: ["", "tally/"],
    optional: ["terms/"],
    respond: async (url) => new Response(`body:${url}`),
  });
  assert.equal(outcome, null, "install が失敗している");
  const gen = stores.get("soneki-testgen");
  assert.ok(gen, "世代の控えが作られていない");
  assert.equal(gen.get("https://example.test/app/").body, "body:https://example.test/app/");
  assert.equal(
    gen.get("https://example.test/app/tally/").body,
    "body:https://example.test/app/tally/",
  );
  // 任意分も同じ世代に入る（取れた場合）
  assert.ok(gen.has("https://example.test/app/terms/"));
});

test("install: 必須が1つ欠けたら install は失敗し、書きかけの世代を残さない", skipOnKill, async () => {
  // ここで解決してしまうと install が「成功」となり、sw.js のバイトが
  // 変わらない限り二度と install が走らない＝取りこぼした端末が次の
  // デプロイまで永久に控えを持てない。書きかけを残せば、版ズレした一式が
  // 「揃っている」ものとして読まれる。
  const { outcome, stores } = await runInstall({
    required: ["", "tally/"],
    respond: async (url) =>
      url.endsWith("/tally/")
        ? new Response("", { status: 500 })
        : new Response(`body:${url}`),
  });
  assert.ok(outcome !== null, "install が失敗していない");
  assert.match(String(outcome.message), /precache incomplete/);
  assert.deepEqual(GENERATIONS(stores), [], "書きかけの世代が残っている");
});

test("install: 本文が沈黙した1本は期限で畳み、世代を残さない", skipOnKill, async () => {
  // 応答ヘッダだけ返って本文が来ない相手。期限が取得しか覆っていないと
  // install は無期限に開いたままになり、札が「そなえ中」から動かない。
  const started = Date.now();
  const { outcome, stores } = await runInstall({
    required: ["", "tally/"],
    budgetMs: 80,
    respond: async (url, init) =>
      url.endsWith("/tally/")
        ? slowBody("never", 10_000, init.signal)
        : new Response(`body:${url}`),
  });
  assert.ok(outcome !== null, "沈黙した本文で install が畳まれていない");
  assert.ok(Date.now() - started < 2000, "期限が効いていない");
  assert.deepEqual(GENERATIONS(stores), [], "書きかけの世代が残っている");
});

/**
 * gapMs ごとに1片ずつ、count 片を届ける本文（遅いが進んでいる回線）。
 * close=false にすると、届け終えた後に閉じずに黙る（途中で止まった回線）。
 */
function tricklingBody(text, gapMs, count, close = true) {
  return new Response(
    new ReadableStream({
      start(controller) {
        let sent = 0;
        let timer;
        const step = () => {
          if (sent >= count) {
            if (!close) return; // 閉じずに黙る
            try {
              controller.close();
            } catch {
              /* もう閉じている */
            }
            return;
          }
          sent += 1;
          try {
            controller.enqueue(new TextEncoder().encode(text));
          } catch {
            return;
          }
          timer = setTimeout(step, gapMs);
        };
        timer = setTimeout(step, gapMs);
        this.stop = () => clearTimeout(timer);
      },
      cancel() {
        if (this.stop) this.stop();
      },
    }),
  );
}

test("install: 遅いだけで進んでいる回線を落とさない（総時間で畳まない）", skipOnKill, async () => {
  // 総時間で切ると、1本ずつは進んでいるのに全部が同時に期限へ当たり、
  // 世代ごと捨てられる ＝「遅いだけで繋がる回線」を「控えが取れない端末」に
  // 落とす。この機能が守ろうとしている当のもの。
  //
  // 1片あたりの間隔（40ms）は期限（120ms）の内側だが、全体（10片＝400ms 超）は
  // 期限をはるかに越える。総時間で畳む実装ではここで必ず失敗する。
  const started = Date.now();
  const { outcome, stores } = await runInstall({
    required: ["", "tally/", "terms/", "privacy/"],
    budgetMs: 120,
    respond: async () => tricklingBody("x", 40, 10),
  });
  assert.ok(
    Date.now() - started > 120,
    "検査が速すぎて総時間の期限を跨いでいない（空振り）",
  );
  assert.equal(outcome, null, "遅いだけの回線で install を失敗させている");
  assert.equal(stores.get("soneki-testgen").size, 4);
});

test("install: 控えへの書き込みが返らなくても畳む（そなえ中で止めない）", skipOnKill, async () => {
  // 取得も本文も終わったのに記憶域が詰まって返らない、という形。ここに
  // 期限が無いと install は開いたままで、札は「そなえ中」から動かず、
  // 失敗として畳まれないので再試行もされない。
  const started = Date.now();
  const worker = loadWorker({
    required: ["", "tally/"],
    budgetMs: 80,
    respond: async (url) => new Response(`body:${url}`),
  });
  const original = worker.stores;
  void original;
  // 書き込みだけが返らない相手にする
  worker.jam();
  const outcome = await worker.dispatch("install");
  assert.ok(outcome !== null, "書き込みが返らないのに install が終わらない");
  assert.ok(Date.now() - started < 3000, "書き込みの期限が効いていない");
});

test("install: ヘッダの期限で見切った応答も、後から届いたら閉じる", skipOnKill, async () => {
  // 中断が使えない端末では取得が走り続ける。届いた分を閉じないと、
  // 読まれない流れが取得の数だけ worker に溜まる。
  let deliver;
  const late = watchedBody("late", 200);
  const worker = loadWorker({
    required: ["", "tally/"],
    budgetMs: 60,
    withAbort: false,
    respond: async (url) =>
      url.endsWith("/tally/")
        ? new Promise((resolve) => {
            deliver = () => resolve(late.res);
          })
        : new Response(`body:${url}`),
  });
  const outcome = await worker.dispatch("install");
  assert.ok(outcome !== null, "ヘッダの期限が効いていない");
  deliver();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(late.seen.cancelled, true, "見切った応答の本文を閉じていない");
});

test("install: 途中で止まった本文は畳む（進まないものは待たない）", skipOnKill, async () => {
  // 「進んでいる限り待つ」は「永久に待つ」ではない。無音が続いたら諦める。
  const started = Date.now();
  const { outcome, stores } = await runInstall({
    required: ["", "tally/"],
    budgetMs: 80,
    respond: async (url) =>
      url.endsWith("/tally/")
        ? tricklingBody("x", 30, 2, false) // 2片だけ届いて、あとは無音
        : new Response(`body:${url}`),
  });
  assert.ok(outcome !== null, "止まった本文を畳んでいない");
  assert.ok(Date.now() - started < 2000, "無音の期限が効いていない");
  assert.deepEqual(GENERATIONS(stores), []);
});

test("install: 任意分が沈黙しても世代は成立する（人質にしない）", skipOnKill, async () => {
  const started = Date.now();
  const { outcome, stores } = await runInstall({
    required: ["", "tally/"],
    optional: ["terms/"],
    budgetMs: 80,
    respond: async (url, init) =>
      url.endsWith("/terms/")
        ? slowBody("never", 10_000, init.signal)
        : new Response(`body:${url}`),
  });
  assert.equal(outcome, null, "任意分の沈黙で install が終わらない");
  assert.ok(Date.now() - started < 2000, "任意分の期限が効いていない");
  const gen = stores.get("soneki-testgen");
  assert.equal(gen.size, 2, "取れなかった任意分を控えている");
});

test("install: 中断の仕組みが無い端末でも期限で畳む", skipOnKill, async () => {
  // 期限が signal だけに乗っていると、AbortController の無い端末では
  // install が永遠に開いたまま＝札が「そなえ中」から動かず、失敗として
  // 畳まれないので再試行もされない。時計でも畳めることを見る。
  const started = Date.now();
  const { outcome, stores } = await runInstall({
    required: ["", "tally/"],
    budgetMs: 80,
    withAbort: false,
    respond: async (url, init) =>
      url.endsWith("/tally/")
        ? slowBody("never", 10_000, init.signal)
        : new Response(`body:${url}`),
  });
  assert.ok(outcome !== null, "中断が無い端末で install が畳まれていない");
  assert.ok(Date.now() - started < 2000, "時計の期限が効いていない");
  assert.deepEqual(GENERATIONS(stores), []);
});

test("install: 焼き込まれていない版は名乗らない", skipOnKill, async () => {
  // REQUIRED が空のまま活きると「何も控えないのに install は成功し、全 GET を
  // 溜め込むだけの世代なしワーカー」に退化する（そのとき札は「そなえ済」）。
  const { outcome, stores } = await runInstall({
    required: [],
    respond: async (url) => new Response(`body:${url}`),
  });
  assert.ok(outcome !== null, "焼き込み無しで install が成功している");
  assert.match(String(outcome.message), /not stamped/);
  assert.deepEqual(GENERATIONS(stores), []);
});

test("install: 活きている版が無い端末では、前の失敗が残した書きかけを掃除する", skipOnKill, async () => {
  // install が途中で強制終了されると書きかけの世代が残るが、その掃除は
  // activate ＝**成功した install の後**にしか走らない。会場で install が
  // 続けて失敗する端末では掃除の機会が来ず、容量だけが埋まる。
  const { outcome, stores } = await runInstall({
    required: ["", "tally/"],
    existing: { "soneki-old": ["https://example.test/app/"] },
    respond: async (url) => new Response(`body:${url}`),
  });
  assert.equal(outcome, null);
  assert.deepEqual(GENERATIONS(stores).sort(), ["soneki-testgen"]);
});

test("install: 掃除が転けても必須分は取りに行く", skipOnKill, async () => {
  // 掃除は best-effort。ここで投げると、1本も取りに行かないまま install が
  // 落ちる ＝掃除で救うはずだった端末を、掃除のせいで控え無しに固定する。
  const { outcome, stores } = await runInstall({
    required: ["", "tally/"],
    storageBroken: ["delete"],
    existing: { "soneki-old": ["https://example.test/app/"] },
    respond: async (url) => new Response(`body:${url}`),
  });
  assert.equal(outcome, null, "掃除の失敗で install ごと落ちている");
  assert.equal(stores.get("soneki-testgen").size, 2);
});

test("install: 掃除が黙っても必須分は取りに行く", stalls, async () => {
  // 失敗だけでなく「返らない」も塞ぐ。期限が無ければ install は開いたままで、
  // 札は「そなえ中（開いたまま）」から動かず、失敗として畳まれず再試行もない。
  const { outcome, stores } = await runInstall({
    required: ["", "tally/"],
    storageSilent: ["delete"],
    existing: { "soneki-old": ["https://example.test/app/"] },
    respond: async (url) => new Response(`body:${url}`),
  });
  assert.equal(outcome, null, "掃除の沈黙で install が終わらない");
  assert.equal(stores.get("soneki-testgen").size, 2);
});

test("install: 取りこぼしの後始末が黙っても、失敗として畳む", stalls, async () => {
  // 取りこぼした世代を消す段で止まると install は開いたままになり、版は
  // redundant にならない ＝札は「そなえ中」で止まり、再試行の機会も来ない。
  const { outcome } = await runInstall({
    required: ["", "tally/"],
    storageSilent: ["delete"],
    respond: async (url) =>
      url.endsWith("/tally/") ? new Response("", { status: 503 }) : new Response("ok"),
  });
  assert.notEqual(outcome, null, "取りこぼしの後始末で install が開いたままになる");
  assert.match(String(outcome.message), /precache incomplete/);
});

test("install: 控えを開けないまま黙る端末では畳む", stalls, async () => {
  // 開けないなら控えは持てない。開いたまま止まるより、失敗として畳んで
  // 次の機会に回す方がよい（畳めば札も「そなえ不可」まで動く）。
  const { outcome } = await runInstall({
    required: ["", "tally/"],
    storageSilent: ["open"],
    respond: async (url) => new Response(`body:${url}`),
  });
  assert.notEqual(outcome, null, "記憶域の沈黙で install が開いたままになる");
  assert.match(String(outcome.message), /stalled/);
});

test("install: 活きている版があるなら古い世代に触らない（配布中の控えを抜かない）", skipOnKill, async () => {
  const { outcome, stores } = await runInstall({
    required: ["", "tally/"],
    active: { state: "activated" },
    existing: { "soneki-old": ["https://example.test/app/"] },
    respond: async (url) => new Response(`body:${url}`),
  });
  assert.equal(outcome, null);
  assert.ok(stores.has("soneki-old"), "配布中の世代を install が消している");
});

test("install: 初回だけ待たずに制御下へ入る（更新では途中ですり替えない）", skipOnKill, async () => {
  const first = loadWorker({
    required: ["", "tally/"],
    respond: async (url) => new Response(`body:${url}`),
  });
  assert.equal(await first.dispatch("install"), null);
  assert.equal(first.calls.skipWaiting, 1, "初回の繰り上げが無い");

  const update = loadWorker({
    required: ["", "tally/"],
    active: { state: "activated" },
    respond: async (url) => new Response(`body:${url}`),
  });
  assert.equal(await update.dispatch("install"), null);
  assert.equal(update.calls.skipWaiting, 0, "更新で開いている画面をすり替えている");
});

test("activate: 現世代と別置きだけ残し、制御を引き取る", skipOnKill, async () => {
  const worker = loadWorker({
    required: ["", "tally/"],
    active: { state: "activated" },
    existing: {
      "soneki-old": ["https://example.test/app/"],
      "soneki-rt-testgen": ["https://example.test/app/x.js"],
      other: ["https://example.test/app/"],
    },
    respond: async (url) => new Response(`body:${url}`),
  });
  await worker.dispatch("install");
  assert.equal(await worker.dispatch("activate"), null);
  assert.deepEqual(
    [...worker.stores.keys()].sort(),
    ["other", "soneki-rt-testgen", "soneki-testgen"],
  );
  assert.equal(worker.calls.claim, 1, "制御を引き取っていない");
});

test("activate: 掃除が転けても制御を引き取る", skipOnKill, async () => {
  // 掃除は後片付けで、控えを使うのに要らない。直列に await すると、記憶域を
  // 読めない端末では claim まで届かず、控えは揃っているのにページが制御下に
  // 入らない。ページ側は controllerchange を待ち続け、札は「そなえ中
  // （開いたまま）」で永久に止まる ＝取れている控えを取れていないかのように
  // 見せる。
  const worker = loadWorker({
    required: ["", "tally/"],
    active: { state: "activated" },
    storageFails: true,
    respond: async (url) => new Response(`body:${url}`),
  });
  assert.equal(
    await worker.dispatch("activate"),
    null,
    "掃除の失敗で activate ごと転けている",
  );
  assert.equal(worker.calls.claim, 1, "掃除が転けると制御を引き取っていない");
});

test("activate: 掃除が黙っても制御を引き取る", stalls, async () => {
  const worker = loadWorker({
    required: ["", "tally/"],
    active: { state: "activated" },
    storageSilent: ["keys"],
    respond: async (url) => new Response(`body:${url}`),
  });
  assert.equal(
    await worker.dispatch("activate"),
    null,
    "掃除の沈黙で activate が終わらない",
  );
  assert.equal(worker.calls.claim, 1, "掃除の沈黙で制御を引き取っていない");
});

test("activate: 掃除の沈黙で制御が止まらない（期限を置く）", skipOnKill, () => {
  // 失敗だけでなく「返らない」も塞ぐ。記憶域が沈黙する端末では、期限が
  // 無ければ waitUntil が開いたままになり、claim は永久に来ない。
  const body = codeOnly(SW_SRC);
  const activate = body.slice(
    body.indexOf('self.addEventListener("activate"'),
    body.indexOf("function offlineNotice"),
  );
  assert.ok(activate.length > 0, "activate を切り出せない（検査が空振り）");
  assert.ok(
    activate.includes("atMost(sweepStale(), STEP_TIMEOUT_MS)"),
    "掃除に期限が無い（沈黙した記憶域で worker が生き続ける）",
  );
  assert.ok(
    activate.includes(
      "atMost((async () => self.clients.claim())(), STEP_TIMEOUT_MS)",
    ),
    "claim に期限が無い（沈黙すると waitUntil が開いたままになる）",
  );
  // 掃除の失敗は**作った時点**で受け止める。後から括ると、待ちを跨いだ失敗が
  // 誰にも受け取られないまま unhandledrejection として worker の外に出る。
  assert.ok(
    activate.indexOf("atMost(sweepStale()") < activate.indexOf("claim()"),
    "掃除の期限を、掃除を始めた後から括っている",
  );
  assert.ok(
    activate.indexOf("claim()") < activate.indexOf("await swept"),
    "掃除の決着を待ってから制御を引き取っている（繰り上げが遅れる）",
  );
});

/** その名前の控えに入っている枚数（キャッシュの有無ではなく中身で見る）。 */
function held(stores, name) {
  const store = stores.get(name);
  return store === undefined ? 0 : store.size;
}

/**
 * 取り消し版（kill switch）を動かす最小の入れ物。回復手段は「壊れた端末でも
 * 効く」ことに意味があるので、文字列の検査ではなく実際に動かして確かめる。
 */
function loadKillWorker({
  existing = {},
  storageBroken = [],
  storageSilent = [],
  unregisterSilent = false,
  windows = [],
  stepMs = 60,
} = {}) {
  const src = KILL_SRC.replace(
    /const STEP_TIMEOUT_MS = [\d_]+;/,
    `const STEP_TIMEOUT_MS = ${stepMs};`,
  );
  assert.notEqual(src, KILL_SRC, "焼き込みが空振り: STEP_TIMEOUT_MS");
  const stores = new Map(Object.keys(existing).map((n) => [n, existing[n]]));
  const gate = async (op) => {
    if (storageBroken.includes(op)) throw new Error("storage unavailable");
    if (storageSilent.includes(op)) await new Promise(() => {});
  };
  const calls = { skipWaiting: 0, unregister: 0, navigated: [] };
  const handlers = new Map();
  const self = {
    addEventListener: (type, fn) => handlers.set(type, fn),
    skipWaiting: async () => {
      calls.skipWaiting += 1;
    },
    registration: {
      unregister: async () => {
        calls.unregister += 1;
        if (unregisterSilent) await new Promise(() => {});
        return true;
      },
    },
    clients: {
      matchAll: async () => windows,
    },
  };
  const caches = {
    async keys() {
      await gate("keys");
      return [...stores.keys()];
    },
    async delete(name) {
      await gate("delete");
      return stores.delete(name);
    },
  };
  runInNewContext(src, { self, caches, setTimeout, clearTimeout, calls });
  const dispatch = async (type) => {
    let waited = Promise.resolve();
    handlers.get(type)({
      waitUntil: (p) => {
        waited = p;
      },
    });
    return waited.then(
      () => null,
      (e) => e,
    );
  };
  return { dispatch, calls, stores };
}

/** 開き直しの相手。`navigate` の壊れ方を差し替えられるようにする。 */
function fakeWindow(url, { navigate } = {}) {
  return {
    url,
    navigate:
      navigate ||
      (async () => {
        /* 開き直せた */
      }),
  };
}

test("sw-kill: 控えを消し、登録を解き、開いているタブを開き直す", stalls, async () => {
  const seen = [];
  const worker = loadKillWorker({
    existing: { "soneki-a": 1, "soneki-rt-a": 1, other: 1 },
    windows: [
      fakeWindow("https://x/app/", {
        navigate: async (u) => {
          seen.push(u);
        },
      }),
    ],
  });
  assert.equal(await worker.dispatch("install"), null);
  assert.equal(worker.calls.skipWaiting, 1, "繰り上げていない");
  assert.equal(await worker.dispatch("activate"), null);
  assert.deepEqual([...worker.stores.keys()], ["other"], "自分の世代だけ消していない");
  assert.equal(worker.calls.unregister, 1, "登録を解いていない");
  assert.deepEqual(seen, ["https://x/app/"], "開き直させていない");
});

test("sw-kill: 記憶域が壊れていても・返らなくても撤去を進める", stalls, async () => {
  for (const broken of [{ storageBroken: ["keys"] }, { storageSilent: ["delete"] }]) {
    const seen = [];
    const worker = loadKillWorker({
      ...broken,
      existing: { "soneki-a": 1 },
      windows: [
        fakeWindow("https://x/app/", {
          navigate: async (u) => {
            seen.push(u);
          },
        }),
      ],
    });
    assert.equal(await worker.dispatch("activate"), null);
    assert.equal(worker.calls.unregister, 1, "控えの都合で登録を解けていない");
    assert.deepEqual(seen, ["https://x/app/"], "控えの都合で開き直せていない");
  }
});

test("sw-kill: 解除が返らなくても開き直しまで進む", stalls, async () => {
  const seen = [];
  const worker = loadKillWorker({
    unregisterSilent: true,
    windows: [
      fakeWindow("https://x/app/", {
        navigate: async (u) => {
          seen.push(u);
        },
      }),
    ],
  });
  assert.equal(await worker.dispatch("activate"), null);
  assert.deepEqual(seen, ["https://x/app/"], "解除の沈黙で開き直しが止まっている");
});

test("sw-kill: 1つのタブが返らない・投げても、残りのタブを開き直す", stalls, async () => {
  for (const broken of [
    () => new Promise(() => {}),
    () => {
      throw new Error("navigate unavailable");
    },
  ]) {
    const seen = [];
    const worker = loadKillWorker({
      windows: [
        fakeWindow("https://x/app/stuck", { navigate: broken }),
        fakeWindow("https://x/app/tally/", {
          navigate: async (u) => {
            seen.push(u);
          },
        }),
      ],
    });
    assert.equal(await worker.dispatch("activate"), null);
    assert.deepEqual(
      seen,
      ["https://x/app/tally/"],
      "1つのタブの都合で残りが取り残されている",
    );
  }
});

test("sw-kill.js: 控えを消せない端末でも登録を解除する", () => {
  // 回復手段は「壊れていても効く」ことに意味がある。破棄をそのまま await
  // すると、記憶域が読めない／返らない端末では解除も開き直しも起きず、
  // まさに回復が要る場面で静かに効かない。
  const kill = readFileSync(new URL("../scripts/sw-kill.js", import.meta.url), "utf8");
  const body = codeOnly(kill);
  const drop = body.indexOf("caches.keys()");
  const off = body.indexOf("self.registration.unregister()");
  assert.ok(drop > 0 && off > drop, "撤去の手順を見つけられない（検査が空振り）");
  // 破棄は解除より前に**上限付きで**畳まれていること。try/catch だけでは
  // 「返らない」を塞げず、`.catch()` を数えると同じ待ちに戻した版も通る。
  assert.match(
    body.slice(drop, off),
    /atMost\(\s*purge/,
    "控えの破棄の失敗・沈黙が、登録の解除を止める形になっている",
  );
  // 解除と開き直しにも同じ上限を置く（撤去の3手すべてが「返らない」に耐える）。
  assert.match(
    body,
    /atMost\(\s*self\.registration\.unregister\(\)/,
    "登録の解除に上限が無い（返らない端末で worker が生き続ける）",
  );
  assert.match(body, /atMost\(\s*reopen/, "開き直しに上限が無い");
  // 開き直しは1つずつ待たない（返らないタブが残りのタブを取り残す）。
  assert.ok(
    !/for \(const client of clients\)/.test(body),
    "開き直しを1つずつ待っている",
  );
  assert.match(body, /Promise\.all\(\s*clients\.map/, "開き直しを並べていない");
});

test("取り出し: 控えの遷移は共有リンクのクエリ付きでも当たる", skipOnKill, async () => {
  // 当日いちばん通る経路。`?utm_source=...` 付きの共有リンクや QR から
  // 開いたときに控えへ当たらないと、控えがあるのに受け皿が出る。
  let asked = 0;
  const worker = loadWorker({
    required: ["", "tally/"],
    respond: async (url) => {
      asked += 1;
      return new Response(`body:${url}`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  });
  await worker.dispatch("install");
  worker.offline();

  const page = await worker.request(
    "https://example.test/app/tally/?utm_source=x",
    { mode: "navigate" },
  );
  assert.equal(await page.text(), "body:https://example.test/app/tally/");
  // 控えから出しているので、控えたときの見出しがそのまま乗る
  assert.equal(page.headers.get("content-type"), "text/html; charset=utf-8");
  void asked;
});

test("取り出し: 控えは控えたときの状態と見出しのまま出す", skipOnKill, async () => {
  // 見出しが落ちると、控えから出した CSS/JS が型で撥ねられ「画面は出るのに
  // 操作が効かない」になる（この設計がいちばん避けたい壊れ方）。
  const worker = loadWorker({
    required: ["", "tally/"],
    respond: async (url) =>
      new Response(`body:${url}`, {
        status: 200,
        statusText: "OK",
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  });
  await worker.dispatch("install");
  worker.offline();
  const res = await worker.request("https://example.test/app/tally/", {
    mode: "navigate",
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "text/html; charset=utf-8");
});

test("取り出し: 世代にある資産はネットワークを使わずに出す", skipOnKill, async () => {
  let asked = 0;
  const worker = loadWorker({
    required: ["", "tally/"],
    respond: async (url) => {
      asked += 1;
      return new Response(`body:${url}`);
    },
  });
  await worker.dispatch("install");
  const before = asked;
  const res = await worker.request("https://example.test/app/tally/");
  assert.equal(await res.text(), "body:https://example.test/app/tally/");
  assert.equal(asked, before, "控えがあるのにネットワークへ行っている");
});

test("取り出し: 裏の更新は中断が使えない端末でも打ち切る", skipOnKill, async () => {
  // 控えを返した後の裏の更新が沈黙すると、signal だけに頼った実装では
  // waitUntil が閉じず、worker が生かされ続ける（会場では電池が要る）。
  const worker = loadWorker({
    required: ["", "tally/"],
    budgetMs: 60,
    withAbort: false,
    respond: async (url) => new Response(`body:${url}`),
  });
  await worker.dispatch("install");
  // まず別置きに1つ入れる（次の取得で「控えあり＋裏で更新」の経路に入る）
  const first = await worker.request("https://example.test/app/x.js");
  assert.equal(await first.text(), "body:https://example.test/app/x.js");

  const started = Date.now();
  const again = await worker.request("https://example.test/app/x.js", {
    silent: true,
  });
  const elapsed = Date.now() - started;
  assert.equal(await again.text(), "body:https://example.test/app/x.js");
  // 裏の更新が実際に走って打ち切られたこと（走っていなければ一瞬で終わる）
  assert.ok(elapsed >= 50, "裏の更新の経路に入っていない（検査が空振り）");
  assert.ok(elapsed < 2000, "裏の更新の引き延ばしが閉じない");
});

test("取り出し: 裏の更新が非OK なら本文を閉じる", skipOnKill, async () => {
  // 会場の捕捉ページが 503 を返し続けると、控えを出すたびに未読の流れが
  // worker に溜まる。
  let portal = null;
  const worker = loadWorker({
    required: ["", "tally/"],
    budgetMs: 200,
    respond: async (url) => {
      if (!url.endsWith("/x.js")) return new Response(`body:${url}`);
      if (portal === null) return new Response(`body:${url}`);
      return portal.res;
    },
  });
  await worker.dispatch("install");
  await worker.request("https://example.test/app/x.js");

  portal = watchedBody("<html>portal</html>", 503);
  await worker.request("https://example.test/app/x.js");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(portal.seen.cancelled, true, "非OK の裏の更新を閉じていない");
});

test("取り出し: 圏外の資産をネットワークへ二度取りに行かない", skipOnKill, async () => {
  // 記憶域の失敗に備えた素通しの受けが、回線の失敗まで拾ってもう一度
  // 取りに行くと、混雑した会場で待ち時間がそのまま倍になる。
  let attempts = 0;
  const worker = loadWorker({
    required: ["", "tally/"],
    respond: async (url) => {
      attempts += 1;
      if (url.endsWith("/x.js")) throw new Error("offline");
      return new Response(`body:${url}`);
    },
  });
  await worker.dispatch("install");
  const before = attempts;
  await worker.request("https://example.test/app/x.js");
  assert.equal(attempts - before, 1, "圏外の1本を二度取りに行っている");
});

test("取り出し: 記憶域が読めない端末でも素通しに落ちる（開けなくしない）", skipOnKill, async () => {
  // ここで倒れると respondWith は network error になり、回線が完全でも
  // サイトが開けない＝Service Worker が居ない方がマシ、になる。
  const worker = loadWorker({
    required: ["", "tally/"],
    storageFails: true,
    respond: async (url) => new Response(`live:${url}`),
  });
  const asset = await worker.request("https://example.test/app/x.js");
  assert.equal(await asset.text(), "live:https://example.test/app/x.js");
  const page = await worker.request("https://example.test/app/tally/", {
    mode: "navigate",
  });
  assert.equal(await page.text(), "live:https://example.test/app/tally/");
});

test("取り出し: 記憶域も回線も駄目なら受け皿を出す（黙って壊れない）", skipOnKill, async () => {
  const worker = loadWorker({
    required: ["", "tally/"],
    storageFails: true,
    respond: async () => {
      throw new Error("offline");
    },
  });
  const page = await worker.request("https://example.test/app/tally/", {
    mode: "navigate",
  });
  assert.equal(page.status, 503);
});

test("取り出し: 別オリジンと範囲外には介入しない", skipOnKill, async () => {
  const worker = loadWorker({
    required: ["", "tally/"],
    respond: async (url) => new Response(`body:${url}`),
  });
  await worker.dispatch("install");
  assert.equal(await worker.request("https://other.test/x.js"), undefined);
  assert.equal(await worker.request("https://example.test/elsewhere/"), undefined);
});

test("逃げ道: ?nosw で登録を解き、控えを捨て、以後は横取りしない", skipOnKill, async () => {
  const worker = loadWorker({
    required: ["", "tally/"],
    respond: async (url) => new Response(`body:${url}`),
  });
  await worker.dispatch("install");
  assert.ok(worker.stores.has("soneki-testgen"));

  const escaped = await worker.request("https://example.test/app/tally/?nosw", {
    mode: "navigate",
  });
  assert.equal(escaped, undefined, "逃げ道の遷移を横取りしている");
  assert.equal(worker.calls.unregister, 1, "登録を解いていない");
  assert.deepEqual(GENERATIONS(worker.stores), [], "控えを捨てていない");

  // 逃げた後は、この版は何もしない（消した控えを作り直さない）
  assert.equal(
    await worker.request("https://example.test/app/_next/static/x.js"),
    undefined,
    "離脱後も横取りしている",
  );
  assert.deepEqual(GENERATIONS(worker.stores), []);
});

test("逃げ道: 控えを消せない端末でも登録を解く", skipOnKill, async () => {
  // 逃げ道は壊れた端末でこそ効く必要がある。控えの破棄と登録の解除を1つの
  // try で括ると、記憶域を読めない端末では破棄で投げた時点で解除まで届かず、
  // この版が制御を持ったまま残る（optedOut は worker が畳まれるまでの札で、
  // 次の起動ではまた横取りが始まる）。
  const worker = loadWorker({
    required: ["", "tally/"],
    storageBroken: ["keys"],
    respond: async (url) => new Response(`body:${url}`),
  });
  await worker.request("https://example.test/app/tally/?nosw", {
    mode: "navigate",
  });
  assert.equal(worker.calls.unregister, 1, "控えを消せないと登録も解けていない");
});

test("取り出し: 控えが返らない端末でも応答を返す（Service Worker 無しより悪くしない）", stalls, async () => {
  // 控えを読む段で止まると respondWith が永久に解決せず、回線が完全でも
  // 画面が出ない。読めなければ控えを諦めて素通りする方が必ず軽い。
  const worker = loadWorker({
    required: ["", "tally/"],
    storageSilent: ["open"],
    respond: async () => new Response("<html>net</html>"),
  });
  const page = await worker.request("https://example.test/app/tally/", {
    mode: "navigate",
  });
  assert.ok(page, "控えの沈黙で応答が返らない");
  assert.equal(await page.text(), "<html>net</html>");

  const asset = await worker.request("https://example.test/app/_next/x.js");
  assert.ok(asset && asset.ok, "資産の経路でも応答が返らない");
  assert.equal(await asset.text(), "<html>net</html>");
});

test("取り出し: 世代を確かめられない回は、別置きに書かない（版ズレを作らない）", stalls, async () => {
  // 世代の照合が返らない／転ぶ端末で「控えに無い」と読むと、世代に入っている
  // URL にネットワークの応答を別置きへ貼り付け、次からそれを返す。会場の
  // 捕捉ページが 200 を返す回線では、JS の URL に HTML が入る（画面は出るのに
  // 操作が効かない＝当日いちばん困る壊れ方）。
  for (const gate of ["storageSilent", "storageBroken"]) {
    const worker = loadWorker({
      required: ["", "tally/"],
      [gate]: ["match"],
      respond: async () => new Response("<html>portal</html>"),
    });
    const res = await worker.request("https://example.test/app/_next/x.js");
    assert.ok(res, `${gate}: 応答が返らない`);
    assert.equal(await res.text(), "<html>portal</html>", `${gate}: 素通ししていない`);
    assert.equal(
      held(worker.stores, "soneki-rt-testgen"),
      0,
      `${gate}: 世代を確かめられないのに別置きへ書いている`,
    );
  }
});

test("取り出し: 裏の更新を引き延ばせなくても、控えを返す", skipOnKill, async () => {
  // ここで投げると外側の受けが取り直しに行き、控えがあるのに回線の応答
  // （会場の捕捉ページ）を返すことになる。
  let body = "v1";
  const worker = loadWorker({
    required: ["", "tally/"],
    respond: async () => new Response(body),
  });
  const first = await worker.request("https://example.test/app/x.js");
  assert.equal(await first.text(), "v1");

  body = "v2";
  worker.breakWaitUntil();
  const second = await worker.request("https://example.test/app/x.js");
  assert.equal(await second.text(), "v1", "引き延ばせないと控えを捨てている");
});

test("取り出し: 別置きを確かめられない回も、そこへ書かない", stalls, async () => {
  // 何が入っているか分からないまま上書きすると、次の取り出しでそれを返す。
  // 会場の捕捉ページが 200 を返す回線では、JS の URL に HTML が入る。
  for (const gate of ["storageSilent", "storageBroken"]) {
    const worker = loadWorker({
      required: ["", "tally/"],
      [gate]: ["match-rt"],
      respond: async () => new Response("<html>portal</html>"),
    });
    const res = await worker.request("https://example.test/app/_next/x.js");
    assert.ok(res, `${gate}: 応答が返らない`);
    assert.equal(await res.text(), "<html>portal</html>", `${gate}: 素通ししていない`);
    assert.equal(
      held(worker.stores, "soneki-rt-testgen"),
      0,
      `${gate}: 読めない別置きへ書いている`,
    );
  }
});

test("活性化: 制御の引き取りが返らなくても activate を畳む", stalls, async () => {
  // 引き取りが返らないと waitUntil が開いたままになり、worker が生かされ続ける
  // （会場では端末の電池が要る）。
  const worker = loadWorker({
    required: ["", "tally/"],
    active: { state: "activated" },
    claimSilent: true,
    respond: async (url) => new Response(`body:${url}`),
  });
  assert.equal(
    await worker.dispatch("activate"),
    null,
    "引き取りの沈黙で activate が終わらない",
  );
});

test("逃げ道: 登録の解除が返らなくても撤去を畳む", stalls, async () => {
  const worker = loadWorker({
    required: ["", "tally/"],
    unregisterSilent: true,
    respond: async (url) => new Response(`body:${url}`),
  });
  await worker.request("https://example.test/app/tally/?nosw", {
    mode: "navigate",
  });
  assert.equal(worker.calls.unregister, 1, "解除を試していない");
});

test("逃げ道: 控えの破棄が返らない端末でも登録を解く", stalls, async () => {
  // 失敗だけでなく「返らない」も塞ぐ。破棄で止まると解除まで届かず、
  // この版が制御を持ったまま残る（次の起動でまた横取りが始まる）。
  const worker = loadWorker({
    required: ["", "tally/"],
    storageSilent: ["keys"],
    respond: async (url) => new Response(`body:${url}`),
  });
  await worker.request("https://example.test/app/tally/?nosw", {
    mode: "navigate",
  });
  assert.equal(worker.calls.unregister, 1, "破棄の沈黙で登録が解けていない");
});

test("fetchInto: 非OK の応答も本文を閉じる（読まれない流れを溜めない）", skipOnKill, async () => {
  // 会場の捕捉ページが毎回 503 を返すと、install のたびに必須＋任意の数だけ
  // 未読の流れが worker に残る。
  const { res, seen } = watchedBody("<html>portal</html>", 503);
  const { fetchInto } = swHelpers({ fetch: async () => res });
  assert.equal(await fetchInto({ put: async () => {} }, "https://x/a", 50), false);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(seen.cancelled, true, "非OK の応答の本文を閉じていない");
});

test("install: 本文が期限をまたいだ任意分を、封をした世代に残さない", skipOnKill, async () => {
  // ヘッダは間に合ったのに本文が期限をまたぐ形。中断が使えない端末では
  // 取得が走り続けるので、書き終えてから取り消さないと、封をした世代に
  // 別の版のバイトが混ざりうる。
  let release;
  const late = new Promise((resolve) => {
    release = resolve;
  });
  const worker = loadWorker({
    required: ["", "tally/"],
    optional: ["terms/"],
    budgetMs: 60,
    withAbort: false,
    withStreams: false, // 本文を見張れない端末（総時間で畳む側の経路）
    respond: async (url) =>
      url.endsWith("/terms/")
        ? new Response(
            new ReadableStream({
              async start(controller) {
                await late;
                controller.enqueue(new TextEncoder().encode("late"));
                controller.close();
              },
            }),
          )
        : new Response(`body:${url}`),
  });
  const outcome = await worker.dispatch("install");
  assert.equal(outcome, null);
  const gen = worker.stores.get("soneki-testgen");
  assert.equal(gen.size, 2);

  release();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(gen.size, 2, "期限をまたいだ本文が世代に残っている");
});

test("install: 見切った任意分を、封をした世代へ後から書き込まない", skipOnKill, async () => {
  // 中断が使えない端末では取得が走り続ける。期限で見切った1本が後から
  // 世代に入ると、封をしたはずの一式に別の版のバイトが混ざりうる。
  let release;
  const late = new Promise((resolve) => {
    release = resolve;
  });
  const worker = loadWorker({
    required: ["", "tally/"],
    optional: ["terms/"],
    budgetMs: 60,
    withAbort: false,
    respond: async (url) => {
      if (!url.endsWith("/terms/")) return new Response(`body:${url}`);
      await late;
      return new Response("late-terms");
    },
  });
  const outcome = await worker.dispatch("install");
  assert.equal(outcome, null, "任意分の沈黙で install が終わらない");
  const gen = worker.stores.get("soneki-testgen");
  assert.equal(gen.size, 2);

  release();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(gen.size, 2, "見切った任意分が後から世代に入っている");
});

test("sw.js: 必須分の時間切れは1本ごとに張る（集合全体で畳まない）", skipOnKill, () => {
  // 集合全体に1つの期限を張ると、1本ずつは進んでいるのに合計が上限を越えて
  // 世代ごと捨てられる ＝「遅いだけで繋がる回線」を「控えが取れない端末」に
  // 落とす。取得と put を1本の中で同じ期限に収める。
  const body = codeOnly(SW_SRC);
  const install = body.slice(
    body.indexOf('self.addEventListener("install"'),
    body.indexOf('self.addEventListener("activate"'),
  );
  assert.ok(install.length > 0, "install を切り出せない（検査が空振り）");
  assert.ok(
    install.includes("fetchInto(cache, scoped(path), REQUIRED_TIMEOUT_MS)"),
    "必須分を1本ごとの期限で取っていない",
  );
  // install の中で直に fetch / put しない（期限の外側を作らない）
  assert.ok(!install.includes("fetch("), "install が直に fetch している");
  assert.ok(!install.includes(".put("), "install が直に put している");
});

test("sw.js: 時間切れは AbortSignal.timeout に頼らず自前で組む", skipOnKill, () => {
  // Service Worker は動くのに AbortSignal.timeout が無いブラウザが実在する。
  // 素で呼ぶと評価した瞬間に投げ、必須分の取得に入る前に install ごと reject
  // する ＝その端末はオフライン対応を丸ごと失う。
  // （呼んでいないことは上の構文・API 検査が見ている。ここは代替の中身。）
  const body = codeOnly(SW_SRC, false);
  assert.match(body, /function timeoutSignal\(ms\) \{/);
  assert.ok(body.includes("new AbortController()"), "代替の中断手段が無い");
  // 作った時間切れは必ず片付ける（片付けないとタイマーが期限まで残る）。
  const made = (body.match(/timeoutSignal\(/g) ?? []).length;
  const declared = (body.match(/function timeoutSignal\(/g) ?? []).length;
  const done = (body.match(/\.done\(\)/g) ?? []).length;
  assert.equal(declared, 1, "timeoutSignal の定義が1つでない（検査が空振り）");
  assert.ok(made - declared > 0, "利用箇所を見つけられていない（検査が空振り）");
  assert.ok(done >= made - declared, "作った数だけ done() を呼んでいない");
});

/**
 * sw.js の助け関数（timeoutSignal / atMost / fetchInto）を素の JS として取り出す。
 * Service Worker の API に触れない部分なので、Node でそのまま動かせる。
 * 差し替えたい依存（fetch など）は引数で注入する。
 */
function swHelpers(inject = {}) {
  const start = SW_SRC.indexOf("function timeoutSignal");
  const end = SW_SRC.indexOf("async function putSafe");
  assert.ok(start > 0 && end > start, "助け関数を切り出せない（検査が空振り）");
  const names = Object.keys(inject);
  const make = new Function(
    ...names,
    `${SW_SRC.slice(start, end)}; return { timeoutSignal, atMost, fetchInto };`,
  );
  return make(...names.map((n) => inject[n]));
}

/** 本文が ms 後に届く応答。signal が中断されたら本文ごと壊れる（実物と同じ）。 */
function slowBody(text, ms, signal) {
  let timer;
  const stop = () => clearTimeout(timer);
  return new Response(
    new ReadableStream({
      start(controller) {
        // 読み手（sw.js 側の見張り）が先に閉じることがある。閉じた後に
        // 触ると投げるので、どの操作も握っておく。
        const safely = (fn) => {
          try {
            fn();
          } catch {
            /* 既に閉じられている */
          }
        };
        timer = setTimeout(() => {
          safely(() => controller.enqueue(new TextEncoder().encode(text)));
          safely(() => controller.close());
        }, ms);
        if (signal) {
          signal.addEventListener("abort", () => {
            stop();
            safely(() => controller.error(new Error("aborted")));
          });
        }
      },
      cancel() {
        stop();
      },
    }),
  );
}

test("fetchInto: 取得も書き込みも同じ期限に収め、終わったらタイマーを片付ける", skipOnKill, async () => {
  // 応答ヘッダが返っても本文が来ないことはある。本文の転送は put の中で
  // 起きるので、期限が取得だけを覆っていると install は開いたままになる
  // ＝札は「そなえ中」から動かず、失敗として畳まれないので再試行もされない。
  let signal = null;
  const puts = [];
  const { fetchInto } = swHelpers({
    fetch: async (url, init) => {
      signal = init.signal;
      return new Response(`body:${url}`);
    },
  });
  const cache = {
    put: async (url, res) => {
      puts.push([url, await res.text()]);
    },
  };

  assert.equal(await fetchInto(cache, "https://x/a", 50), true);
  assert.deepEqual(puts, [["https://x/a", "body:https://x/a"]]);
  // 期限を過ぎても中断されない＝タイマーを片付けている（漏らすと、取得が
  // 早く終わっても期限まで Service Worker が生かされる）。
  await new Promise((r) => setTimeout(r, 90));
  assert.equal(signal.aborted, false, "成功しても done() を呼んでいない");
});

test("fetchInto: 非OK・失敗・本文の沈黙はいずれも false（控えを名乗らせない）", skipOnKill, async () => {
  // 非OK
  {
    const puts = [];
    const { fetchInto } = swHelpers({
      fetch: async () => new Response("", { status: 500 }),
    });
    const cache = { put: async (...a) => puts.push(a) };
    assert.equal(await fetchInto(cache, "https://x/a", 50), false);
    assert.deepEqual(puts, [], "非OK の応答を控えている");
  }
  // 取得そのものの失敗
  {
    const { fetchInto } = swHelpers({
      fetch: async () => {
        throw new Error("offline");
      },
    });
    assert.equal(
      await fetchInto({ put: async () => {} }, "https://x/a", 50),
      false,
    );
  }
  // ヘッダは返るが本文が来ない。無音が続いたら畳めることを見る。
  {
    const { fetchInto } = swHelpers({
      fetch: async (url, init) => slowBody("never", 10_000, init.signal),
    });
    const cache = {
      put: async (_url, res) => {
        await res.text();
      },
    };
    const started = Date.now();
    assert.equal(await fetchInto(cache, "https://x/a", 60), false);
    assert.ok(
      Date.now() - started < 1000,
      "本文の沈黙を畳めていない（install が開いたままになる）",
    );
  }
});

test("atMost: 裏仕事の引き延ばしを打ち切る（仕事そのものは止めない）", skipOnKill, async () => {
  // waitUntil に渡した仕事が沈黙すると、期限が無ければ Service Worker が
  // 生かされ続ける（会場では端末の電池が要る）。
  const { atMost } = swHelpers();
  let finished = false;
  const work = new Promise((resolve) =>
    setTimeout(() => {
      finished = true;
      resolve("done");
    }, 400),
  );
  // 「打ち切った」の証拠は経過時間ではなく、仕事より先に返ったこと。
  // 壁時計で見ると、負荷の高い機械で意味なく落ちる。
  await atMost(work, 30);
  assert.equal(finished, false, "引き延ばしを打ち切っていない");
  // 早く終わる仕事は待つ（打ち切りが常に先に来てはならない）
  assert.equal(await atMost(Promise.resolve("x"), 400), undefined);
  await work;
});

test("bodyWithin: 止まった本文は読み手を閉じ、タイマーを残さない", skipOnKill, async () => {
  // 止まった転送の読み手を閉じないと、諦めた本数だけ未読の流れが worker に
  // 残る（install は失敗のたびに繰り返される）。
  const start = SW_SRC.indexOf("async function bodyWithin");
  const end = SW_SRC.indexOf("/**\n * 1本を取得し");
  assert.ok(start > 0 && end > start, "bodyWithin を切り出せない（検査が空振り）");
  const bodyWithin = new Function(
    "Response",
    "setTimeout",
    "clearTimeout",
    `${SW_SRC.slice(start, end)}; return bodyWithin;`,
  )(Response, setTimeout, clearTimeout);

  let cancelled = false;
  const res = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("part"));
        // 以後は無音
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  const timersBefore = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  await assert.rejects(() => bodyWithin(res, 40));
  assert.equal(cancelled, true, "止まった本文の読み手を閉じていない");
  await new Promise((r) => setTimeout(r, 20));
  const timersAfter = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.ok(timersAfter <= timersBefore, "タイマーが残っている");
});

test("bodyWithin: 進んでいる本文は最後まで読み、内容を保つ", skipOnKill, async () => {
  const start = SW_SRC.indexOf("async function bodyWithin");
  const end = SW_SRC.indexOf("/**\n * 1本を取得し");
  const bodyWithin = new Function(
    "Response",
    "setTimeout",
    "clearTimeout",
    `${SW_SRC.slice(start, end)}; return bodyWithin;`,
  )(Response, setTimeout, clearTimeout);

  const res = new Response(
    new ReadableStream({
      start(controller) {
        let n = 0;
        const step = () => {
          if (n === 3) {
            controller.close();
            return;
          }
          controller.enqueue(new TextEncoder().encode(`p${n}`));
          n += 1;
          setTimeout(step, 20);
        };
        setTimeout(step, 20);
      },
    }),
    { status: 200, statusText: "OK", headers: { "content-type": "text/plain" } },
  );
  const out = await bodyWithin(res, 80);
  assert.equal(await out.text(), "p0p1p2", "本文を取りこぼしている");
  assert.equal(out.status, 200);
  assert.equal(out.headers.get("content-type"), "text/plain");
});

test("assetKey: RSC ペイロードだけクエリを落とす（他のキャッシュ破りは殺さない）", skipOnKill, () => {
  const start = SW_SRC.indexOf("function assetKey");
  const end = SW_SRC.indexOf('self.addEventListener("install"');
  assert.ok(start > 0 && end > start, "assetKey を切り出せない（検査が空振り）");
  const assetKey = new Function(
    "URL",
    `${SW_SRC.slice(start, end)}; return assetKey;`,
  )(URL);

  // 遷移のたびに違う ?_rsc= で同じ実体が積み上がると、照合（ignoreSearch）は
  // 最初の1つに当たり続けるので増えた分は死蔵になる。
  assert.equal(
    assetKey({ url: "https://x/app/tally/index.txt?_rsc=ab12" }),
    "https://x/app/tally/index.txt",
  );
  // 逆に資産のクエリまで落とすと、キャッシュ破りが効かなくなる。
  assert.equal(
    assetKey({ url: "https://x/app/_next/static/chunk.js?v=2" }),
    "https://x/app/_next/static/chunk.js?v=2",
  );
});

test("timeoutSignal: 期限は効き、done() でタイマーを片付ける", skipOnKill, async () => {
  // 正規表現だけでは「時間切れが実際に効くか」「done() が本当にタイマーを
  // 消すか」は分からない。sw.js から関数だけ取り出して素の JS として動かす
  // （Service Worker の API に触れない純粋な関数なので Node で走る）。
  const start = SW_SRC.indexOf("function timeoutSignal");
  const end = SW_SRC.indexOf("async function putSafe");
  assert.ok(start > 0 && end > start, "timeoutSignal を切り出せない（検査が空振り）");
  const timeoutSignal = new Function(
    `${SW_SRC.slice(start, end)}; return timeoutSignal;`,
  )();

  const kept = timeoutSignal(20);
  assert.equal(kept.signal.aborted, false, "作った直後に中断している");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(kept.signal.aborted, true, "期限を過ぎても中断しない");
  kept.done();

  // 取得が早く終わった場合。done() 後にタイマーが生き残っていると、
  // Service Worker が期限まで無駄に生かされる。
  const finished = timeoutSignal(20);
  finished.done();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(finished.signal.aborted, false, "done() 後もタイマーが残っている");
});

test("sw.js: 下限より新しい構文・API に依存しない（1箇所で控えごと失う）", () => {
  // sw.js と sw-kill.js は素のまま配信される（Next のトランスパイルを通らない）。
  // 解せない構文が1箇所でもあれば、ファイル全体が読めず、その端末は控えを
  // 一切持てない。API 側も同じで、評価した瞬間に投げるものは install を丸ごと
  // 落とす。
  //
  // 下限は ES2019（この2ファイルは既に `catch {}`＝省略可能な catch 束縛と
  // オブジェクト展開を使っており、そこが実際の底になっている）。
  // したがって禁じるのは **ES2020 以降** のもの。
  const banned = [
    ["??", "null 合体"],
    ["?.", "省略可能な連鎖"],
    ["||=", "論理代入"],
    ["&&=", "論理代入"],
    ["??=", "論理代入"],
    ["globalThis", "globalThis"],
    ["Promise.allSettled", "Promise.allSettled"],
    ["Promise.any", "Promise.any"],
    ["AbortSignal.timeout", "AbortSignal.timeout"],
    ["AbortSignal.any", "AbortSignal.any"],
    ["structuredClone", "structuredClone"],
    ["Object.fromEntries", "Object.fromEntries"],
    [".replaceAll(", "String.replaceAll"],
    [".flat(", "Array.flat"],
    [".flatMap(", "Array.flatMap"],
    [".at(", "Array.at"],
    [".findLast(", "Array.findLast"],
    ["Object.hasOwn", "Object.hasOwn"],
    ["BigInt", "BigInt"],
  ];
  // 数値の区切り（`30_000`）は ES2021。部分一致では拾えないので式で見る。
  const separated = /\b\d[\d_]*_\d/;
  for (const [name, src] of [
    ["sw.js", SW_SRC],
    [
      "sw-kill.js",
      readFileSync(new URL("../scripts/sw-kill.js", import.meta.url), "utf8"),
    ],
  ]) {
    const body = codeOnly(src, false);
    // 走査が空振りしていないこと（注釈だけ消して中身が残っている）
    assert.ok(body.includes("addEventListener"), `${name} の走査が空振り`);
    // 走査が途中でずれると、以降の検査は「消えた行」を見て素通しする。
    // 構文として読めることを確かめて、ずれを黙らせない。
    assert.doesNotThrow(
      () => new Function(body),
      `${name} の走査結果が構文として読めない（走査がずれている）`,
    );
    for (const [token, label] of banned) {
      assert.ok(!body.includes(token), `${name} が ${label} を使っている`);
    }
    assert.ok(!separated.test(body), `${name} が数値の区切りを使っている`);
  }
});

test("sw.js: 控えの鍵は RSC ペイロードのクエリを落とす（死蔵を積み上げない）", skipOnKill, () => {
  // 照合は ignoreSearch で当たるので、?_rsc 付きのまま書くと同じ実体が
  // 遷移のたびに別の鍵で積み上がり、増えた分は二度と読まれない。
  assert.match(SW_SRC, /function assetKey\(request\)/);
  assert.ok(SW_SRC.includes('url.pathname.endsWith("/index.txt")'));
});

test("removeSonae: 解除するのは自分の scope の登録だけ", () => {
  // getRegistrations() はオリジン全体を返す。無条件に解除すると、同じオリジンに
  // 同居する別の公開物の Service Worker まで巻き添えで落とす。
  const src = readFileSync(
    new URL("../app/tally/useSonae.ts", import.meta.url),
    "utf8",
  );
  const body = src.slice(
    src.indexOf("async function removeSonae"),
    src.indexOf("export function registerSonae"),
  );
  assert.ok(body.length > 0, "removeSonae を見つけられていない（検査が空振り）");
  assert.ok(
    /r\.scope === scope/.test(body),
    "オリジン全体の登録を解除している",
  );
});

test("useSonae: 画面に戻ったら控えを測り直す（消えた控えを名乗り続けない）", () => {
  // 控えは別のタブ（?nosw）や記憶域の追い出しで消える。消えたことは
  // どのイベントでも届かないので、測り直さない限り札は「そなえ済」のまま。
  const src = readFileSync(
    new URL("../app/tally/useSonae.ts", import.meta.url),
    "utf8",
  );
  const onVisible = src.slice(
    src.indexOf("const onVisible"),
    src.indexOf('document.addEventListener("visibilitychange"'),
  );
  assert.ok(onVisible.length > 0, "測り直しを見つけられない（検査が空振り）");
  assert.match(onVisible, /visibilityState === "visible"/, "見えた側で測っていない");
  assert.match(onVisible, /sync\(\)/, "測り直していない（観測だけ張っている）");
  assert.ok(
    src.includes('document.removeEventListener("visibilitychange", onVisible)'),
    "測り直しの観測を外していない（画面を離れても残る）",
  );
  // 閉じた知らせは、測り直しても出し直さない（記憶域を止めた端末では
  // 既読の印を書けず、タブを行き来するたびカウンターを覆う）。
  assert.match(
    src,
    /!dismissed\.current/,
    "閉じた知らせが測り直しのたびに出直す",
  );
  assert.match(src, /dismissed\.current = true/, "閉じたことを覚えていない");
  // 控えが消えた回は知らせも下げる（実体の無い約束を画面に残さない）。
  assert.match(
    src,
    /if \(next !== "ari"\) setShowObi\(false\);/,
    "控えが消えても知らせを出したままにしている",
  );
});

test("useSonae: Cache Storage が無い環境でも状態の確定が投げない", () => {
  // 素で `caches` を触ると sync ごと投げ、札は最初の「そなえ中」のまま
  // 二度と動かない（controllerchange も来ないので回復もしない）。
  const src = readFileSync(
    new URL("../app/tally/useSonae.ts", import.meta.url),
    "utf8",
  );
  const sync = src.slice(
    src.indexOf("const sync = async"),
    src.indexOf("let unwatch"),
  );
  assert.ok(sync.length > 0, "sync を見つけられていない（検査が空振り）");
  // 「有無を確かめている」だけでは足りない。裏返した版（無いときだけ実測し、
  // 有る端末では常に控え無しと言う）も同じ文字列を含むので、対応まで見る。
  assert.match(
    sync,
    /typeof caches === "undefined"\s*\?\s*false\s*:\s*await hasSonaeGeneration\(/,
    "Cache Storage が無い側と有る側の扱いが逆・または素で触っている",
  );
});

test("stamp-sw.mjs: 世代名に Service Worker 自身を含める", () => {
  // 含めないと、sw.js だけを直した配信で世代名が据え置かれ、install 中の版が
  // 現に動いている版の控えを開く。put が1つ失敗すれば caches.delete(CACHE) で、
  // 取り直しに失敗した端末が完全な控えごと失う。
  const src = readFileSync(
    new URL("../scripts/stamp-sw.mjs", import.meta.url),
    "utf8",
  );
  const digest = src.indexOf('createHash("sha256")');
  const worker = src.indexOf("digest.update(src)");
  const files = src.indexOf("for (const p of precache) {", digest);
  assert.ok(digest > 0 && worker > 0 && files > 0, "検査が空振り");
  assert.ok(worker > digest, "sw を混ぜるのが digest の作成より前");
  assert.ok(worker < files, "sw を混ぜるのが控えの走査より後");
});

/** 観測を動かすための最小の偽物（状態を持ち、遷移を通知するだけ）。 */
class FakeWorker extends EventTarget {
  constructor(state = "installing") {
    super();
    this.state = state;
    /** 張られている観測の数（外し忘れると版の数だけ積み上がる）。 */
    this.watchers = 0;
  }
  addEventListener(...args) {
    this.watchers += 1;
    super.addEventListener(...args);
  }
  removeEventListener(...args) {
    this.watchers -= 1;
    super.removeEventListener(...args);
  }
  to(state) {
    this.state = state;
    this.dispatchEvent(new Event("statechange"));
  }
}

class FakeReg extends EventTarget {
  constructor({ installing = null, waiting = null, active = null } = {}) {
    super();
    this.installing = installing;
    this.waiting = waiting;
    this.active = active;
  }
  /** 新しい版が載った（別の呼び出しが始めた install も含む）。 */
  found(worker) {
    this.installing = worker;
    this.dispatchEvent(new Event("updatefound"));
  }
}

const APPEAR = 20;
// 活性化を待つ猶予。期限そのものを試す検査は、この値ではなく短い値を
// 引数で渡す（この値は「決着が先に来る」検査が期限に当たらないための余白）。
const ACTIVATE = 400;
const settleGap = () => new Promise((r) => setTimeout(r, APPEAR * 3));

test("watchSonaeInstall: 初回インストールの失敗を見届ける（そなえ中で止めない）", async () => {
  // register() は登録できた時点で解決する。その後 precache が欠けて版が
  // redundant になっても controllerchange は来ないので、見ないと札が
  // 「そなえ中」のまま止まり「開いたまま待て」と言い続ける。
  const worker = new FakeWorker();
  const reg = new FakeReg({ installing: worker });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);
  assert.deepEqual(verdicts, [], "install 中に結論を出している");

  reg.installing = null;
  worker.to("redundant");
  await settleGap();
  assert.deepEqual(verdicts, [true], "初回インストールの失敗を報せていない");
});

test("watchSonaeInstall: 畳まれた版がまだ登録に載っていても結論を出す", async () => {
  // install の失敗では、版が redundant になる時点と `reg.installing` が null に
  // なる時点が別々に届く。redundant の版を「install 中」と読むと、その版を
  // また観測して また畳まれたと読む往復が閉じず、結論が出ないまま札が
  // 「そなえ中（開いたまま）」で止まる。
  const worker = new FakeWorker();
  const reg = new FakeReg({ installing: worker });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);
  worker.to("redundant"); // reg.installing はまだこの版を指したまま
  await settleGap();
  assert.deepEqual(verdicts, [true]);
});

test("watchSonaeInstall: 観測を張る時点で既に畳まれていても結論を出す", async () => {
  // 先に始まった呼び出しの install が、ここへ来る前に redundant まで進み、
  // かつ登録にまだ載っている状態。張った瞬間に往復へ落ちてはならない。
  const worker = new FakeWorker("redundant");
  const reg = new FakeReg({ installing: worker });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);
  await settleGap();
  assert.deepEqual(verdicts, [true]);
});

test("watchSonaeInstall: 活きている版があるなら失敗と言わない", async () => {
  // 畳まれたのは更新の試行だけ。控え（前の世代）はそのまま使える。
  const worker = new FakeWorker();
  const reg = new FakeReg({ installing: worker, active: new FakeWorker("activated") });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);
  reg.installing = null;
  worker.to("redundant");
  await settleGap();
  assert.deepEqual(verdicts, [false]);
});

test("watchSonaeInstall: 観測を張る前に決着していた失敗も拾う", async () => {
  // 登録は全ページで走らせているので、先に始まった呼び出しの install が
  // ここへ来る前に redundant まで進みうる。そのとき installing は既に null。
  // 「null＝順調」と読むと、初回インストールの失敗を1件も報せられない。
  const reg = new FakeReg();
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);
  await settleGap();
  assert.deepEqual(verdicts, [true]);
});

test("watchSonaeInstall: 版が載る前の一瞬を失敗と決めつけない", async () => {
  // register() の解決が install の開始より前に来ることがある。その一瞬で
  // 即断すると、正常な初回訪問を「そなえ不可」にしてしまう。
  const reg = new FakeReg();
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);
  const worker = new FakeWorker();
  reg.found(worker);
  assert.deepEqual(verdicts, [], "版が現れたのに失敗と決めている");
  worker.to("installed");
  worker.to("activated");
  await settleGap();
  assert.deepEqual(verdicts, [false]);
});

test("watchSonaeInstall: 活きた版があるなら待機中の版で即座に「失敗ではない」", async () => {
  // 更新の試行。控え（前の世代）は活きた版が持っているので、この版の行方は
  // 札を左右しない（待機のまま何日も置かれても「そなえ済」のままでよい）。
  const reg = new FakeReg({
    waiting: new FakeWorker("installed"),
    active: new FakeWorker("activated"),
  });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);
  assert.deepEqual(verdicts, [false]);
});

test("watchSonaeInstall: 初回インストールは activate まで見届ける", async () => {
  // 制御が付くのは活性化してから。installed で「失敗ではない」と閉じて観測を
  // 外すと、その前に畳まれても（別のタブが解除した・新しい版に追い越された）
  // 誰も気づけない。controllerchange も来ないので、札は
  // 「そなえ中（開いたまま）」で永久に止まる。
  const worker = new FakeWorker();
  const reg = new FakeReg({ installing: worker });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);

  worker.to("installed");
  reg.installing = null;
  reg.waiting = worker;
  assert.deepEqual(verdicts, [], "installed で結論を出している");

  reg.waiting = null;
  reg.active = worker;
  worker.to("activated");
  await settleGap();
  assert.deepEqual(verdicts, [false]);
  assert.equal(worker.watchers, 0, "決着した版の観測を外していない");
});

test("watchSonaeInstall: install を終えた版が畳まれたら報せる", async () => {
  // 活性化の前に畳まれる（別のタブが解除した・新しい版に追い越された）ことが
  // ある。ここを見ていないと controllerchange も来ないまま、札は
  // 「開いたまま待て」と言い続ける（待っても変わらない）。
  const worker = new FakeWorker();
  const reg = new FakeReg({ installing: worker });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);

  worker.to("installed");
  reg.installing = null;
  reg.waiting = worker;
  assert.deepEqual(verdicts, []);

  reg.waiting = null;
  worker.to("redundant");
  await settleGap();
  assert.deepEqual(verdicts, [true], "活性化の前に畳まれた版を見落としている");
  assert.equal(worker.watchers, 0, "畳まれた版の観測を外していない");
});

test("watchSonaeInstall: 張った時点で待機中の版だけでも活性化を見届ける", async () => {
  // register() の解決が install の完了より遅いと、観測を張る時点で
  // installing は既に null・waiting だけが居る。活きた版が無いこの登録で
  // 「有り」と読んで閉じると、活性化まで進まない版を誰も見なくなる。
  const worker = new FakeWorker("installed");
  const reg = new FakeReg({ waiting: worker });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);
  assert.deepEqual(verdicts, [], "待機中の版で即断している");

  reg.waiting = null;
  worker.to("redundant");
  await settleGap();
  assert.deepEqual(verdicts, [true]);
});

test("watchSonaeInstall: 活性化が来なければ期限で畳む", async () => {
  // activate が返らない端末（記憶域が沈黙する等）では、版は activating の
  // まま止まり、制御も controllerchange も来ない。上限が無いと札は
  // 「そなえ中（開いたまま）」で永久に止まり、利用者は取れない控えを待ち続ける。
  const worker = new FakeWorker();
  const reg = new FakeReg({ installing: worker });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, APPEAR);
  worker.to("installed");
  reg.installing = null;
  reg.waiting = worker;
  assert.deepEqual(verdicts, [], "installed で即断している");
  // 活性化へ進み、そこで返らなくなる（枠は waiting から active へ移る）。
  reg.waiting = null;
  reg.active = worker;
  worker.to("activating");
  await settleGap();
  assert.deepEqual(verdicts, [true], "活性化を無期限に待っている");
});

test("watchSonaeInstall: 更新の版は installed で即座に「失敗ではない」", async () => {
  // 活きた版が別にある＝控え（前の世代）は持っている。待機のまま置かれても
  // 札は「そなえ済」のままでよく、活性化の期限に掛けてはならない。
  const worker = new FakeWorker();
  const reg = new FakeReg({ installing: worker, active: new FakeWorker("activated") });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, APPEAR);
  worker.to("installed");
  assert.deepEqual(verdicts, [false], "更新の版を初回インストールと読んでいる");
  await settleGap();
  assert.deepEqual(verdicts, [false], "期限で言い直している");
});

test("watchSonaeInstall: 活性化の途中の版で「失敗ではない」と閉じない", async () => {
  // 制御を引き取れるのは活性化まで進んだ版だけ。activating を「活きた版」と
  // 読んで閉じると、活性化が返らない端末で観測も期限も無くなり、札が
  // 「そなえ中（開いたまま）」から二度と動かない。
  const worker = new FakeWorker("activating");
  const reg = new FakeReg({ active: worker });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);
  assert.deepEqual(verdicts, [], "活性化の途中で結論を出している");

  worker.to("activated");
  assert.deepEqual(verdicts, [false]);
});

test("watchSonaeInstall: 活性化の途中の版が居るなら、待機の版で閉じない", async () => {
  // 制御を握るのは活性の版。まだ活性化の途中なら、待機の版を「更新の試行」と
  // 読んで閉じてはならない（閉じると、活性化まで進まない版に誰も気づけない）。
  const active = new FakeWorker("activating");
  const worker = new FakeWorker();
  const reg = new FakeReg({ installing: worker, active });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);
  worker.to("installed");
  assert.deepEqual(verdicts, [], "活性化の途中の版を「活きた版」と読んでいる");

  // 見る先は活性の版に移っている。そちらが決着すれば札も決まる。
  active.to("activated");
  assert.deepEqual(verdicts, [false]);
});

test("watchSonaeInstall: 活性化が返らない版は期限で畳む（張った時点が活性化中でも）", async () => {
  const worker = new FakeWorker("activating");
  const reg = new FakeReg({ active: worker });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, APPEAR);
  await settleGap();
  assert.deepEqual(verdicts, [true], "活性化を無期限に待っている");
});

test("watchSonaeInstall: 解除で畳まれた活性版を「居る」と読まない", async () => {
  // 別のタブが `?nosw` で解除すると、版が redundant になる時点と登録の枠が
  // 空になる時点が別々に届く。畳まれた版を「活きた版が居る」と読むと、
  // 初回インストールの失敗を「更新の試行が畳まれただけ」と誤認する。
  const dead = new FakeWorker("redundant");
  const worker = new FakeWorker();
  const reg = new FakeReg({ installing: worker, active: dead });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);
  worker.to("installed");
  assert.deepEqual(verdicts, [], "畳まれた版を活きた版と読んでいる");

  reg.installing = null;
  worker.to("redundant");
  await settleGap();
  assert.deepEqual(verdicts, [true]);
});

test("watchSonaeInstall: 畳まれた版が待機の枠に残っていても結論を出す", async () => {
  // installing 側と同じ規則を waiting にも当てる。当てないと、畳まれた版を
  // 観測しては畳まれたと読む往復が閉じず、結論が出ないまま札が止まる。
  const worker = new FakeWorker("redundant");
  const reg = new FakeReg({ waiting: worker });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);
  await settleGap();
  assert.deepEqual(verdicts, [true]);
});

test("watchSonaeInstall: 期限のあとで活性化したら言い直す", async () => {
  // 期限で観測を外すと、遅れて活性化した版を誰も見なくなり、控えが実在する
  // のに札が「そなえ不可（要電波）」で固まる。周回は開けたままにする。
  const worker = new FakeWorker();
  const reg = new FakeReg({ installing: worker });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, APPEAR);
  worker.to("installed");
  reg.installing = null;
  reg.waiting = worker;
  await settleGap();
  assert.deepEqual(verdicts, [true], "期限で畳んでいない");

  reg.waiting = null;
  reg.active = worker;
  worker.to("activated");
  assert.deepEqual(
    verdicts,
    [true, false],
    "遅れて活性化した版を言い直していない",
  );
});

test("watchSonaeInstall: activating へ動いても期限を張り直さない", async () => {
  // 遷移のたびに張り直すと上限が伸び続け、期限が事実上消える。
  const worker = new FakeWorker();
  const reg = new FakeReg({ installing: worker });
  const verdicts = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, 200);
  worker.to("installed"); // ここから 200ms
  reg.installing = null;
  reg.active = worker;
  await sleep(120);
  worker.to("activating"); // 張り直すと期限が 320ms 先へ延びる
  await sleep(120); // 期限（200ms）は過ぎ、張り直した先（320ms）には届かない
  assert.deepEqual(verdicts, [true], "遷移のたびに期限が伸びている");
});

test("watchSonaeInstall: 活性化の期限は版ごとに張り直す", async () => {
  // 前の版に張った期限を持ち越すと、正常に install 中の新しい版を
  // 古い期限が「そなえ不可」にする。
  const first = new FakeWorker();
  const reg = new FakeReg({ installing: first });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, APPEAR * 2);
  first.to("installed");

  const second = new FakeWorker();
  reg.found(second); // 新しい配信が install を始めた
  await settleGap();
  assert.deepEqual(verdicts, [], "前の版の期限が新しい版を畳んでいる");
});

test("watchSonaeInstall: 結論は周回ごとに1回・新しい版で観測をやり直す", async () => {
  // 一度きりにすると、後から入った版の成否が札に出ない（古い結論で固まる）。
  const reg = new FakeReg();
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);
  await settleGap();
  assert.deepEqual(verdicts, [true], "版が1つも無い状態を確定できていない");

  const worker = new FakeWorker();
  reg.found(worker);
  worker.to("installed");
  worker.to("activated"); // 同じ周回で二度報せない
  await settleGap();
  assert.deepEqual(verdicts, [true, false]);
});

test("watchSonaeInstall: 畳まれた古い版が新しい版の結論を横取りしない", async () => {
  // 前の版の観測を外さないと、正常に install 中の新しい版が居るのに
  // 「そなえ不可（要電波）」と言い切ってしまう。
  const first = new FakeWorker();
  const reg = new FakeReg({ installing: first });
  const verdicts = [];
  watchSonaeInstall(reg, (failed) => verdicts.push(failed), APPEAR, ACTIVATE);

  const second = new FakeWorker();
  reg.found(second); // 配信が入れ替わり、新しい版が install を始めた
  first.to("redundant"); // 追い越された古い版が畳まれる
  await settleGap();
  assert.deepEqual(verdicts, [], "古い版が結論を出している");

  assert.equal(first.watchers, 0, "前の版の観測を外していない");

  second.to("installed");
  second.to("activated"); // 活きた版が無いので、活性化まで見届けて確定する
  await settleGap();
  assert.deepEqual(verdicts, [false]);
  // 結論が出た版も見続けない（更新のたびに観測が積み上がる）。
  assert.equal(second.watchers, 0, "結論の出た版の観測を外していない");
});

test("watchSonaeInstall: 止めたら以後は何も報せない（消えた画面を触らない）", async () => {
  const worker = new FakeWorker();
  const reg = new FakeReg({ installing: worker });
  const verdicts = [];
  const stop = watchSonaeInstall(
    reg,
    (failed) => verdicts.push(failed),
    APPEAR,
    ACTIVATE,
  );
  stop();
  reg.installing = null;
  worker.to("redundant");
  reg.found(new FakeWorker());
  await settleGap();
  assert.deepEqual(verdicts, []);
});

test("useSonae: 観測は lib の watchSonaeInstall に委ねる（同じ判断を2度書かない）", () => {
  const src = readFileSync(
    new URL("../app/tally/useSonae.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /watchSonaeInstall\(reg,/);
  assert.ok(
    !src.includes('"statechange"'),
    "観測の写しが useSonae に残っている",
  );
});

/** `response.body` を持たない実装を模す（本文は text() でだけ読める）。 */
function hideBody(res) {
  return {
    ok: res.ok,
    status: res.status,
    statusText: res.statusText,
    headers: res.headers,
    body: undefined,
    text: () => res.text(),
  };
}

/** 名前つきのキャッシュを持つだけの CacheStorage。open は生やさない。 */
function fakeCacheStorage(contents, { failing = false, silent = false } = {}) {
  return {
    opened: [],
    async keys() {
      if (silent) await new Promise(() => {});
      if (failing) throw new Error("storage unavailable");
      return Object.keys(contents);
    },
    async match(url, options) {
      if (silent) await new Promise(() => {});
      if (failing) throw new Error("storage unavailable");
      const names = options && options.cacheName ? [options.cacheName] : Object.keys(contents);
      for (const n of names) {
        const held = contents[n];
        if (held && held.includes(url)) return new Response("hit");
      }
      return undefined;
    },
  };
}

test("hasSonaeGeneration: 返らない記憶域は期限で「控え無し」に畳む", stalls, async () => {
  // ここで止まると状態の確定そのものが返らず、札は最初の「そなえ中
  // （開いたまま）」から二度と動かない（install の失敗も、制御が付いたことも
  // 画面に出せなくなる）。無いのに有ると言うより、有るのに無いと言う方が
  // 当日の事故が小さいので、畳む先は「控え無し」。
  const shell = "https://x/app/tally/";
  assert.equal(
    await hasSonaeGeneration(fakeCacheStorage({}, { silent: true }), shell, 20),
    false,
  );
});

test("hasSonaeGeneration: 別置きの控えを「世代あり」と読まない", async () => {
  const shell = "https://x/app/tally/";
  // 世代にある＝一式ある
  assert.equal(
    await hasSonaeGeneration(fakeCacheStorage({ "soneki-abc": [shell] }), shell),
    true,
  );
  // 別置きにしか無い＝世代は無い。ここで true を返すと、札が
  // 「そなえ済（電波がなくても開けます）」になり当日その場で裏切る。
  assert.equal(
    await hasSonaeGeneration(
      fakeCacheStorage({ "soneki-rt-abc": [shell] }),
      shell,
    ),
    false,
  );
  // 別の公開物のキャッシュも数えない
  assert.equal(
    await hasSonaeGeneration(fakeCacheStorage({ other: [shell] }), shell),
    false,
  );
  // 世代（空）と別置き（控えあり）が同居する形。名前で絞らずに探すと
  // 別置きの1枚を「世代あり」と読んでしまう。実際に起こりうる形なので、
  // ここが本命の検査になる。
  assert.equal(
    await hasSonaeGeneration(
      fakeCacheStorage({ "soneki-abc": [], "soneki-rt-abc": [shell] }),
      shell,
    ),
    false,
  );
  // 読めない環境は「控え無し」に倒す（有ると言って当日裏切らない）
  assert.equal(
    await hasSonaeGeneration(fakeCacheStorage({}, { failing: true }), shell),
    false,
  );
});

test("hasSonaeGeneration: 読むだけで控えを作らない", async () => {
  // caches.open() は**無ければ作る**。読むだけのつもりで、いま消された
  // ばかりの控えを作り直してしまう（sw.js 側が `?nosw` で踏んだのと同じ罠）。
  const store = fakeCacheStorage({ "soneki-abc": [] });
  let opened = 0;
  store.open = async () => {
    opened += 1;
    return { match: async () => undefined };
  };
  await hasSonaeGeneration(store, "https://x/app/tally/");
  assert.equal(opened, 0, "読み取りで caches.open を呼んでいる");
});

test("useSonae: 実在の確認は lib に委ね、追い越された観測を捨てる", () => {
  // sync は非同期なので、先に始まった観測が古い実測値で後から上書きすると
  // 揃っている端末の札が「そなえ中」に戻る。
  const src = readFileSync(
    new URL("../app/tally/useSonae.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /hasSonaeGeneration\(/);
  assert.ok(
    !/caches\.(open|match|keys)\(/.test(codeOnly(src).replace(/removeSonae[\s\S]*?\n}/, "")),
    "実在の確認を useSonae で組み直している",
  );
  assert.match(src, /const mine = \+\+seq;/);
  assert.match(src, /mine !== seq/);
});

test("useSonae: 制御が付いたら過去の失敗判定を捨てる（そなえ不可で固めない）", () => {
  // controllerchange は「版が活きた」の合図。前に確定させた失敗を残すと、
  // 控えが実在するのに札が「そなえ不可（要電波）」のまま固まる。
  const src = readFileSync(
    new URL("../app/tally/useSonae.ts", import.meta.url),
    "utf8",
  );
  const onChange = src.slice(
    src.indexOf("const onChange"),
    src.indexOf('addEventListener("controllerchange"'),
  );
  assert.ok(onChange.length > 0, "onChange を見つけられていない（検査が空振り）");
  assert.match(onChange, /failed = false;/);
});

test("registerSonae: register() の同期例外で画面ごと倒れない", () => {
  // レイアウト（SonaeRegister）からも呼ばれる。投げると控えが取れないどころか
  // ページが出なくなるので、同期に投げる実装も受け止める。
  const src = readFileSync(
    new URL("../app/tally/useSonae.ts", import.meta.url),
    "utf8",
  );
  const body = src.slice(src.indexOf("export function registerSonae"));
  const guard = body.indexOf("try {");
  const register = body.indexOf(".register(");
  assert.ok(guard > 0 && register > 0, "検査が空振り");
  assert.ok(guard < register, "register() が try の外にある");
});

test("readSonaeWorkers: installing が無いことを「順調」と読まない", () => {
  assert.equal(
    readSonaeWorkers({ installing: true, waiting: false, active: false }),
    "matsu",
  );
  // 待機中／活性の版が居るなら、畳まれたのは更新の試行だけ（控えは使える）
  assert.equal(
    readSonaeWorkers({ installing: false, waiting: true, active: false }),
    "ari",
  );
  assert.equal(
    readSonaeWorkers({ installing: false, waiting: false, active: true }),
    "ari",
  );
  // 版が1つも無い＝redundant で畳まれた後。ここを「順調」と読むと
  // controllerchange も来ないまま札が「そなえ中」で永久に止まる。
  assert.equal(
    readSonaeWorkers({ installing: false, waiting: false, active: false }),
    "nashi",
  );
});

test("kill switch: ページ側の登録も止められる（再読み込みのループにしない）", () => {
  // 取り消し版は制御下のページを開き直させる。開き直した先がまた登録すると
  // 取り消し版が入り直し、解除と再読み込みを繰り返して素のサイトへ戻れない。
  // 差し替えと対で、ページ側の登録を止める札が要る。
  const config = readFileSync(
    new URL("../app/config.ts", import.meta.url),
    "utf8",
  );
  // 値そのものを true に固定しない。固定すると、README の手順どおりに
  // 取り消し版を配った瞬間に CI が赤くなる＝回復が要る場面で手が止まる。
  // 見るのは「差し替えとページ側の停止が対になっているか」。
  assert.match(config, /export const SONAE_ENABLED: boolean = (true|false);/);
  const stopped = /export const SONAE_ENABLED: boolean = false;/.test(config);
  assert.equal(
    stopped,
    SW_IS_KILL,
    SW_IS_KILL
      ? "取り消し版を配っているのにページ側の登録を止めていない（再読み込みの無限ループ）"
      : "ページ側の登録だけ止まっている（控えは配られたまま）",
  );

  const src = readFileSync(
    new URL("../app/tally/useSonae.ts", import.meta.url),
    "utf8",
  );
  const body = src.slice(src.indexOf("export function registerSonae"));
  const gate = body.indexOf("SONAE_ENABLED");
  const register = body.indexOf(".register(");
  assert.ok(gate > 0 && register > 0, "札と登録を見つけられていない（検査が空振り）");
  assert.ok(gate < register, "札を見る前に登録している");

  // 手順が片方だけにならないよう、両方を README に書いてある
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const kill = readme.slice(readme.indexOf("### 控えが壊れたときの止め方"));
  assert.ok(kill.includes("sw-kill.js"), "差し替えの手順が無い");
  assert.ok(kill.includes("SONAE_ENABLED"), "ページ側を止める手順が無い");
});
