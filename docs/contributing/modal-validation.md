# Modal CPU validation

Modal は独立したテスト群を Linux コンテナへ分散する検証用の実行先です。実装エージェントの LLM 利用枠を増やす仕組みではありません。ローカルの検証と結果を比較し、実測した待ち時間と費用に応じて並列数を増やします。

## 実行

Modal SDK を認証した環境で、リポジトリのルートから実行します。

```sh
node tools/modal/launch.mjs --shards 16 --output .build/modal/validation-16
```

`launch.mjs` はソースの allowlist、manifest と shard 計画を用意し、`tools/modal/app.py` を `modal run` で実行します。内部では絶対パスの `EDGE_MODAL_STAGE` と `EDGE_MODAL_OUTPUT` を渡します。常駐 deployment は作成しません。認証が未設定の環境では、先に `modal setup` を実行します。

対象は汎用68ファイルの `portable-unit-v1` と、FLAC 32ファイルの `flac-unit-v1` です。Native FFmpeg を必要とする差分テスト、Workers 全体、全コーデックのビルドをこのコマンドですべて検証したとは扱いません。結果の成功・失敗は各実行の成果物で確認してください。この文書自体はクラウド実行成功の証拠ではありません。

FLAC の検証は次のコマンドで実行します。

```sh
node tools/modal/launch.mjs --suite flac-unit-v1 --shards 16 --output .build/modal/flac-next
```

## 初期の実行枠

初期値は最大 16 コンテナ、各コンテナ CPU 2 cores、メモリ 4,096 MiB、各入力の timeout 900 秒です。同じコンテナで複数の CPU 負荷の高いテストを重ねず、テストファイルを分割して `Function.map()` に渡します。入力ごとの結果を集めて、失敗を全体の成功として扱わないようにします。

`app.py` は `cpu=(2, 2)`、`memory=(4096, 4096)`、`max_containers=16` を設定し、入力の自動 retry は 0 です。16 コンテナを越える拡張や再実行は、失敗原因と最初の実測結果を確認した上で行います。

`max_containers` は同時コンテナ数の上限で、料金の金額上限ではありません。CPU とメモリは request または実使用の大きい方が課金対象になります。厳密なリソース上限には request と limit の両方を指定します。Image の初回ビルド、依存取得、コンテナ起動、結果取得にも時間がかかるため、テスト時間だけで高速化率を計算しません。

並列数を増やす前に、同じソースの逐次実行と比較して、総経過時間、各 shard の実行時間、初回ビルドとキャッシュ利用時の時間、実際の課金を記録します。契約側の CPU 枠や Modal 側の空き状況により、設定した数が直ちに起動するとは限りません。

## ソースと結果

アップロード対象は検証用スナップショットに限定します。ホームディレクトリ、Modal 認証情報、`.env`、Git 認証、Hermes/Codex の設定、ローカルのログを丸ごと Image に含めません。実行時の認証はローカルの Modal SDK に任せます。検証コンテナに LLM の API キーを渡す必要はありません。

スナップショットは対象ファイルの SHA-256 と実行計画を保持し、各 shard は同じスナップショットを使います。Image の依存インストール前に必要なファイルは `Image.add_local_dir(..., copy=True)` でビルドレイヤーへ取り込みます。既定の `add_local_dir` は実行時マウントなので、後続の Image ビルドコマンドから使う場合は区別が必要です。

結果にはソース識別子、テスト一覧、終了コード、時間、実行 OS/CPU、Node および依存バージョンを残します。非ゼロ終了、timeout、欠落した shard、結果形式の不一致はいずれも失敗です。クラウドで起動できたことと、互換性テストが成功したことを分けて記録します。

## Native FFmpeg の参照結果

Darwin arm64 の既存バイナリや既存の golden データを、Linux 用の証拠へ書き換えません。コンパイラ、CPU 命令、浮動小数点の fused/separate arithmetic によってバイト単位の結果が異なるためです。

Linux 用の参照を増やす場合は、対象の FFmpeg commit、ビルド設定、コンテナ image digest、コンパイラと CPU、`-cpuflags`、実行引数、入力と出力のハッシュを独立して保存します。既存の `compat/reference-container.lock.json` と Linux 参照ビルドを利用できるか確認し、別のイメージを使った場合は同一環境だと表示しません。Darwin 固有の期待値が Linux で失敗したときも、自動で期待値を更新したり許容誤差を追加したりしません。

この実行先を追加しても、設計全体の適合認定や Linux での完全な再現性が成立したことにはなりません。

## 公式資料

