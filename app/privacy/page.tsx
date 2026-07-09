import type { Metadata } from "next";
import { SiteHeader, SiteFooter } from "../chrome";
import { SITE_URL } from "../config";

export const metadata: Metadata = {
  title: "プライバシーポリシー｜同人ソンエキ",
  description:
    "同人ソンエキのプライバシーポリシー。個人情報は取得せず、入力データはブラウザ内のlocalStorageにのみ保存されます。アクセス解析にはGoatCounterを使用します。",
  alternates: { canonical: `${SITE_URL}privacy/` },
};

export default function PrivacyPage() {
  return (
    <>
      <a className="skip-link" href="#main">
        本文へスキップ
      </a>

      <SiteHeader />

      <main id="main" tabIndex={-1} style={{ outline: "none" }}>
        <section className="section">
          <div className="container container-narrow">
            <h1>プライバシーポリシー</h1>

            <h2>個人情報の取得について</h2>
            <p>
              本サイト「同人ソンエキ」は、氏名・メールアドレス等の個人情報を取得しません。会員登録・ログイン機能はありません。
            </p>

            <h2>入力データの保存について</h2>
            <p>
              シミュレータやカウンターに入力されたデータ（頒価・印刷費・頒布数など）は、お使いのブラウザ内の保存領域（localStorage）にのみ保存されます。これらのデータがサーバーへ送信されることはありません。ブラウザの設定からサイトデータを削除すると、保存されたデータも消去されます。
            </p>

            <h2>アクセス解析について</h2>
            <p>
              本サイトは、利用状況の把握のためにアクセス解析サービス「GoatCounter」を使用しています。GoatCounter
              は Cookie
              を使用せず、個人を特定しない形でページの閲覧数等を集計します。取り扱いの詳細は
              GoatCounter のプライバシーポリシーをご確認ください。
            </p>

            <h2>外部リンクについて</h2>
            <p>
              本サイトには、委託先の公式案内や外部プラットフォームへのリンクが含まれることがあります。リンク先での情報の取り扱いについては、各リンク先のプライバシーポリシーをご確認ください。
            </p>
          </div>
        </section>
      </main>

      <SiteFooter />
    </>
  );
}
