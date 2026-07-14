# 通信診断 PWA プロトタイプ

Swift版 `ProbeEngine.swift` のブラウザ移植。完全クライアントサイドで動作し、維持費は0円。

## 構成

| ファイル | 役割 | Swift版との対応 |
|---|---|---|
| `probe-engine.js` | 段階プローブ + 決定木判定 | `Probes` / `DiagnosisEngine` / `ProbeEngine` |
| `index.html` | デバッグUI（後で可視化ビューに差し替え） | `ProbeDebugView` |
| `sw.js` | Service Worker（オフライン起動） | — |
| `manifest.json` / `icon-*.png` | PWA設定 | — |

## ローカルでの動かし方（Windows）

```
cd netdiag-pwa
python -m http.server 8000
```

ブラウザで http://localhost:8000 を開く（Service Workerはlocalhostなら動作する。
`file://` では動かないので必ずローカルサーバ経由で開くこと）。

## 無料公開（GitHub Pages）

1. GitHubで新規リポジトリを作成（Public）
2. このフォルダの中身をリポジトリ直下にpush
3. Settings → Pages → Source を「main / (root)」にして保存
4. 数分後 `https://<ユーザ名>.github.io/<リポジトリ名>/` で公開される（HTTPS・無料）

iPhoneではSafariでそのURLを開き、共有 → **ホーム画面に追加**。
以降はアプリのように起動でき、**初回アクセス後は完全オフラインでも開ける**。

## 維持費が0円である根拠

- ホスティング: GitHub Pages（無料・静的サイト）
- サーバサイド処理: なし（診断・判定・描画はすべて端末内で完結）
- プローブ先: Cloudflareの公開計測エンドポイント（無料）

### プローブ先を自前にしたい場合（これも無料）

公開エンドポイントの仕様変更に備えるなら、Cloudflare Workers（無料枠: 10万リクエスト/日）で
数行のエンドポイントを立てられる:

```js
export default {
  async fetch() {
    return new Response("ok", {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Timing-Allow-Origin": "*",
        "Cache-Control": "no-store",
      },
    });
  },
};
```

デプロイ後、`index.html` 側で差し替える:

```js
const engine = new NetDiag.Engine({ probeUrl: "https://xxx.<名前>.workers.dev/" });
```

## プライバシーとセキュリティ

- サーバを持たない静的サイトで、利用者のデータを収集・送信する仕組みは無い
- 診断記録（CSV）は端末のlocalStorageのみに保存され、外部には送信されない
- 計測時にCloudflare・Google・jsDelivrへ小さなHTTPリクエストを送る
  （通常のWeb閲覧と同程度。相手には他のWebアクセス同様にIPアドレスが見える）
- 配信はGitHub PagesのHTTPS。リポジトリは公開だが、書き込めるのは所有者のみ
- ユーザ実験で使う場合は、上記（外部送信なし）を説明文書に明記できる

## 詳細診断（二段構え）

初回診断が「遅い/不安定」の時だけ「詳しく調べる」ボタンが現れる。
追加で最大約2MB・約10秒の計測を行い、「遅い」を4方向に切り分ける:

| 判定 | 根拠 |
|---|---|
| 回線が飽和（誰かが使用中） | 負荷をかけた時だけRTTが3倍以上に膨らむ（バッファブロート） |
| 速度制限の可能性（ギガ切れ等） | 実効速度が300kbps未満 |
| 自分の回線全体が遅い / 単に遠い | 運営主体の異なる3計測先が全て遅い（帯域が太ければ「遠い」） |
| 相手サーバ側が遅い | 特定の計測先だけ遅い、または接続は速いのに応答待ちだけ長い |

しきい値は `probe-engine.js` の `THRESHOLDS` で調整できる。
判定ロジックは `NetDiag._internals.diagnoseDeep` としてエクスポートしてあり、
Node.jsで単体テストできる。

## テスト方法（悪環境の再現）

Chrome DevTools → Network タブ → スロットリングで「Slow 3G」「Offline」等を選び、
各診断分岐（オフライン / 不安定 / 遅い / 正常）が出ることを確認する。
※DevToolsのスロットリングはfetchの見かけ速度のみ変えるため、損失・揺らぎの再現には
Windowsなら [clumsy](https://jagt.github.io/clumsy/)（無料）でパケット損失・遅延を注入すると本物に近い。

## ブラウザ版の既知の制約（論文の限界節に書ける内容）

- 回線種別（Wi-Fi/セルラー、5G/LTE）と電波強度は取得不可（iOS Safari）
- DNS失敗とTCP失敗の区別は不可。内訳は「所要時間」として取得（Timing-Allow-Origin必須）
- 2回目以降の診断ではTCP接続が再利用され、DNS/TCP/TLS内訳が0になることがある
  （エンジンは「接続を再利用」と表示して区別する）
- `navigator.onLine` は「LANにつながっているか」しか見ておらず過信できない
- キャプティブポータル検出は間接推定（主要先だけ失敗し予備に到達、等）
