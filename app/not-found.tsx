// 404 ページ。static export（output: "export"）では out/404.html に書き出され、
// GitHub Pages の 404 になる。「朱墨の帳場」の読み物様式・h1 は1つ・skip-link を持つ。

import type { Metadata } from "next";
import Link from "next/link";
import { Chogashira } from "./chrome";

export const metadata: Metadata = {
  title: "ページが見つかりません｜同人ソンエキ",
  // 404 は検索インデックス対象外にする（誤ってインデックスされないように）。
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <>
      <a className="tobira" href="#honmon">
        本文へ飛ぶ
      </a>

      <Chogashira />

      <main id="honmon" tabIndex={-1} style={{ outline: "none" }}>
        <article className="yomimono">
          <h1>この丁は見つかりません</h1>
          <p>
            お探しのページは見つかりませんでした。移動・削除されたか、URL
            が誤っている可能性があります。
          </p>
          <div style={{ marginTop: "var(--ma-3)" }}>
            <Link className="bt bt-main" href="/">
              帳面に戻る
            </Link>
          </div>
          <div className="okuzuke">
            <p>奥付　同人ソンエキ</p>
          </div>
        </article>
      </main>
    </>
  );
}
