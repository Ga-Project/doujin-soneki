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
  PRIMARY_SHELL,
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

test("shouldRegisterSonae: ?nosw のときだけ登録しない（その読み込み限り）", () => {
  assert.equal(shouldRegisterSonae({ search: "" }), true);
  assert.equal(shouldRegisterSonae({ search: "?nosw" }), false);
  assert.equal(shouldRegisterSonae({ search: "?utm_source=x" }), true);
  // 端末に離脱を焼き付けない。焼き付けると、以後どの訪問でも札が
  // 「そなえ不可（要電波）」になり、原因が自分の操作だと画面から分からない。
  assert.equal(shouldRegisterSonae({ search: "" }), true);
});

// --- 世代キャッシュの不変条件 --------------------------------------------

test("sw.js: 焼き込まれていない版は install で落とす（黙って劣化モードで動かない）", () => {
  assert.match(SW_SRC, /BUILD === "__BUILD__" \|\| REQUIRED\.length === 0/);
  assert.match(SW_SRC, /throw new Error\("sw is not stamped"\)/);
});

test("sw.js: 世代の控えを書くのは install だけ（navigate の書き戻しを持たない）", () => {
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

test("sw.js: オフラインの受け皿の出口は scope 基準の絶対パス", () => {
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

test("sw.js: install の後は世代キャッシュに一切書かない（別置きにだけ書く）", () => {
  // navigate だけでなく資産の経路も同じ。裏の更新で新しいデプロイの実体を
  // 旧世代に混ぜると、all-or-nothing が守っている版の一致が世代の内側で崩れる
  // （RSC ペイロードは ignoreSearch で照合するので、混ざると特に当たりやすい）。
  const afterInstall = SW_SRC.slice(
    SW_SRC.indexOf('self.addEventListener("activate"'),
  );
  const writes = [...afterInstall.matchAll(/putSafe\(\s*([A-Za-z]+)/g)].map(
    (m) => m[1],
  );
  assert.ok(writes.length > 0, "書き込み経路を見つけられていない（検査が空振り）");
  for (const target of writes) {
    assert.equal(target, "runtime", `install の後で ${target} に書いている`);
  }
  assert.ok(
    !afterInstall.includes("cache.put("),
    "install の後で世代のキャッシュに直接書いている",
  );
  // 別置きは世代と別名で、掃除のときに巻き添えで消さない
  assert.ok(SW_SRC.includes("const RUNTIME ="), "別置きの宣言が無い");
  assert.ok(
    SW_SRC.includes("n !== CACHE && n !== RUNTIME"),
    "掃除が別置きまで消している",
  );
});

test("sw.js: ページ遷移で 4xx/5xx を控えより優先しない", () => {
  // 配信面や経路が一時的に返したエラーページで、控えのある画面を置き換えない。
  assert.ok(
    SW_SRC.includes("winner && winner.ok ? winner : cached"),
    "非 OK 応答を「取れた」に数えている",
  );
});

test("sw.js: 必須分の取得にも時間切れがある（本文の転送まで覆う）", () => {
  // 応答ヘッダが返っても本文が来ないことはあり、cache.put で止まると install は
  // 無期限に開いたまま＝「そなえ中」から動かず、失敗として畳まれず再試行もされない。
  assert.ok(SW_SRC.includes("REQUIRED_TIMEOUT_MS"), "必須分に時間切れが無い");
  const install = SW_SRC.slice(
    SW_SRC.indexOf('self.addEventListener("install"'),
    SW_SRC.indexOf('self.addEventListener("activate"'),
  );
  const created = install.indexOf("AbortSignal.timeout(REQUIRED_TIMEOUT_MS)");
  const put = install.indexOf("await cache.put(url, res)");
  assert.ok(created > 0 && put > 0, "取得と put を見つけられていない（検査が空振り）");
  assert.ok(created < put, "時間切れが put より後に張られている");
  assert.ok(
    install.includes("fetch(url, { cache: \"reload\", signal })"),
    "必須分の取得に signal を渡していない",
  );
});

test("sw.js: 控えの鍵は RSC ペイロードのクエリを落とす（死蔵を積み上げない）", () => {
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
    src.indexOf("function removeSonae"),
    src.indexOf("function syncOptOut"),
  );
  assert.ok(body.length > 0, "removeSonae を見つけられていない（検査が空振り）");
  assert.ok(
    /r\.scope === scope/.test(body),
    "オリジン全体の登録を解除している",
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

test("useSonae: install の失敗を見届ける（そなえ中で止めない）", () => {
  // register() は登録できた時点で解決する。その後 precache が欠けて版が
  // redundant になっても controllerchange は来ないので、見ないと札が
  // 「そなえ中」のまま止まり「開いたまま待て」と言い続ける。
  const src = readFileSync(
    new URL("../app/tally/useSonae.ts", import.meta.url),
    "utf8",
  );
  assert.match(src, /addEventListener\("statechange"/);
  assert.match(src, /installing\.state === "redundant"/);
  // 活きている版があるなら、畳まれたのは更新の試行だけ（控えは使える）
  assert.match(src, /reg\.active === null/);
});
