// 公開時に設定する「秘密ではない」公開値と、製品全体で共有する定数。
// 差し替え・変更箇所はこの 1 ファイルに集約する。

/** 公開後の GitHub Pages URL（OGP/canonical に使う）。trailingSlash:true に合わせ末尾スラッシュ。 */
export const SITE_URL = "https://ga-project.github.io/doujin-soneki/";

/** GoatCounter（cookieless・秘密キー不要）のコード。publish 時に実コードへ差し替える。 */
export const GOATCOUNTER_CODE = "__GC_CODE__";

/** localStorage の保存名（スキーマ変更時はバージョンを上げて旧データを読み捨てる）。 */
export const SIM_STORAGE_NAME = "soneki.sim.v1";
export const TALLY_STORAGE_NAME = "soneki.tally.v1";

/**
 * 委託先プリセット（中立なテキスト表記のみ。ロゴ・商標表現は使わない）。
 *
 * 料率は実装時に各委託先の公開情報を確認できたものだけ既定値として入れる。
 * 確認できなかったものは空欄（ユーザー入力）にする。料率は改定されることが
 * あるため、UI には必ず「最新の料率は各委託先の公式案内で要確認」を明示する。
 *
 * 確認済みの出典:
 *   - とらのあな: 委託（専売・併売）の掛け率 70%（＝手数料 30%・税抜本体価格基準）
 *     https://help.toranoana.jp/3336/
 *   - BOOTH: サービス利用料 5.6% + 45円/件（自宅から発送。2025-10-28 改定）
 *     https://booth.pm/announcements/832
 *   - メロンブックス: 公式の公開ページでは料率を確認できなかったため既定値なし
 *     （サークル向け案内は会員向けのため。料率は委託先の案内で確認して入力）
 */
export interface ConsignPreset {
  /** 表示名（プレーンテキスト・中立表記）。 */
  name: string;
  /** 手数料率 %（未確認は空文字 = ユーザー入力）。 */
  fee: string;
  /** 1 冊あたりの定額手数料 円（該当なし・未確認は "0" / 空）。 */
  perItem: string;
  /** 出典 URL（確認できた場合のみ）。 */
  sourceUrl: string | null;
  /** UI に添える注記。 */
  note: string;
}

export const CONSIGN_PRESETS: readonly ConsignPreset[] = [
  {
    name: "とらのあな",
    fee: "30",
    perItem: "0",
    sourceUrl: "https://help.toranoana.jp/3336/",
    note: "委託（専売・併売）の掛け率70%＝手数料30%。税抜の本体価格が基準です。",
  },
  {
    name: "メロンブックス",
    fee: "",
    perItem: "0",
    sourceUrl: null,
    note: "公式の公開ページで料率を確認できなかったため、委託先の案内に記載の料率を入力してください。",
  },
  {
    name: "BOOTH",
    fee: "5.6",
    perItem: "45",
    sourceUrl: "https://booth.pm/announcements/832",
    note: "サービス利用料5.6%＋45円/件（自宅から発送・2025年10月改定）。発送方法により異なります。",
  },
];
