// 404 ページ。static export（output: "export"）では out/404.html に書き出され、
// GitHub Pages の 404 になる。他ページと同じランドマーク・h1 は1つ・skip-link を持つ。

import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader, SiteFooter } from "./chrome";

export const metadata: Metadata = {
  title: "ページが見つかりません｜同人ソンエキ",
  // 404 は検索インデックス対象外にする（誤ってインデックスされないように）。
  robots: { index: false, follow: false },
};

export default function NotFound() {
  return (
    <>
      <a className="skip-link" href="#main">
        本文へスキップ
      </a>

      <SiteHeader />

      <main id="main" tabIndex={-1} style={{ outline: "none" }}>
        <section className="hero">
          <div className="container container-narrow">
            <span className="badge badge-accent">404</span>
            <h1 style={{ marginTop: "var(--sp-4)" }}>
              ページが<span className="accent-text">見つかりません</span>
            </h1>
            <p className="hero-lead">
              お探しのページは見つかりませんでした。移動・削除されたか、URL
              が誤っている可能性があります。
            </p>
            <div className="hero-actions">
              <Link className="btn btn-primary" href="/">
                ホームへ戻る
              </Link>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
