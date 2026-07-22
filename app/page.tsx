// 同人ソンエキ / — 「朱墨の帳場」の表紙帯＋帳面（シミュレータ本体）。
// 表紙帯: 縦書き表題（強い縦のアンカー）→ 横書きコピー → 主ボタンの L 字視線。
// 以降は太罫が章を刻み、右の集計欄が sticky で常に視界に残る（入力は左・答えは右）。
import type { Metadata } from "next";
import Link from "next/link";
import { Chogashira, Okuzuke } from "./chrome";
import { Simulator } from "./Simulator";
import { SITE_URL } from "./config";

export const metadata: Metadata = {
  alternates: { canonical: SITE_URL },
};

/**
 * 問答（FAQ）の単一ソース。画面表示と構造化データ（FAQPage）を同じ配列から
 * 生成し、両者が食い違わないようにする（検索結果に出す Q&A は画面と必ず一致）。
 * q = 設問本文（丁番の接頭辞は表示側で付す）、a = 回答本文。
 */
const MONDOU: readonly { q: string; a: string }[] = [
  {
    q: "記帳したデータはどこに保存されますか",
    a: "お使いのブラウザ（この端末）の中にだけ保存されます。サーバーには送信されません。ブラウザのデータを消去すると帳面も消えます。",
  },
  {
    q: "委託の手数料はどう計算していますか",
    a: "委託価格×料率＋定額が1冊ごとに引かれます。料率は各委託先の最新の案内に記載の値を記入してください。プリセットは公開情報にもとづく目安で、いつでも書き直せます。",
  },
  {
    q: "印刷所の見積と合いません",
    a: "オプション費用・送料は単価表に含めるか、第四丁の固定費に足してください。単価表は見積の数字をそのまま書き写すのが確実です。",
  },
  {
    q: "カウンターは電波のない会場でも使えますか",
    a: "一度ひらいたあとは、通信が切れても記帳は動き続け、端末に保存されます。ページの再読み込みには接続が要ります。",
  },
];

/** 丁番の漢数字（問一・問二…）。表示ラベルにのみ使う。 */
const CHOBAN = ["一", "二", "三", "四", "五", "六"] as const;

/**
 * 構造化データ（JSON-LD）。SoftwareApplication＝ツール本体、FAQPage＝上の問答。
 * 検索エンジンにツールの性質と Q&A を伝え、リッチリザルトの対象にする。
 * FAQPage の設問・回答は画面の問答（MONDOU）と同一物なので誇大表示にならない。
 */
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      name: "同人ソンエキ",
      url: SITE_URL,
      applicationCategory: "BusinessApplication",
      operatingSystem: "Web",
      inLanguage: "ja",
      description:
        "同人誌の印刷費と委託手数料から損益分岐部数と手取りを計算し、即売会当日の頒布をカウントするツール。",
      offers: { "@type": "Offer", price: "0", priceCurrency: "JPY" },
    },
    {
      "@type": "FAQPage",
      mainEntity: MONDOU.map((item) => ({
        "@type": "Question",
        name: item.q,
        acceptedAnswer: { "@type": "Answer", text: item.a },
      })),
    },
  ],
};

/** 当日欄の挿絵: タリー画面の線画（罫線のみで描く・装飾）。 */
function TojitsuSenga() {
  return (
    <div className="tojitsu-e" aria-hidden="true">
      <svg viewBox="0 0 320 220" fill="none">
        <rect
          x="8"
          y="8"
          width="304"
          height="204"
          stroke="var(--keisen-waku)"
          strokeWidth="1"
        />
        <line
          x1="8"
          y1="40"
          x2="312"
          y2="40"
          stroke="var(--keisen-waku)"
          strokeWidth="1"
        />
        <rect
          x="20"
          y="52"
          width="72"
          height="24"
          fill="var(--sumi)"
          stroke="var(--sumi)"
        />
        <rect
          x="100"
          y="52"
          width="72"
          height="24"
          stroke="var(--keisen-waku)"
        />
        <text
          x="160"
          y="132"
          textAnchor="middle"
          fontSize="56"
          fontWeight="700"
          fill="var(--sumi)"
        >
          38
        </text>
        <rect x="20" y="152" width="280" height="44" fill="var(--shu)" rx="2" />
        <rect
          x="26"
          y="158"
          width="268"
          height="32"
          stroke="var(--kami)"
          strokeOpacity="0.4"
          strokeWidth="2"
          rx="1"
        />
        <text
          x="160"
          y="180"
          textAnchor="middle"
          fontSize="16"
          fontWeight="600"
          fill="var(--kami)"
        >
          ＋１ 頒布
        </text>
      </svg>
    </div>
  );
}

