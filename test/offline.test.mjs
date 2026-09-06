// doujin-soneki — オフライン（当日そなえ）ロジックの単体テスト。
// 実行: pnpm test（Node が .ts を型ストリップして読み込む）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  nextOptOut,
  sonaeFuda,
  tallyShellUrl,
  SHELL_PATHS,
} from "../lib/offline.ts";

const SW_SRC = readFileSync(new URL("../public/sw.js", import.meta.url), "utf8");


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

test("sw.js: 逃げ道（?nosw）と別オリジン不介入を持っている", () => {
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

test("shouldRegisterSonae: ?nosw では登録しない・?sw で復帰する", () => {
  assert.equal(shouldRegisterSonae({ search: "", optedOut: false }), true);
  assert.equal(shouldRegisterSonae({ search: "?nosw", optedOut: false }), false);
  // 離脱は端末に残るので、印が付いていれば素の URL でも登録しない
  assert.equal(shouldRegisterSonae({ search: "", optedOut: true }), false);
  // 明示的な復帰は印より強い
  assert.equal(shouldRegisterSonae({ search: "?sw", optedOut: true }), true);
});

test("nextOptOut: ?nosw で印を付け、?sw で外す", () => {
  assert.equal(nextOptOut("?nosw", false), true);
  assert.equal(nextOptOut("", true), true, "印は次の訪問にも残る");
  assert.equal(nextOptOut("?sw", true), false);
  assert.equal(nextOptOut("?utm_source=x", false), false);
});

// --- 世代キャッシュの不変条件 --------------------------------------------

test("sw.js: 焼き込まれていない版は install で落とす（黙って劣化モードで動かない）", () => {
  assert.match(SW_SRC, /BUILD === "__BUILD__" \|\| REQUIRED\.length === 0/);
  assert.match(SW_SRC, /throw new Error\("sw is not stamped"\)/);
});

test("sw.js: 世代の控えを書くのは install だけ（navigate の書き戻しを持たない）", () => {
  const nf = SW_SRC.slice(SW_SRC.indexOf("async function networkFirstWithFallback"));
  const body = nf.slice(0, nf.indexOf("\nself.addEventListener"));
  assert.ok(
    !body.includes("putSafe("),
    "navigate 経路が世代キャッシュに書き戻すと、HTML だけ新世代・資産は旧世代の版ズレを作れてしまう",
  );
});

test("sw.js: オフラインの受け皿の出口は scope 基準の絶対パス", () => {
  assert.ok(
    !SW_SRC.includes('href="./tally/"'),
    "相対リンクは /terms/ や未知パスから開いたときに解決先が外れる",
  );
  assert.match(SW_SRC, /new URL\(shell, self\.registration\.scope\)\.pathname/);
  assert.match(
    SW_SRC,
    /REQUIRED\.find\(/,
    "行き先は焼き込まれた必須一覧から引く（sw.js に手書きの一覧を作らない）",
  );
});

test("sw.js: RSC ペイロードはクエリを無視して照合する（?_rsc で永久に外さない）", () => {
  assert.match(SW_SRC, /index\.txt"\)/);
  assert.match(SW_SRC, /isRscPayload \? \{ ignoreSearch: true \}/);
});

test("sw-kill.js: 焼き込みの口を持つ（回復手段がビルドで落ちない）", () => {
  const kill = readFileSync(new URL("../scripts/sw-kill.js", import.meta.url), "utf8");
  assert.ok(kill.includes('const BUILD = "__BUILD__";'));
  assert.ok(kill.includes('["__REQUIRED__"]'));
  assert.ok(kill.includes('["__OPTIONAL__"]'));
});
