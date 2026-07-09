#!/usr/bin/env bash
# 単一引用符内の `\$` は正規表現リテラルとして意図的に使う(展開させない)。
# shellcheck disable=SC2016
#
# public-gate.sh — 公開前ゲート（public 化する web/game プロダクト用）
#
# 目的:
#   public リポジトリに内部用語・社内固有情報・個人を特定する commit author・
#   平文シークレットが漏れないよう、公開の直前に機械的に弾く。size-fitter で
#   起きた手動スクラブ漏れを再発させないため、CI と手元で同じこのスクリプトを使う。
#
# 契約:
#   - 引数なし。cwd（= リポジトリルート）を対象に 4 チェックを必ず全て実行する。
#   - 1つでも違反を検出したら exit 1、全て PASS で exit 0。
#   - 失敗しても後続チェックを止めない(全漏洩を1回で洗い出す)。最後に集約判定する。
#   - 実リモートは作らない（gh は使わない）。ローカル git とファイル走査のみ。
#   - シークレット値は出力しない（gitleaks は --redact）。
#
# 検査:
#   (A) authors  — 全履歴の author/committer メール・名前が許可リストのみか
#   (B) tree     — 追跡ファイルに内部用語・社内固有情報が残っていないか
#   (C) gitleaks — 平文シークレットが履歴に無いか（CLI を pin して全履歴走査）
#   (D) messages — 全履歴のコミットメッセージに内部用語が残っていないか
#
set -Eeuo pipefail

GATE_FAIL=0
fail() { echo "  NG: $*" >&2; GATE_FAIL=1; }
ok()   { echo "  OK: $*" >&2; }
sec()  { echo "[public-gate] $*" >&2; }

# このスクリプトの所在(内部用語の単一ソースを相対解決するため)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"

# ---------------------------------------------------------------------------
# 許可リスト（先頭で定義）
# ---------------------------------------------------------------------------

# author/committer に許可するメール（noreply 系のみ）
AUTHOR_EMAIL_ALLOW='^(noreply@ga-project\.net|noreply@github\.com|[0-9]+\+[^@]+@users\.noreply\.github\.com|[^@]+@users\.noreply\.github\.com)$'

# author/committer に許可する名前(allowlist)。email と同じ思想で「許可した名前以外は fail」。
#   Ga Project       = 工場の noreply 著者
#   dependabot[bot]  = Dependabot の自動 PR/commit
#   github-actions   = GitHub Actions bot(merge commit 等)
#   web-flow         = GitHub Web UI の merge commit
AUTHOR_NAME_ALLOW='^(Ga Project|dependabot\[bot\]|dependabot-preview\[bot\]|github-actions\[bot\]|GitHub|web-flow)$'

# 統一マスク sed（機能 $0 + テンプレ placeholder を行内で伏字化する）。
#   旧実装は placeholder を含む行を grep -vE で丸ごと落としていたが、それだと
#   `x __GC_CODE__ 新規課金アカウント` のように許可トークンと内部用語を同一物理行に
#   co-locate されると行ごと消え、内部用語が素通り(PASS)してしまう欠陥があった。
#   機能 $0 と同じ「行内センチネル伏字化」に統一し、許可トークンだけを潰してから
#   内部用語パターンを当てる。これで同一行 co-locate でも内部用語が残って検出される。
#   placeholder のみの行(内部用語なし。例: app/layout.tsx の __GC_CODE__ 行)は
#   伏字化後も内部用語が無いので PASS のまま（誤爆ゼロ）。
#
#   マスク対象:
#     $(...) 展開 / "$0" / ${...} / $0 直後が英数_ … 機能 $0（位置パラメータ）
#     age1__…__ 形式                                 … sops/age レシピエント placeholder
#     __[A-Z0-9_]+__ 形式                            … __GC_CODE__ / __CF_BEACON_TOKEN__ / doujin-soneki 等
MASK_SED='s/\$([^)]*)/__FN0__/g; s/"\$0"/__FN0__/g; s/\${[^}]*}/__FN0__/g; s/\$0[[:alnum:]_]/__FN0__/g; s/age1__[A-Za-z0-9_]*__/__PH__/g; s/__[A-Z0-9_]\{1,\}__/__PH__/g'

