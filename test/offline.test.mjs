// doujin-soneki — オフライン（当日そなえ）ロジックの単体テスト。
// 実行: pnpm test（Node が .ts を型ストリップして読み込む）。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeBasePath,
  swPath,
  swScope,
  resolveSonaeState,
  sonaeFuda,
  SHELL_PATHS,
} from "../lib/offline.ts";

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
    resolveSonaeState({ supported: false, failed: false, controlled: false }),
    "fuka",
  );
  // 非対応なら controlled の値によらず fuka
  assert.equal(
    resolveSonaeState({ supported: false, failed: false, controlled: true }),
    "fuka",
  );
  // 対応環境でも登録に失敗したら控えは無い
  assert.equal(
    resolveSonaeState({ supported: true, failed: true, controlled: false }),
    "fuka",
  );
});

test("resolveSonaeState: sw が制御していて初めて ari と言い切る", () => {
  // 登録しただけ＝まだ控えが無い端末。「電波が無くても開けます」と表示しない
  assert.equal(
    resolveSonaeState({ supported: true, failed: false, controlled: false }),
    "junbi",
  );
  assert.equal(
    resolveSonaeState({ supported: true, failed: false, controlled: true }),
    "ari",
  );
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
