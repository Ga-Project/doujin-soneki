// 全ページ共通のヘッダー／フッター／ブランドマーク（静的・サーバーコンポーネント）。
// 内部リンクは next/link を使う（basePath 配信時にサブパスを自動付与するため。
// 素の <a href="/…"> は basePath が付かず、プロジェクトページ配信で 404 になる）。
import Link from "next/link";

/** ブランドマーク: 赤字から黒字へ抜ける損益ラインの意匠（CSS/SVG のみ・画像不使用）。 */
export function BrandMark({ size = 12 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      {/* ゼロライン */}
      <path
        d="M2 8h12"
        stroke="currentColor"
        strokeOpacity="0.45"
        strokeWidth="1.2"
      />
      {/* 右肩上がりの損益ライン */}
      <path
        d="M2 12.5 L14 3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      {/* 損益分岐点 */}
      <circle cx="7.3" cy="8" r="1.7" fill="currentColor" />
    </svg>
  );
}

export function SiteHeader() {
  return (
    <header className="site-header">
      <div className="container">
        <Link className="brand" href="/">
          <span className="brand-mark" aria-hidden="true">
            <BrandMark size={14} />
          </span>
          <span>同人ソンエキ</span>
        </Link>
        <Link className="btn btn-secondary" href="/tally/">
          即売会カウンター
        </Link>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="container">
        <p>
          計算結果は入力値にもとづく目安です。実際の印刷費・手数料は各印刷所・委託先の最新の案内をご確認ください。
        </p>
        <p style={{ marginTop: "var(--sp-2)" }}>
          入力した内容はお使いのブラウザ内にのみ保存され、サーバーへ送信されません。
        </p>
        <p style={{ marginTop: "var(--sp-4)" }}>
          <Link href="/terms/">利用規約</Link>
          {"　"}
          <Link href="/privacy/">プライバシーポリシー</Link>
        </p>
        <p style={{ marginTop: "var(--sp-4)" }}>© 同人ソンエキ</p>
      </div>
    </footer>
  );
}