# 内部用語パターンの単一ソース(public-gate.sh と ci.yml が共有)。
#   ファイルが無い場合に備え、フォールバックの最小集合も持つ(生成物では必ず同梱される)。
load_internal_patterns() {
  local src="$SCRIPT_DIR/internal-terms.txt"
  if [ -f "$src" ]; then
    grep -vE '^[[:space:]]*(#|$)' "$src" | sed 's/[[:space:]]*$//'
    return 0
  fi
  # フォールバック(単一ソースが無い環境向け。通常は到達しない)
  printf '%s\n' \
    'ga-factory' '当社[[:space:]]*Cloudflare' '既に[[:space:]]*(有料)?課金' \
    '課金枠' '新規課金' '課金アカウント' '完全無料' '依存ゼロ' \
    'client-side' '静的Web' '\$0[[:space:]]*方針' '\$0[[:space:]]*厳守'
}

# ---------------------------------------------------------------------------
# (A) authors — 個人メール / 個人名混入コミットを全履歴で遮断
# ---------------------------------------------------------------------------
check_authors() {
  sec "(A) authors: 全履歴の author/committer を検査"
  local emails names

  emails="$(git log --all --format='%ae%n%ce' | sort -u)"
  while IFS= read -r e; do
    [ -n "$e" ] || continue
    if ! printf '%s' "$e" | grep -Eq "$AUTHOR_EMAIL_ALLOW"; then
      fail "許可されない author/committer メール: $e"
    fi
  done <<EOF
$emails
EOF

  # 名前は allowlist 化(email と同じ思想)。許可名以外が現れたら fail。
  names="$(git log --all --format='%an%n%cn' | sort -u)"
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    if ! printf '%s' "$n" | grep -Eq "$AUTHOR_NAME_ALLOW"; then
      fail "許可されない author/committer 名: $n"
    fi
  done <<EOF
$names
EOF

  [ "$GATE_FAIL" -eq 0 ] && ok "author/committer は全て許可リスト内"
  return 0
}

# ---------------------------------------------------------------------------
# (B) tree — 内部用語 / 社内固有情報の残存検出（HEAD ツリー全文 + 履歴追加行）
# ---------------------------------------------------------------------------
# 許可トークン(機能 $0 + テンプレ placeholder)を行内で伏字化(sed)してから
# 内部用語パターン（コスト文脈 $0 含む）を当てる。許可トークンと内部用語が
# 同一物理行に co-locate していても内部用語だけ残るので検出できる。
check_tree() {
  sec "(B) tree: 追跡ファイルの内部用語を検査"

  local joined
  joined="$(load_internal_patterns | paste -sd '|' -)"

  # 対象から除外: ゲート自身(blocklist リテラルを定義として持つ)と単一ソース。
  local self_path="scripts/public-gate.sh"
  local terms_path="scripts/internal-terms.txt"

  # HEAD ツリー全文。許可トークン(機能 $0 + placeholder)を行内伏字化してから内部用語を当てる。
  local hits_head
  hits_head="$(git grep -nI -E '.' -- . ":(exclude)$self_path" ":(exclude)$terms_path" 2>/dev/null \
    | sed "$MASK_SED" \
    | grep -E "$joined" || true)"
  if [ -n "$hits_head" ]; then
    fail "HEAD ツリーに内部用語が残存:"
    printf '%s\n' "$hits_head" | head -40 | sed 's/^/      /' >&2
  fi

  # 全履歴の追加行（過去 commit に混入し HEAD で消えていても弾く）
  local hits_hist
  hits_hist="$(git log --all -p --no-color -- . ":(exclude)$self_path" ":(exclude)$terms_path" 2>/dev/null \
    | grep -E '^\+' \
    | grep -vE '^\+\+\+' \
    | sed "$MASK_SED" \
    | grep -E "$joined" || true)"
  if [ -n "$hits_hist" ]; then
    fail "履歴の追加行に内部用語が残存:"
    printf '%s\n' "$hits_hist" | head -40 | sed 's/^/      /' >&2
  fi

  [ "$GATE_FAIL" -eq 0 ] && ok "内部用語の残存なし（機能 \$0 は温存）"
  return 0
}

