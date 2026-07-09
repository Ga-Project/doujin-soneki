// 同人ソンエキ — ランディング一体型シミュレータ（ツールファースト）。
// hero 直下に本体（#simulator）があり、着地後スクロール 1 回で計算を始められる。
import type { Metadata } from "next";
import Link from "next/link";
import { SiteHeader, SiteFooter } from "./chrome";
import { Simulator } from "./Simulator";
import { SITE_URL } from "./config";

export const metadata: Metadata = {
  alternates: { canonical: SITE_URL },
};

/** hero 右カラムの装飾ミニ損益グラフ（実グラフと同じ視覚言語の静的 SVG・装飾）。 */
function HeroChart() {
  return (
    <div className="hero-visual" aria-hidden="true">
      <svg viewBox="0 0 360 240" fill="none">
        {/* ゾーン */}
        <rect
          x="36"
          y="16"
          width="292"
          height="104"
          fill="var(--chart-zone-profit)"
        />
        <rect
          x="36"
          y="120"
          width="292"
          height="88"
          fill="var(--chart-zone-loss)"
        />
        <text x="44" y="32" fontSize="10" fill="var(--text-dim)">
          黒字
        </text>
        <text x="44" y="200" fontSize="10" fill="var(--text-dim)">
          赤字
        </text>
        {/* グリッド */}
        {[16, 68, 172, 208].map((gy) => (
          <line
            key={gy}
            x1="36"
            x2="328"
            y1={gy}
            y2={gy}
            stroke="var(--chart-grid)"
            strokeWidth="1"
          />
        ))}
        {[109, 182, 255].map((gx) => (
          <line
            key={gx}
            x1={gx}
            x2={gx}
            y1="16"
            y2="208"
            stroke="var(--chart-grid)"
            strokeWidth="1"
          />
        ))}
        {/* ゼロライン */}
        <line
          x1="36"
          x2="328"
          y1="120"
          y2="120"
          stroke="var(--chart-zero)"
          strokeWidth="1.5"
        />
        {/* 委託線（破線） */}
        <path
          d="M36 196 L328 88"
          stroke="var(--chart-consign-1)"
          strokeWidth="2.5"
          strokeDasharray="6 4"
          strokeLinecap="round"
        />
        {/* 会場頒布線（赤字から黒字へ突き抜ける） */}
        <path
          d="M36 196 L328 40"
          stroke="var(--chart-direct)"
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        {/* 損益分岐マーカー */}
        <line
          x1="178"
          x2="178"
          y1="16"
          y2="120"
          stroke="var(--accent)"
          strokeWidth="1"
          strokeDasharray="4 4"
        />
        <circle
          cx="178"
          cy="120"
          r="5"
          fill="var(--accent)"
          stroke="var(--bg)"
          strokeWidth="2"
        />
        <rect
          x="132"
          y="86"
          width="92"
          height="20"
          rx="10"
          fill="var(--accent-tint)"
          stroke="var(--accent)"
          strokeOpacity="0.35"
        />
        <text
          x="178"
          y="100"
          fontSize="10"
          fontWeight="700"
          fill="var(--accent)"
          textAnchor="middle"
        >
          損益分岐 320部
        </text>
        {/* 完売点 */}
        <circle cx="328" cy="40" r="3.5" fill="var(--ok)" />
        <text
          x="322"
          y="30"
          fontSize="10"
          fontWeight="700"
          fill="var(--ok)"
          textAnchor="end"
        >
          完売 +¥12,400
        </text>
      </svg>
    </div>
  );
}