- [Functions: runtime と autoscaling](https://modal.com/docs/guide/functions)
- [CPU・メモリの request、limit、課金](https://modal.com/docs/guide/resources)
- [Function.map と入力制限](https://modal.com/docs/guide/function-invocation-methods)
- [Image のローカルファイル取り込み](https://modal.com/docs/guide/modal-1-0-migration)
- [実行ログとリソースメトリクス](https://modal.com/docs/guide/developing-debugging)

## 初回実測（2026-11-23）

Modal Linux x64 / Node v24.22.3 / Vitest 5.1.1 で、汎用51ファイル・213テストとFLAC 25ファイル・724テストがそれぞれ全件成功しました。FLACは固定ソースSHA `f5bbcb9b809ae72d5d88b729f0696e89b302d3325a19dca519dbc1b51fb5da11` を共用した比較です。

| FLAC実行計画 | map開始から結果集約まで | 成功テスト | 観測された同時入力数の最大 |
|---|---:|---:|---:|
| 1 shard | 14.60秒 | 724 | 1 |
| 16 shards | 9.15秒 | 724 | 12 |

この1回の比較では約1.60倍です。イメージビルド・アップロード前後を含む全工程の倍率ではなく、ローカルMacとの速度比較でもありません。16分割のCLI全経過時間は17.06秒でした。初回イメージ構築時間や料金は別途必要で、実際の課金額は未取得です。汎用の最終実行も16分割、同時12コンテナで213件成功しました。以前のFLAC結果の `containerCount: 1` は共通hostnameを数えた計測不備で無効です。以後はModal task IDを記録します。

成果物は `.build/modal/flac-16`、`flac-1`、`portable-16-v3` にあります。初回のPythonモジュール転送漏れと、汎用テストの共有ヘルパー転送漏れによる失敗は、`initial-16` と `portable-16-v2` に保存しています。失敗を消したり、テストをskipして成功扱いにはしていません。

現在の対象は短い単体テストです。Native参照ビルド、大規模差分テスト、Workers全体、実装エージェントの自動投入は別途対応が必要です。設計全体の完成時期をこの測定から推定しません。

時間指定＋フィルタ実装の追加後、`flac-unit-v1` は26ファイル・741テストに拡張され、`.build/modal/timed-filters` の実クラウド実行で全件成功しています。上の初回比較値は拡張前の固定スナップショットの値です。

圧縮コピーの時間制限追加後は27ファイル・769テストです。`.build/modal/copy-duration` の16分割実行で全件成功しました。

時間指定とレート変更の併用追加後は28ファイル・782テストです。`.build/modal/timed-rate` の16分割実行で全件成功しました。

時間指定とaformat単一形式変換の追加後は29ファイル・802テストです。`.build/modal/timed-aformat` の16分割実行で全件成功しました。

単一aformatとレート変更の組み合わせ追加後は30ファイル・815テストです。
`.build/modal/aformat-rate` の16分割Linux実行で815/815成功しました。
実際のピーク同時実行は10コンテナです。Native差分やリモートWorkers全体の認証ではありません。

同一レート・レイアウトのaformat制約追加後は31ファイル・839テストです。
`.build/modal/aformat-constraints` と `aformat-constraints-portable` の各8分割で、
FLAC839/839・汎用213/213が成功しました。各実行のピークは8コンテナです。
共有フィルタの型・制約検証を含むLinux単体検証であり、新規Linux Native実測や
リモートWorkers実行を意味しません。

時間指定と有限apad/asetnsamplesの組み合わせ追加後は32ファイル・842テストです。
`.build/modal/timed-buffered` の16分割Linux実行で842/842成功しました。
実際のピークは5コンテナです。時刻指定／フレーム境界のNative差分は別途
ローカルの固定参照とNode・R2/workerdで検証しています。

永続ジョブのスカラー状態機械と仕様作成を追加した汎用スイートは53ファイル・244テストです。
`.build/modal/durable-media-jobs` の16分割Linux実行で244/244成功、実ピーク9コンテナでした。
DO・Queue・R2を使う実行器テストはこの許可リストに含めず、ローカルworkerdで別途実行します。
ランナー安全性テストは新しい許可リスト検証を含め14/14成功しました。

明示的なWorkflows DAGのプランナー・入力固定を追加した汎用スイートは55ファイル・269テストです。
今回の16分割実行は269/269成功、実測最大15入力が同時実行されました。
実際のWorkflows/Queue/SQLite/R2統合テストはローカルworkerdで別途検証しています。

Workflow全体のキャンセル制御・所有権フェンスを追加した汎用スイートは57ファイル・289テストです。
今回の16分割実行は289/289成功、実測最大7入力の同時実行でした。

独立グラフ分割・既存プランナー検証・Workflow接続を含む汎用スイートは60ファイル・343テストです。
16分割実行は343/343成功、実測最大16入力が同時実行されました。

型付き直列グラフからのコマンド生成を追加した汎用スイートは62ファイル・410テストです。
16分割実行は410/410成功、実測最大15入力が同時実行されました。
Native比較2件と実際のWorkflow統合テストは別途ローカルで検証しています。

動画DAGの分岐・結合・複数出力loweringを追加した汎用スイートは64ファイル・447テストです。
最終16分割実行は447/447成功、実測最大16入力が同時実行されました。
追加2件前の445テスト実行も成果物を保持しています。

実行Checkpointメタデータと音声FIFO状態復元を含む汎用スイートは66ファイル・542テストです。
16分割実行は542/542成功、実測最大11入力が同時実行されました。
実Worker再起動・R2復元とNative PCM/PTS比較は別途ローカルで検証しています。

Checkpoint状態・出力チャンクの確定ジャーナルを含む汎用スイートは68ファイル・586テストです。
16分割実行は586/586成功、実測最大13入力が同時実行されました。
実SQLite/R2の応答喪失・再起動復元とNative比較は別途ローカルで検証しています。