# ---------------------------------------------------------------------------
# (C) gitleaks — 平文シークレットを全履歴で検出（CLI pin・値は出力しない）
# ---------------------------------------------------------------------------
check_gitleaks() {
  sec "(C) gitleaks: 平文シークレットを検査"
  if ! command -v gitleaks >/dev/null 2>&1; then
    fail "gitleaks が見つかりません（CI は pin した CLI を install 済みの前提）"
    return 0
  fi
  local cfg=()
  [ -f .gitleaks.toml ] && cfg=(--config .gitleaks.toml)
  # --redact: 検出値を出力に出さない。--exit-code 1: 検出で fail。
  # 空配列は bash3.2(set -u) で unbound になるため空安全展開する。
  if gitleaks detect --source . ${cfg[@]+"${cfg[@]}"} --redact --no-banner --exit-code 1; then
    ok "平文シークレットなし"
  else
    fail "平文シークレットを検出（gitleaks）"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# (D) messages — 全履歴のコミットメッセージに内部用語が残っていないか
# ---------------------------------------------------------------------------
# tree(B) はファイル本文しか見ないため、メッセージ本文に内部用語を書いた commit が
# すり抜ける。メッセージ全文(%B)を同じ内部用語 blocklist で検査する。
check_messages() {
  sec "(D) messages: 全履歴のコミットメッセージを検査"

  local joined
  joined="$(load_internal_patterns | paste -sd '|' -)"

  local hits
  hits="$(git log --all --format='%H %B' 2>/dev/null \
    | sed "$MASK_SED" \
    | grep -E "$joined" || true)"
  if [ -n "$hits" ]; then
    fail "コミットメッセージに内部用語が残存:"
    printf '%s\n' "$hits" | head -40 | sed 's/^/      /' >&2
  fi

  [ "$GATE_FAIL" -eq 0 ] && ok "コミットメッセージに内部用語なし"
  return 0
}

# ---------------------------------------------------------------------------
main() {
  # git リポジトリであることを確認
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
    || { echo "[public-gate] cwd が git リポジトリではありません" >&2; exit 2; }

  # 実行コンテキストガード: この gate の author/message 検査は「製品リポ自身の
  # 全履歴」を対象とする設計。通常の monorepo checkout（製品ディレクトリが nested
  # git リポでない状態）で実行すると git が monorepo に解決され、製品と無関係の
  # 既存コミットの author/message で誤 FAIL する。git ルートが製品ディレクトリ
  # 自身であることを検証し、そうでなければ明確なエラーで停止する。
  local repo_root prod_root
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  prod_root="$(cd "$SCRIPT_DIR/.." && pwd -P)"
  if [ -z "$repo_root" ] || [ "$(cd "$repo_root" && pwd -P)" != "$prod_root" ]; then
    echo "[public-gate] ERROR: git ルート($repo_root)が製品ディレクトリ($prod_root)と一致しません。" >&2
    echo "[public-gate] monorepo コンテキストでは author/message 検査が製品外の履歴に及ぶため実行できません。" >&2
    echo "[public-gate] 製品の git ルートで実行してください（nested repo 初期化後: 'ga new' が git init 済みの状態）。" >&2
    exit 2
  fi

  # 各チェックは失敗しても止めない(全漏洩を1回で洗い出す)。判定は GATE_FAIL に集約。
  check_authors  || true
  check_tree     || true
  check_gitleaks || true
  check_messages || true

  if [ "$GATE_FAIL" -ne 0 ]; then
    echo "[public-gate] FAIL: 公開前ゲート不合格。public 化を中止してください。" >&2
    exit 1
  fi
  echo "[public-gate] PASS: 公開前ゲート合格。" >&2
  exit 0
}
main "$@"
