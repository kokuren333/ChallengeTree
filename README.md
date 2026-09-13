# Challenge Tree

Challenge Tree は、回答した内容に応じて次の学習ノードが開く、ローカルファーストの適応型学習アプリです。最初は1つのノードから始まり、回答後に次の3ノードを生成して学習を広げます。

Webアプリは [GitHub Pages版](https://kokuren333.github.io/ChallengeTree/) としてそのまま利用できます。ページの配信はGitHub Pagesから行いますが、AIによる調査・問題作成・採点は、利用者のPCで起動したローカルコネクタをブラウザから呼び出します。つまり、公開ページを使っても学習データとCodexへの接続はローカルファーストの構成です。

[English README](README.en.md)

## 主な機能

- 説明式（`explain`）：自由記述で1問に答える
- 短答式（`short_answer`）：単語・短い句・短文で答える3問
- 正誤式（`true_false`）：○か×だけで答える5問
- 模範解答と解説を問題ごとに生成・表示
- 回答履歴、採点結果、採点ログ、調査履歴を保存
- C / B / A / S の採点とXP。1度採点したノードは完了扱い
- ワークスペース単位のセーブデータ書き出し・読み込み
- ノードマップのパン・ズームと、回答後の右方向への3分岐展開
- Codex App Serverのモデル一覧取得と、モデルごとのreasoning effort選択

## 実際の操作例

日本語UIでTransformerスターターツリーの最初の問題に回答し、S判定後に次の3ノードを展開した例です。左に進捗、中央にノード構造、右に問題と採点結果が表示されます。

![Transformerの学習ツリーと採点結果](docs/transformer-learning-example.jpg)

## ローカルで動かす

### Webアプリ

```powershell
npm ci
npm run dev -- --host 127.0.0.1
```

ブラウザで表示するだけならコネクタは不要です。AIによるツリー生成・問題生成・採点には、別途Codex CLIをインストールして認証し、ローカルコネクタを起動してください。

### コネクタ

Node.js 18以降を使う場合は、依存関係なしで次を実行できます。

```powershell
node connector/server.js
```

Windows、macOS Intel、macOS Apple Silicon、Linux x64向けの実行ファイルは [`public/downloads/`](public/downloads/) にあります。コネクタはユーザーのCodex CLIを自動検出してApp Serverを起動します。Codex CLI自体は実行ファイルに含まれません。

既定値は次の通りです。

```text
host: 127.0.0.1
port: 43110
```

通常のGitHub Pages公開元とViteの開発ポートは既定で許可されます。別の開発元を使う場合だけ、明示的に追加します。

```powershell
$env:CHALLENGE_TREE_ALLOWED_ORIGINS = "http://127.0.0.1:5173"
node connector/server.js
```

### AI操作と検索

ツリー作成、ノード展開、問題生成、採点では、Codex自身のネイティブWeb検索の完了イベントを必須にしています。検索イベントが確認できなかった場合、結果は保存せず処理を失敗させます。コネクタ側のDuckDuckGoなどの代替検索は使用しません。

検索された語句、Codexが返した出典URL、検索ログは調査履歴としてワークスペースに保存されます。問題画面に表示する「読むべきソース」は、その問題またはノードに紐づいたリソースだけです。

## GitHub Pages版を使う・公開する

`vite.config.ts` は相対アセットパスを使うため、プロジェクトページ配下でも動作します。`.github/workflows/deploy.yml` は `main` へのpushまたは手動実行で、次を自動的に行います。

1. 4種類のポータブルコネクタを生成
2. Viteで静的サイトをビルド
3. `dist` をGitHub Pagesへデプロイ

公開済みのページは [https://kokuren333.github.io/ChallengeTree/](https://kokuren333.github.io/ChallengeTree/) です。初回利用時は、ページの「コネクタの使い方」からOSに合うコネクタをダウンロードして起動し、Codex CLIのインストール・認証を済ませてください。ページを開く場所がGitHub Pagesでも、コネクタは利用者のPC上で動作します。

このリポジトリを自分のGitHub Pagesで公開する場合は、Pages設定で公開元に **GitHub Actions** を選択してください。`.github/workflows/deploy.yml` が `main` へのpushまたは手動実行でサイトと各OS向けコネクタをビルドします。

## データとセキュリティ

- 学習データはブラウザのIndexedDBに保存します
- すべてのワークスペースを1つのJSONセーブデータとして書き出せます
- コネクタはloopback（`127.0.0.1` / `::1`）だけで待ち受けます
- セッショントークンは起動ごとに変わり、ファイルには保存しません
- Codexの資格情報、回答本文、検索履歴をコネクタのファイルへ保存しません
- ブラウザのOriginは明示的なallowlistで検証します

## 仕様の詳細

- [コネクタの使い方（日本語）](connector/README.md)
- [Connector guide (English)](connector/README.en.md)
- [SPEC.md](SPEC.md)
- [GitHub Pages workflow](.github/workflows/deploy.yml)

## ライセンス

このプロジェクトは [MIT License](LICENSE) で公開しています。