export default function Home() {
  return (
    <>
      <a className="skip-link" href="#main">
        本文へスキップ
      </a>

      <SiteHeader />

      <main
        id="main"
        tabIndex={-1}
        style={{ outline: "none" }}
        className="has-minibar"
      >
        {/* 1. hero（コンパクト・2 カラム） */}
        <section className="hero hero-compact">
          <div className="container">
            <div className="hero-grid">
              <div>
                <span className="eyebrow">サークル向け・無料の損益電卓</span>
                <h1>
                  その部数、<span className="accent-text">刷って大丈夫？</span>
                </h1>
                <p className="hero-lead">
                  印刷所の階段単価と委託手数料をまとめて計算。損益分岐部数と手取りが、入力したそばからグラフで見えます。即売会当日の頒布カウンター付き。
                </p>
                <div className="hero-actions">
                  <a className="btn btn-primary btn-lg" href="#simulator">
                    いますぐ計算する
                  </a>
                  <Link className="btn btn-secondary btn-lg" href="/tally/">
                    即売会カウンターを開く
                  </Link>
                </div>
                <p className="hero-note">
                  登録不要・無料。入力データはこの端末の中にだけ保存されます。
                </p>
              </div>
              <HeroChart />
            </div>
          </div>
        </section>

        {/* 2. 損益分岐シミュレータ（主役・製図台） */}
        <section
          id="simulator"
          className="sim-section"
          aria-labelledby="simulator-heading"
        >
          <div className="container">
            <span className="eyebrow">損益分岐シミュレータ</span>
            <h2 id="simulator-heading" style={{ marginTop: "var(--sp-2)" }}>
              刷る前に、見える。
            </h2>
            <p style={{ color: "var(--text-soft)", maxWidth: "52ch" }}>
              印刷所の見積とイベントの条件を写すだけで、損益分岐部数・完売時の手取り・頒価の目安が同時に出ます。
            </p>
            <div style={{ marginTop: "var(--sp-6)" }}>
              <Simulator />
            </div>
          </div>
        </section>

        {/* 3. タリー紹介 */}
        <section
          id="tally-intro"
          className="section"
          aria-labelledby="tally-heading"
        >
          <div className="container">
            <div className="tally-intro-grid">
              <div>
                <span className="eyebrow">即売会当日は</span>
                <h2 id="tally-heading" style={{ marginTop: "var(--sp-2)" }}>
                  片手で数える、頒布カウンター
                </h2>
                <p style={{ color: "var(--text-soft)" }}>
                  大きな「＋1」ボタンで、接客しながらでも確実にカウント。押しまちがえても「ひとつ戻す」ですぐ戻せます。記録は端末に自動保存され、通信が切れても動き続けます。シミュレータの頒価とつながって、いま何部でいくらかも分かります。
                </p>
                <div className="hero-actions">
                  <Link className="btn btn-secondary btn-lg" href="/tally/">
                    即売会カウンターを開く
                  </Link>
                </div>
              </div>
              <div className="phone-mock" aria-hidden="true">
                <span className="mock-chip">新刊A</span>
                <div>
                  <div className="mock-count tabular">23</div>
                  <div className="mock-remaining tabular">残り 27部</div>
                </div>
                <div className="mock-btn">＋1 頒布</div>
              </div>
            </div>
          </div>
        </section>

        {/* 4. 有料成果物の控えめ案内 */}
        <section id="pro" className="pro-band" aria-labelledby="pro-heading">
          <div className="container">
            <span className="eyebrow">さらに踏み込むなら</span>
            <h2 id="pro-heading">印刷所選びまで詰めたい方へ</h2>
            <p>
              収支レポートPDFのテンプレートと、印刷見積の比較早見表を外部ストアで頒布する準備を進めています。このサイトの計算はすべて無料のまま使えます。
            </p>
            <p style={{ marginTop: "var(--sp-3)" }}>
              <span className="badge">準備中</span>
            </p>
          </div>
        </section>

        {/* 5. FAQ */}
        <section id="faq" className="section" aria-labelledby="faq-heading">
          <div className="container container-narrow">
            <span className="eyebrow">よくある質問</span>
            <h2 id="faq-heading" style={{ marginTop: "var(--sp-2)" }}>
              FAQ
            </h2>
            <div className="faq-list">
              <details>
                <summary>データはどこに保存されますか</summary>
                <p>
                  入力した内容はお使いのブラウザ（この端末）の中にだけ保存されます。サーバーには送信されません。ブラウザのデータを消去すると入力も消えます。
                </p>
              </details>
              <details>
                <summary>手数料率はどう入れればいいですか</summary>
                <p>
                  委託先の案内に記載の料率を入力してください。プリセットの数値は公開情報にもとづく目安で、いつでも編集できます。料率は改定されることがあるため、最新の料率は各委託先の公式の案内でご確認ください。
                </p>
              </details>
              <details>
                <summary>印刷所の見積もりと合いません</summary>
                <p>
                  オプション費用・送料などは単価表に含めるか、「詳細オプション」の固定費に加算してください。単価表は印刷所の見積の数字をそのまま写すのが確実です。
                </p>
              </details>
              <details>
                <summary>カウンターはオフラインでも使えますか</summary>
                <p>
                  一度ページを開いたあとは、通信が切れてもカウントは動き続け、記録は端末に保存されます。ページの再読み込みには接続が必要です。
                </p>
              </details>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
