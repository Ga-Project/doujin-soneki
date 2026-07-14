// 全ページ共通の帳頭バー（ヘッダー）と奥付（フッター）。
// 「朱墨の帳場」様式: 帳頭は static・下に枠罫1px、奥付は中央・細字。
// 内部リンクは next/link（basePath 配信でもサブパスが付くように）。
import Link from "next/link";

export function Chogashira() {
  return (
    <header className="chogashira">
      <div className="daicho chogashira-uchi">
        <Link className="daimei" href="/">
          <span className="daimei-in" aria-hidden="true">
            ◆
          </span>
          同人ソンエキ
        </Link>
        <Link className="migi" href="/tally/">
          当日の記帳 →
        </Link>
      </div>
    </header>
  );
}

export function Okuzuke() {
  return (
    <footer>
      <hr className="kugiri-futo" />
      <div className="daicho okuzuke">
        <p>
          計算結果は入力値にもとづく目安です。実際の印刷費・手数料は各印刷所・委託先の最新の案内でご確認ください。
        </p>
        <p>
          入力した内容はお使いのブラウザ内にのみ保存され、サーバーへ送信されません。
        </p>
        <p style={{ marginTop: "var(--ma-2)" }}>
          奥付　同人ソンエキ ／ <Link href="/terms/">利用規約</Link> ・{" "}
          <Link href="/privacy/">プライバシー</Link>
        </p>
      </div>
    </footer>
  );
}
