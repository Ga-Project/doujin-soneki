"use client";

// 当日そなえの登録だけを行う（画面には何も出さない）。
// レイアウトに置いて全ページで走らせる: 検索から来てトップだけ見た人の端末にも
// 控えが要るため。状態表示は記帳画面（/tally）の useSonae が受け持つ。

import { useEffect } from "react";
import { registerSonae } from "./tally/useSonae";

export function SonaeRegister() {
  useEffect(() => {
    void registerSonae();
  }, []);
  return null;
}
