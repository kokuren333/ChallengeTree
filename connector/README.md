# Challenge Tree portable local connector

[English guide](README.en.md)

これは GitHub Pages 上の Challenge Tree と、ユーザーのローカル Codex App Server の間に置く、依存なしの HTTP/SSE コネクタです。Node.js の標準ライブラリだけで動作します。

## 現在の範囲

`server.js` と `codex-app-server-client.js` は次の境界を担当します。

- localhost への HTTP 待受
- 許可オリジンの厳密な照合
- 起動ごとに生成する一時セッショントークン
- ジョブのキュー、キャンセル、SSE イベント配信
- Challenge Tree の高レベル AI 操作5種の許可
- Codex CLI の検出、起動、再接続、終了処理
- 生成済み App Server プロトコルに基づく JSONL request/response 相関
- `initialize`、認証状態確認、`model/list` による選択モデルと reasoning effort の可用性確認
- `ANSWER_GRADE` の実ターン実行と strict JSON output schema の1回修復
- すべてのAI操作でCodexネイティブWeb検索の実行を要求し、返却された検索語・出典URL・検索ログを結果 envelope に含める処理

許可される操作は次の5つだけです。

```text
TREE_PROPOSE
NODE_EXPAND
NODE_CREATE
CHALLENGE_CREATE
ANSWER_GRADE
```

任意の shell 実行、任意ファイル書き込み、任意の Codex コマンド転送は公開していません。App Server は `shell:false` で直接起動し、スレッドは `approvalPolicy: "never"`、`sandbox: "read-only"` で作成します。App Server から承認やツール実行の要求が来た場合も自動許可せず拒否します。

## 起動

Node.js 18 以降を推奨します。依存関係のインストールは不要です。

```powershell
node connector/server.js
```

起動時の `/v1/status` で、CLI の有無、App Server の稼働、認証、モデル可用性、CLI/App Server のバージョン、直近のエラーを確認できます。ブラウザ画面の接続診断にも同じ状態を表示します。

Codex CLI は、明示的な `CHALLENGE_TREE_CODEX_PATH`、現在の PATH、OSごとの一般的な配置（`~/.local/bin`、`~/bin`、macOS の Homebrew、Linux の `/usr/local/bin`・`/usr/bin` など）、npm のグローバル bin の順で探します。デスクトップショートカットから起動して PATH が十分に引き継がれない場合も、標準的な配置なら自動検出できます。特殊な場所へインストールしている場合だけ、実体への絶対パスを明示してください。

既定値は次の通りです。

```text
host: 127.0.0.1
port: 43110
allowed origins: GitHub Pages + localhost:5173/4173
```

GitHub Pages と一般的な Vite 開発ポートは既定で許可されます。その他の公開元を使う場合だけ、明示的に追加してください。`*` は使用できません。

```powershell
$env:CHALLENGE_TREE_ALLOWED_ORIGINS = "http://localhost:5173,http://127.0.0.1:5173"
$env:CHALLENGE_TREE_PORT = "43110"
node connector/server.js
```

`CHALLENGE_TREE_HOST` は `127.0.0.1` または `::1` だけを受け付けます。`0.0.0.0`、LAN アドレス、任意の外部 bind は許可しません。起動時に標準エラーへ表示されるトークンは保存せず、再起動ごとにローテーションします。

## HTTP API

`/v1/status` 以外は、次のいずれかで一時トークンを送ります。

```http
Authorization: Bearer <ephemeral-token>
```

または

```http
X-Challenge-Tree-Token: <ephemeral-token>
```

### `GET /v1/models`

Codex App Server の利用可能なモデル一覧を返します。各モデルの `supportedReasoningEfforts` と、現在選択中の `selectedModel` も含まれます。Web UI の設定画面はこのAPIを使います。

### `POST /v1/settings/model`

利用可能なモデルと reasoning effort を選択します。選択はコネクタの実行中プロセスに反映され、以後のChallenge TreeのAIターンで使われます。`reasoningEffort` は省略可能で、そのモデルの既定値が使われます。

```json
{
  "model": "gpt-5.5",
  "reasoningEffort": "medium"
}
```

Web UIの選択値はブラウザに保存され、コネクタ再起動後はWeb UIが再接続時に再適用します。`CHALLENGE_TREE_CODEX_MODEL` は起動時の初期モデルを指定するための任意の上書きです。

### `GET /v1/status`

許可オリジンからの状態確認はトークン不要です。レスポンスに起動中だけ有効な `token` を含めます。Web UI はこのトークンをメモリ上だけで保持し、再起動時には無効になります。

### `POST /v1/jobs`

Content-Type は `application/json` とし、ボディは操作 envelope のみ受け付けます。

```json
{
  "operation": "TREE_PROPOSE",
  "protocolVersion": 1,
  "requestId": "optional-client-id",
  "payload": {
    "topic": "Transformer",
    "goal": "技術論文を説明できるようになる",
    "researchMode": "global"
  }
}
```

成功時は `202 Accepted` と `jobId`、`eventsUrl` を返します。操作名は小文字の Challenge Tree 表記（`tree_propose` など）を受け付けます。

### `GET /v1/jobs/:id/events`

SSE のイベントストリームです。`Authorization` または `X-Challenge-Tree-Token` ヘッダーを付け、必要なら `Last-Event-ID` で再接続します。ブラウザ標準の `EventSource` は任意ヘッダーを付けられないため、Web UI は `fetch` のストリーミングレスポンスを使う設計にしてください。トークンを URL query に入れる方式は採用していません。

主なイベント名は次の通りです。内部のジョブイベントはブラウザ向けにこの短い名前へ正規化されます。

```text
status
progress
result
error
done
```

### `POST /v1/jobs/:id/cancel`

トークンを付けてジョブをキャンセルします。キャンセル済み・完了済みのジョブに対しては状態を変更しません。

## セキュリティ上の前提

- 待受は loopback のみです。認証・SSE を含む通信は同一マシン内で行います。
- ブラウザの `Origin` は完全一致の allowlist で検証します。
- ジョブ作成、イベント購読、キャンセルには一時トークンが必要です。
- トークン、回答本文、Codex の資格情報をファイルへ保存しません。
- JSON body と SSE event にはサイズ上限があります。
- ジョブはメモリ上だけに保持し、完了後は一定時間で破棄します。
- import/save の JSON や AI 入力を実行可能なものとして扱いません。

## App Server プロトコル

`protocol/generated/` と `protocol/schema/` は、インストール済み Codex CLI の次のコマンドから生成した成果物です。

```powershell
codex app-server generate-ts --experimental --out protocol/generated
codex app-server generate-json-schema --experimental --out protocol/schema
```

実装で使う初期化シーケンスは次の通りです。

```text
initialize
initialized
getAuthStatus
model/list
thread/start
turn/start
item/agentMessage/delta / item/completed
turn/completed
```

実ブリッジは `TREE_PROPOSE`、`NODE_EXPAND`、`NODE_CREATE`、`CHALLENGE_CREATE`、`ANSWER_GRADE` の5操作を Codex App Server へ転送します。各ターンにはネイティブWeb検索を必須とする指示を付け、Codexが実際に返した `webSearch` 完了イベントをターンに結合して検証します。検索イベントを確認できない場合はAI結果を返さず、保存も行いません。成功時の結果は `{ data, research }` envelope で、`research` にCodexが返した検索語・出典URL・検索ログが含まれます。JSONスキーマ検証に失敗した場合は1回だけ修復ターンを実行します。Challenge Tree の XP、unlock、保存状態などのゲームロジックはコネクタへ移しません。
