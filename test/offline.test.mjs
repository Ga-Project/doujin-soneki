// doujin-soneki — オフライン（当日そなえ）ロジックの単体テスト。
// 実行: pnpm test（Node が .ts を型ストリップして読み込む）。
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { selectPrecache } from "../scripts/stamp-sw-select.mjs";
import {
  normalizeBasePath,
  swPath,
  swScope,
  resolveSonaeState,
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