export default function Home() {
  return (
    <>
      {/* 構造化データ（静的 export 時に HTML へ焼き込まれる）。
          "<" を < に伏字化し、将来 FAQ 文言に "</script>" 等が入っても
          script タグをブレイクアウトしないようにする（防御的措置）。 */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
        }}
      />

      <a className="tobira" href="#honmon">
        本文へ飛ぶ
      </a>

      <Chogashira />

      <main id="honmon" tabIndex={-1} style={{ outline: "none" }}>
        {/* 表紙帯 */}
        <div className="daicho">
          <section className="hyoshi">
            <div className="hyoshi-tate" aria-hidden="true">
              同人ソンエキ
            </div>
            <div className="hyoshi-yoko">
              <h1>刷る前に、そろばん。</h1>
              <p className="hyoshi-lead">
                頒価と印刷費から、損益分岐部数を一枚の帳面で。即売会当日の頒布カウンター付き。
              </p>
              <div className="hyoshi-cta">
                <a className="bt bt-main" href="#chomen">
                  損益を弾く
                </a>
                <Link className="bt bt-sub" href="/tally/">
                  当日の記帳へ
                </Link>
              </div>
              <p className="shinrai">
                登録不要・無料。データはこの端末の中だけに保存されます。
              </p>
            </div>
          </section>
        </div>

        <hr className="kugiri-futo" />

        {/* 帳面（シミュレータ本体） */}
        <div className="daicho" id="chomen">
          <Simulator />
        </div>

        <hr className="kugiri-futo" />

        {/* 当日欄 */}
        <div className="daicho">
          <section className="tojitsu" aria-labelledby="tojitsu-midashi">
            <div>
              <h2 id="tojitsu-midashi">当日の記帳 — 頒布カウンター</h2>
              <p style={{ marginTop: "var(--ma-2)" }}>
                売り子の片手で、判を捺すように数える。＋１の角印を叩くだけで頒布数が刻まれ、押しまちがいは「ひとつ戻す」で取り消せます。
              </p>
              <p className="sai" style={{ marginTop: "var(--ma-1)" }}>
                記帳は端末に自動保存。通信が切れても動き続けます。この帳面の頒価とつながり、当日の損益も出ます。
              </p>
              <div style={{ marginTop: "var(--ma-3)" }}>
                <Link className="bt bt-sub" href="/tally/">
                  当日の記帳をひらく →
                </Link>
              </div>
            </div>
            <TojitsuSenga />
          </section>
        </div>

        <hr className="kugiri-hoso" />

        {/* 但し書き（有料成果物・準備中）— 付箋様式（藍3px縦罫）・細字 */}
        <div className="daicho">
          <section className="tadashigaki">
            <div className="fusen">
              <p className="sai">
                但し書き —
                収支レポートPDFと見積比較早見表を、外部ストアで頒布する準備をしています。この帳面の機能は今後も無料です。
              </p>
            </div>
          </section>
        </div>

        <hr className="kugiri-hoso" />

        {/* 問答（FAQ） */}
        <div className="daicho">
          <section className="mondou" aria-labelledby="mondou-midashi">
            <h2 id="mondou-midashi">問答</h2>
            {MONDOU.map((item, i) => (
              <div className="mondou-kumi" key={item.q}>
                <p className="mondou-toi">
                  問{CHOBAN[i]}　{item.q}
                </p>
                <p className="mondou-kotae">{item.a}</p>
              </div>
            ))}
          </section>
        </div>
      </main>

      <Okuzuke />
    </>
  );
}
