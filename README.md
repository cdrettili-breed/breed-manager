# Breed Manager

レオパの繁殖・在庫・販売をiPhoneで管理する台帳アプリ（ホーム画面に追加して使うWebアプリ）。

- `docs/` … アプリ本体（GitHub Pages で https://cdrettili-breed.github.io/breed-manager/ に公開）
  - `index.html` 画面と台帳の処理
  - `runtime.js` iPhone内の保存・Claude API・印刷・Dropboxバックアップ
  - `sw.js` 通信がなくても動く仕組みと自動更新（公開のたびに VERSION を上げる）
- `dev/serve.ps1` … PCで動作確認するための簡易サーバー（`powershell -File dev/serve.ps1 -Root docs`）
- `leopa-ledger.html`, `catalog/` … 以前の claude.ai 版の台帳と卸カタログ（参考用）

台帳のデータとAPIキーはこのリポジトリには含まれず、各自のiPhoneの中にだけ保存されます。
