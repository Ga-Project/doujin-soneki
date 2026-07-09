// doujin-soneki — 既定ランディング（web テンプレ）。
// 共通デザイン基盤（globals.css）＋製品の顔（theme.css）を体現する作り込みの見本。
// 各製品は eyebrow / h1 / lead / CTA / 特徴3枚の中身を差し替え、theme.css で色味を変える。
// セマンティックランドマーク（header / main / footer）・h1 は1つ・skip-link を既定で持つ。
// 主要 CTA の href="#signup" はプレースホルダ。各製品が登録セクション/外部 URL に差し替える。

const features = [
  {
    icon: "◆",
    title: "特徴1",
    body: "ここに最初の価値を説明する。製品が解く課題と、その解き方を一言で。",
  },
  {
    icon: "◇",
    title: "特徴2",
    body: "ここに2つ目の価値を説明する。使う人が得られる結果を具体的に書く。",
  },
  {
    icon: "○",
    title: "特徴3",
    body: "ここに3つ目の価値を説明する。他にない理由や手軽さを書く。",
  },
];

export default function Home() {
  return (
    <>
      <a className="skip-link" href="#main">
        本文へスキップ
      </a>

      <header className="site-header">
        <div className="container">
          <a className="brand" href="/">
            <span className="brand-mark" aria-hidden="true">
              __
            </span>
            <span>doujin-soneki</span>
          </a>
          <a className="btn btn-primary" href="#signup">
            使ってみる
          </a>
        </div>
      </header>

      <main id="main" tabIndex={-1} style={{ outline: "none" }}>
        <section className="hero">
          <div className="container">
            <span className="eyebrow">新しい体験</span>
            <h1>
              ここに<span className="accent-text">強い見出し</span>を。
              誰の何を解決するかを一文で。
            </h1>
            <p className="hero-lead">
              ここに製品の価値を一言で。何ができて、誰のためのものかを端的に伝える。
              読み手が「自分のことだ」と感じる具体に踏み込む。
            </p>
            <div className="hero-actions">
              <a className="btn btn-primary btn-lg" href="#signup">
                使ってみる
              </a>
              <a className="btn btn-secondary btn-lg" href="#features">
                詳しく見る
              </a>
            </div>
            <p className="hero-note">登録不要・ブラウザですぐ使える。</p>
          </div>
        </section>

        <section id="features" className="section" aria-labelledby="features-heading">
          <div className="container">
            <span className="eyebrow">できること</span>
            <h2 id="features-heading" style={{ marginTop: "var(--sp-3)" }}>
              特徴
            </h2>
            <div className="card-grid" style={{ marginTop: "var(--sp-8)" }}>
              {features.map((f) => (
                <article className="card" key={f.title}>
                  <span className="card-icon" aria-hidden="true">
                    {f.icon}
                  </span>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <div className="container">
          <p>© doujin-soneki</p>
        </div>
      </footer>
    </>
  );
}
