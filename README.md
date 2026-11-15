# サカナクション Discord通知Bot（GitHub Actions版）

公式サイトNEWS・LIVE情報・YouTube・Xを確認し、新着を5つのDiscord Webhookへ振り分けて通知します。GitHub Actionsで5分ごとに1回実行するため、自宅PCを起動し続ける必要はありません。

## 先に知っておくこと
- GitHub Actionsのスケジュール実行は混雑時に遅れることがあります。必ず5分ちょうどに実行される保証はありません。
- 公開リポジトリで使う想定です。Webhook URLやX APIトークンは絶対にコードへ書かず、GitHub Actions Secretsへ登録してください。
- X監視にはX APIのBearer Tokenが必要です。利用条件・料金・レート制限はX側で確認してください。未設定ならX監視はスキップします。
- YouTube監視にはチャンネルIDが必要です。
- 初回実行では既存投稿を履歴に登録し、過去投稿の大量通知を防ぎます。
- 公式サイトのHTML構造変更などでNEWS/LIVE取得部分の調整が必要になることがあります。

## GitHubへのアップロード
1. GitHubで新しいリポジトリを作成します。公開（Public）にしてください。
2. このフォルダ内のファイルをすべてリポジトリの直下へアップロードします。`.env` はアップロードしないでください。
3. `Settings → Secrets and variables → Actions` を開きます。
4. `Secrets` に次の名前でWebhook URLを1つずつ登録します。
   - `DISCORD_WEBHOOK_NEWS`
   - `DISCORD_WEBHOOK_X`
   - `DISCORD_WEBHOOK_YOUTUBE`
   - `DISCORD_WEBHOOK_LIVE`
   - `DISCORD_WEBHOOK_OFFICIAL`
5. X APIを使う場合は `X_BEARER_TOKEN` もSecretに登録します。
6. `Variables` に `YOUTUBE_CHANNEL_ID` を登録します。
7. `Actions` タブでワークフローが有効になっていることを確認します。`Sakanaction Discord Notifications` を選び、`Run workflow` で手動テストできます。

## 通知履歴について
通知済みURLやYouTube動画ID、Xのsince_idを `data/state.json` に保存し、Actionsが実行されるたびにGitHubへコミットします。履歴ファイルにはWebhook URLやAPIトークンは保存しません。

## 通知先
- NEWS → `DISCORD_WEBHOOK_NEWS`
- LIVE / TOUR → `DISCORD_WEBHOOK_LIVE`
- YouTube → `DISCORD_WEBHOOK_YOUTUBE`
- X → `DISCORD_WEBHOOK_X`
- 一部の重要そうなNEWS → `DISCORD_WEBHOOK_OFFICIAL` にも重複通知

`official` の分類キーワードは `index.js` 内で調整できます。
