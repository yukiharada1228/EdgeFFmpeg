# EdgeFFmpeg — 詳細開発設計書

**文書ID：** EFF-DESIGN-001  
**バージョン：** 1.0 Draft  
**作成日：** 2026-11-20  
**言語：** TypeScript / WebAssembly  
**実行環境：** Cloudflare Workers  
**互換対象：** FFmpeg 9.0.2（固定リファレンスビルド）  
**プロジェクト形態：** Open Source Software

---

## 1. プロジェクト概要

### 1.1 目的

EdgeFFmpegは，FFmpegとの完全互換性を最終目標とする，TypeScriptベースのメディア処理ライブラリである．

Cloudflare Workers上でFFmpegと互換性のあるコマンドを実行し，動画・音声・字幕・メタデータの解析，変換，エンコード，デコード，フィルタリング，ストリーミングを実現する．

FFmpeg本体の実行，ネイティブOSプロセス，外部トランスコードサーバーには依存しない．

### 1.2 最終目標

1. FFmpegのCLI構文と実行意味論を再現する．
2. FFmpegの対応コーデック，コンテナ，フィルタ，プロトコルを実装する．
3. 対象となる参照ビルドとの機能的・数値的・可能な範囲でバイナリ的な互換性を達成する．
4. Cloudflare Workersの実行制約に適合する．
5. TypeScriptを主要な実装・公開API言語とする．
6. 必要な処理にはFFmpeg非依存のWebAssemblyを利用できる．
7. FFmpegの上流更新に追従できる自動検証基盤を提供する．
8. 単体のWorkerと，複数Workerによる分散実行を両方サポートする．

開発工数を理由とした機能の恒久的な除外は行わない．

### 1.3 互換性の基本方針

互換性は以下の単位で管理する．

| 互換性分類 | 判定対象 |
|---|---|
| CLI互換 | 引数，オプション，スコープ，終了コード |
| API互換 | 公開TypeScript APIの定義済み動作 |
| 形式互換 | コンテナ，コーデック，ピクセル形式など |
| 意味論互換 | ストリーム選択，タイムスタンプ，フィルタグラフ |
| 数値互換 | デコード結果，画像変換，音声処理 |
| バイナリ互換 | 対象条件での生成バイト列 |
| エラー互換 | 不正入力時の失敗条件，診断結果 |
| 実行環境互換 | OS，プロトコル，ハードウェア依存挙動 |

個々の機能は `unimplemented`，`partial`，`conformant`，`bitexact`，`runtime-blocked` の状態で管理する．

完全互換の宣言には，固定した参照構成と対象条件の明示が必要である．

### 1.4 互換性保証の境界

FFmpegの機能はビルド時設定に依存するため，全ビルドの和集合を一つの互換対象とはしない．

初期基準はFFmpeg 9.0.2の固定したリファレンスビルドとし，次を記録する．

- Upstream Git commit SHA
- コンパイラとビルド環境
- configure flags
- 有効な外部ライブラリ
- エンコーダ・デコーダ一覧
- Demuxer・Muxer一覧
- Filter一覧
- Protocol一覧
- Hardware acceleration一覧
- 実行環境とテストデータ

FFmpeg 9.0.2への互換性達成後は，上流の新しいバージョンを別の互換性ターゲットとして追加する．

---

## 2. 技術スタック

| 領域 | 採用技術 |
|---|---|
| メイン言語 | TypeScript（strict） |
| 高性能演算 | WebAssembly SIMD |
| モジュール形式 | ESM |
| パッケージ管理 | npm Workspaces |
| ビルド | TypeScript / esbuild |
| 単体テスト | Vitest |
| Workers統合テスト | Wrangler / Miniflare |
| CI/CD | GitHub Actions |
| 参照実装 | FFmpeg 9.0.2 |
| 回帰テスト | FATE + Differential Testing |
| オブジェクト保存 | Cloudflare R2 |
| ジョブ配送 | Cloudflare Queues |
| 長時間処理の制御 | Cloudflare Workflows |
| 排他・状態調整 | Durable Objects（必要時） |
| パッケージ公開 | npm |
| APIドキュメント | TypeDoc |

TypeScriptの型，ESM，Web Streams，TypedArray，AsyncIterableを基本抽象とする．

Node.js固有APIをCoreに直接持ち込まない．

---

## 3. リポジトリ構成

```text
edge-ffmpeg/
├── upstream/
│   └── ffmpeg/                 # Git submodule
│
├── packages/
│   ├── core/
│   ├── cli/
│   ├── avutil/
│   ├── avformat/
│   ├── avcodec/
│   ├── avfilter/
│   ├── avdevice/
│   ├── swscale/
│   ├── swresample/
│   ├── codecs/
│   ├── containers/
│   ├── protocols/
│   ├── wasm/
│   ├── runtime-cloudflare/
│   ├── runtime-node/
│   ├── storage-r2/
│   └── distributed/
│
├── compat/
│   ├── upstream.lock.json
│   ├── configure.flags
│   ├── capabilities.json
│   ├── behavior-specs/
│   ├── known-differences/
│   └── reports/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── differential/
│   ├── fate/
│   ├── fuzz/
│   ├── security/
│   ├── performance/
│   └── workers/
│
├── tools/
│   ├── upstream-build/
│   ├── extract-capabilities/
│   ├── fate-adapter/
│   ├── differential-runner/
│   ├── compatibility-report/
│   └── upstream-sync/
│
├── examples/
│   ├── basic-transcode/
│   ├── r2-transcode/
│   ├── audio-extraction/
│   ├── distributed-video/
│   └── streaming/
│
├── docs/
│   ├── architecture/
│   ├── compatibility/
│   ├── codecs/
│   ├── runtime/
│   └── contributing/
│
├── .github/workflows/
├── package.json
├── tsconfig.json
├── wrangler.jsonc
├── LICENSE
└── README.md
```

各パッケージは独立してテスト可能にし，依存関係は循環させない．

---

## 4. Upstream FFmpegの管理

### 4.1 Git Submodule

公式FFmpegを`upstream/ffmpeg`に配置する．

```bash
git submodule add \
  https://git.ffmpeg.org/ffmpeg.git \
  upstream/ffmpeg

cd upstream/ffmpeg
git checkout n9.0.2

cd ../..
git add .gitmodules upstream/ffmpeg
git commit -m "chore: pin upstream FFmpeg 9.0.2"
```

Submoduleは正確なコミットを記録する．リリースタグが同じでも，CIではそのコミットの検証を必須とする．

### 4.2 Upstream Lock

`compat/upstream.lock.json`に以下を記録する．

```json
{
  "project": "FFmpeg",
  "version": "9.0.2",
  "tag": "n9.0.2",
  "commit": "<resolved-40-char-sha>",
  "source": "https://git.ffmpeg.org/ffmpeg.git",
  "referenceBuild": "ffmpeg-9.0.2-linux-x86_64",
  "configureFile": "compat/configure.flags",
  "capabilityManifest": "compat/capabilities.json"
}
```

コミットSHAは初期化時に実際のGitオブジェクトから取得し，固定する．

外部ライブラリを使う参照ビルドでは，そのバージョンとビルド成果物のハッシュも固定する．

### 4.3 Capability Manifest

参照ビルドの次のコマンドから機能一覧を取得する．

```bash
ffmpeg -version
ffmpeg -buildconf
ffmpeg -formats
ffmpeg -codecs
ffmpeg -encoders
ffmpeg -decoders
ffmpeg -filters
ffmpeg -protocols
ffmpeg -pix_fmts
ffmpeg -sample_fmts
ffmpeg -hwaccels
```

抽出結果から一意の機能IDを生成する．

```json
{
  "id": "codec.decoder.h264",
  "kind": "decoder",
  "upstream": "9.0.2",
  "implementation": "unimplemented",
  "runtime": "cloudflare",
  "testCases": [],
  "compatibility": {
    "functional": false,
    "bitexact": false
  }
}
```

これを実装進捗と互換性検証の共通データベースとする．

---

## 5. アーキテクチャ

### 5.1 レイヤー

システムは次の7層で構成する．

1. **Compatibility API**：FFmpeg互換コマンドの公開API
2. **CLI Frontend**：FFmpegの引数構文とオプション処理
3. **Execution Planner**：ストリーム選択・フィルタグラフ・依存関係解決
4. **Media Engine**：Demux，Decode，Filter，Encode，Mux
5. **Runtime Abstraction**：メモリ・スケジューラ・時刻・I/O・Wasm
6. **Cloudflare Adapter**：Workers，R2，Queues，Workflows
7. **Conformance Layer**：参照動作の検証，診断，互換性報告

### 5.2 設計上の不変条件

- メディアのPTSとDTSは変換時に意味を失わないこと．
- タイムベースは有理数として扱うこと．
- 通常の処理経路で入力ファイル全体をメモリに展開しないこと．
- 各オペレータはバックプレッシャーに従うこと．
- 入力データは信頼できないものとして扱うこと．
- Runtime固有の機能をCoreに漏らさないこと．
- 未対応機能を互換動作として偽装しないこと．
- 出力確定前の障害に対して，副作用を検出・回復できること．
- コンテナ処理とコーデック処理を独立した単位にすること．
- 互換性を主張する全機能に参照テストを関連付けること．

---

## 6. Coreデータモデル

### 6.1 時間表現

FFmpegにおけるタイムスタンプは，整数値と有理数のタイムベースによって解釈される．

JavaScriptの`number`だけでは64-bit整数の精度を保証できないため，`bigint`を採用する．

```typescript
export interface Rational {
  num: bigint;
  den: bigint;
}

export interface Timestamp {
  value: bigint;
  timeBase: Rational;
}

export interface MediaPacket {
  streamIndex: number;
  data: Uint8Array;
  pts: bigint | null;
  dts: bigint | null;
  duration: bigint | null;
  timeBase: Rational;
  flags: number;
}
```

### 6.2 フレーム表現

```typescript
export interface VideoFrameData {
  width: number;
  height: number;
  pixelFormat: string;
  planes: Uint8Array[];
  linesizes: number[];
  pts: Timestamp | null;
  metadata: Record<string, unknown>;
}

export interface AudioFrameData {
  sampleRate: number;
  channels: number;
  channelLayout: string;
  sampleFormat: string;
  samples: number;
  planes: Uint8Array[];
  pts: Timestamp | null;
}
```

実装ではメモリの所有権を明示し，コピー，参照，共有バッファ，解放の状態を管理する．

フィルタやデコーダ間でフレームを受け渡す際には，不必要なメモリコピーを避ける．

### 6.3 リソース制御

各実行コンテキストに`ResourceBudget`を設ける．

```typescript
export interface ResourceBudget {
  maxResidentBytes: number;
  maxBufferBytes: number;
  maxCpuTimeMs: number;
  maxPendingPackets: number;
}

export interface ExecutionContext {
  budget: ResourceBudget;
  signal: AbortSignal;
  allocate(bytes: number): Uint8Array;
  checkpoint(): Promise<void>;
}
```

単一isolateの128 MB制限は，JavaScriptヒープとWasmの割り当てを合算した制約として扱う．

独自アロケータで管理できないランタイム内部のメモリも存在するため，予算管理は実際のメモリ計測と組み合わせる．

---

## 7. FFmpeg CLI互換レイヤー

### 7.1 目的

`ffmpeg`コマンドの構文，オプションのスコープ，デフォルト値，処理順序を再現する．

単なる引数パーサではなく，FFmpegの意味論を持つフロントエンドとして設計する．

### 7.2 CLI処理段階

```text
argv
  ↓
Lexical Parsing
  ↓
Option Classification
  ↓
Global / Input / Output Contexts
  ↓
Stream Selection
  ↓
Codec / Filter Resolution
  ↓
Execution Graph
  ↓
Runtime Scheduler
```

### 7.3 必須仕様

- グローバルオプション
- 入力ファイル単位のオプション
- 出力ファイル単位のオプション
- オプションの順序依存性
- 複数入力・複数出力
- 自動ストリーム選択
- `-map`による明示的な選択
- ストリーム指定子
- 複雑なフィルタグラフ
- Codec private options
- オプションの継承・上書き
- エラーと終了コード
- ログレベルと進捗情報

### 7.4 Public API

```typescript
import { FFmpeg } from "@edge-ffmpeg/core";
import { createR2FileSystem } from "@edge-ffmpeg/storage-r2";

const ffmpeg = new FFmpeg({
  filesystem: createR2FileSystem({
    bucket: env.MEDIA_BUCKET,
    mounts: {
      "/input": "source/",
      "/output": "result/"
    }
  })
});

const result = await ffmpeg.exec([
  "-i", "/input/movie.mp4",
  "-c:v", "libx264",
  "-preset", "medium",
  "-crf", "23",
  "-c:a", "aac",
  "/output/movie.mp4"
]);

console.log(result.exitCode);
```

上記は設計対象APIであり，実装済みの機能を示すものではない．

同期的なFFmpeg CLIの内部処理は，非同期のTypeScriptパイプラインに変換する．

---

## 8. メディア処理エンジン

### 8.1 avformat

担当範囲：

- コンテナ形式の検出
- Demuxer / Muxer
- ストリームメタデータ
- パケット読み取り
- Seek
- Index管理
- Interleaving
- Timestamp処理
- Bitstream Filter連携
- Protocol処理

コンテナごとに独立したモジュールを作成する．

### 8.2 avcodec

担当範囲：

- Decoder / Encoder Registry
- コーデック設定
- パケット入力
- フレーム出力
- Parser
- Bitstream Filter
- Delay / Flush
- Extradata
- Codec private options
- Rate Control
- Encoder固有の互換性

コーデック実装はTypeScriptまたはWasmを選択できる．

WasmはFFmpeg非依存の実装だけを使用する．外部実装を利用する場合もライセンス，ソース，バージョン，設定を固定する．

### 8.3 avfilter

FFmpegと同様に，有向グラフとしてフィルタを表現する．

主要コンポーネント：

- Filter Registry
- Input / Output Pads
- Format Negotiation
- Graph Validation
- Frame Scheduling
- Timebase Propagation
- Filter Command Handling
- End-of-stream Propagation

Filter Graphの実行ではフレーム単位で処理を進め，必要なバッファ量を追跡する．

### 8.4 swscale

以下を独立したモジュールとして実装する．

- ピクセル形式変換
- スケーリング
- 色空間変換
- Chroma Subsampling
- 色域・レンジ変換
- アルファチャンネル処理
- SIMD最適化

FFmpeg特有の丸め処理や係数の扱いも，互換性テストの対象とする．

### 8.5 swresample

以下を実装する．

- サンプルレート変換
- チャンネルレイアウト変換
- サンプル形式変換
- 音量補正
- 内部遅延管理
- Timestamp Compensation

同じ出力サンプル数だけでなく，遅延・丸め・補間処理も比較する．

### 8.6 avdevice

FFmpegのDevice APIに対応する抽象インターフェースを提供する．

ただし，実際のUSBカメラ，GPU，OS音声デバイスへのアクセスはWorkersの権限内で実現できない．

このような機能は抽象APIを実装したうえで，Runtime Capabilityとして区別する．

実在しないデバイスをソフトウェアでエミュレーションしても，物理デバイスとの厳密な動作互換にはならない．

---

## 9. Cloudflare Workers Runtime

### 9.1 Runtimeの役割

`runtime-cloudflare`はメディア処理の意味論を持たない．

次の機能だけを提供する．

- ファイル入出力
- リソース管理
- コーデックモジュールのロード
- ジョブの分散
- 永続状態の管理
- 再実行・キャンセル
- 実行メトリクス収集

### 9.2 メモリ戦略

Workerのメモリ上限は128 MBである．

- 固定長バッファを再利用する．
- パケットキューに上限を設ける．
- 大容量の中間ファイルをメモリに保持しない．
- 必要なファイル範囲だけ読み込む．
- 大きなフレームや変換状態は，可能な場合は分割または外部化する．
- Wasmメモリの増加を追跡する．
- デコード／エンコードのバッファ要求を事前に検査する．

ただし，必須の作業領域が128 MBを超え，分割可能なアルゴリズムも構築できない機能は，単一Workerでは実行できない．

### 9.3 CPU戦略

Workers PaidのCPU上限300秒を前提とする．

処理単位を`WorkUnit`に分割する．

```typescript
export interface WorkUnit {
  jobId: string;
  unitId: string;
  graphVersion: string;
  inputRanges: Array<{
    offset: bigint;
    length: bigint;
  }>;
  stateRef?: string;
  outputRef: string;
}
```

`WorkUnit`は処理範囲の記述であり，メッセージに大容量メディア本体を格納しない．

CPU時間の上限に近づく前に，安全な停止地点に到達できる設計を目指す．

### 9.4 WebAssembly

Wasmは以下の用途に使用する．

- コーデック演算
- SIMD最適化
- 高負荷フィルタ
- 高速リサンプリング
- エントロピー符号化・復号

単一スレッドで実行できるモジュールを基本とし，スレッド依存のアルゴリズムは分散実行向けに再設計する．

### 9.5 デプロイ構成

Workerのバンドルサイズ上限に対応するため，コーデックを機能単位に分割する．

例：

```text
edge-ffmpeg-api
edge-ffmpeg-audio
edge-ffmpeg-video
edge-ffmpeg-codec-h264
edge-ffmpeg-codec-av1
edge-ffmpeg-filter
edge-ffmpeg-output
```

すべてのコーデックを単一Workerに格納しない．

Wasmモジュールの動的ロードや分割については，Workersで実際に使用できるロード方式，バンドルサイズ，起動制限を検証する．

---

## 10. 仮想ファイルシステム

### 10.1 目的

FFmpegのファイルパス型I/OとCloudflareのオブジェクトストレージを接続する．

### 10.2 基本インターフェース

```typescript
export interface ReadHandle {
  readonly size: bigint;

  readAt(
    offset: bigint,
    length: number,
    signal?: AbortSignal
  ): Promise<Uint8Array>;
}

export interface WriteHandle {
  write(chunk: Uint8Array): Promise<void>;
  commit(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface VirtualFileSystem {
  openRead(path: string): Promise<ReadHandle>;
  openWrite(path: string): Promise<WriteHandle>;
}
```

### 10.3 R2 Adapter

- Range Read
- Read Ahead
- Range Coalescing
- ブロックキャッシュ
- Multipart Upload
- 一時オブジェクト
- 出力コミット
- オブジェクトの世代確認
- チェックサム検証

同一ファイルの読み取り途中にオブジェクトが置き換わらないよう，オブジェクト識別情報を保持する．

### 10.4 ランダムアクセスと出力

FFmpegのMuxerには，出力済みヘッダの書き換えやSeekを必要とするものが存在する．

R2の逐次書き込みだけでは再現できない場合があるため，以下の方式を提供する．

1. シーク不要のストリーミング出力
2. Chunk Storeを用いた書き込み可能な仮想ファイル
3. 最終コミット時のオブジェクト組み立て

書き込み操作は，最終的な成功が確認されるまでユーザーに確定済み出力として公開しない．

---

## 11. 分散実行エンジン

### 11.1 全体構成

```text
Client
  |
  v
Cloudflare Worker API
  |
  v
Job Planner
  |
  v
Cloudflare Workflows
  |
  v
Queues / Scheduler
  |
  +--> Media Worker A
  |
  +--> Media Worker B
  |
  +--> Media Worker C
  |
  v
Merge / Finalize Worker
  |
  v
R2 Output
```

### 11.2 グラフ分割

Execution Plannerが処理グラフを解析し，各ノードに以下の属性を付与する．

- Stateless / Stateful
- Seekable / Sequential
- Checkpointable / Non-checkpointable
- Frame-local / Temporal
- Deterministic / Environment-dependent
- Memory Requirement
- CPU Estimate
- Input Dependency

### 11.3 分割可能性

すべてのフィルタ・コーデックを任意のフレーム境界で分割できるわけではない．

フレーム間予測，エンコーダのRate Control，フィルタ履歴，音声遅延などの状態を考慮する．

分割方法は以下の3方式を採用する．

**Independent Partition**

依存関係のない部分を並列処理する．

**Stateful Continuation**

必要な内部状態を保存し，別のWorkerで復元する．

**Replay-based Partition**

直前のデータを再処理して必要な状態を再構築する．

FFmpegの出力と厳密に一致させる必要がある場合，独立したセグメントのエンコードは連続処理と異なる結果を生成する可能性がある．

したがって，分割可能であることと，バイナリ互換を維持できることは別に判定する．

### 11.4 Checkpoint

```typescript
export interface ExecutionCheckpoint {
  version: number;
  jobId: string;
  workUnitId: string;
  graphHash: string;
  inputFingerprint: string;
  codecStateRef?: string;
  filterStateRef?: string;
  muxerStateRef?: string;
  lastCommittedPosition: bigint;
}
```

Checkpointはバージョン管理し，復元前に互換性を検証する．

Wasm内部状態を含め，安全にシリアライズできることを確認したコンポーネントにのみCheckpoint機能を提供する．

### 11.5 冪等性

各WorkUnitには一意の識別子を付ける．

同じWorkUnitが複数回実行されても，確定済み成果物が二重作成されないようにする．

最終出力のコミットは，ジョブ状態と出力バージョンを検証して行う．

---

## 12. FFmpeg互換性テスト

### 12.1 基本原則

FFmpeg本家をOracleとして使用する．

対象を以下に分離する．

- 構文テスト
- 単体テスト
- コンテナテスト
- コーデックテスト
- フィルタテスト
- End-to-Endテスト
- Workers Runtimeテスト
- 差分テスト
- Fuzzing
- セキュリティテスト

### 12.2 Differential Testing

同じ入力・オプションを，固定したFFmpeg参照ビルドとEdgeFFmpegに与える．

```text
Input + Options
       |
       +--> Native FFmpeg
       |         |
       |         v
       |    Reference Output
       |
       +--> EdgeFFmpeg
                 |
                 v
             Actual Output
                 |
                 v
          Compatibility Comparator
```

比較対象：

- 終了コード
- ストリーム構成
- Codec Parameters
- Timestamp
- Duration
- Metadata
- 出力データ
- PCMサンプル
- デコード済み映像
- ビットストリーム
- エラーメッセージ

### 12.3 比較モード

**Bit-exact**

バイト列の完全一致を要求する．

**Numerical**

デコード結果やフィルタ出力を定義済みの誤差範囲で比較する．

**Semantic**

同じコンテナ構造，ストリーム，タイムスタンプ，処理結果を要求する．

**Protocol**

ログ，エラー，終了コード，副作用を比較する．

互換性判定では，許容誤差をテストケース単位で管理する．

バイナリ一致が必要な機能に数値近似だけで合格を出さない．

### 12.4 FATE

FFmpeg公式のFATEを参照テスト基盤として使用する．

`tools/fate-adapter`は以下を担当する．

1. FATEのテスト定義を解析する．
2. テスト入力と期待結果を特定する．
3. EdgeFFmpeg向けの実行形式へ変換する．
4. ネイティブ実装とEdgeFFmpegの両方を実行する．
5. テスト結果を統合する．

FATEのすべてのケースが直接移植できるとは限らないため，移植不可のケースも追跡する．

FATEデータセットはUpstream submoduleとは別管理にし，取得元とハッシュを固定する．

### 12.5 Fuzzing

主な対象：

- 不正なMP4 box
- 不正なEBML要素
- 巨大なメタデータ値
- 整数オーバーフロー
- 破損したコーデックパケット
- 不正なフィルタグラフ
- 特殊なタイムスタンプ
- 深いネスト構造
- ゼロ長ストリーム
- 想定外のEOF

FFmpegとの挙動差分だけでなく，Workerのメモリ超過，無限ループ，例外漏出も検出する．

### 12.6 互換性スコア

単純な「互換率」だけに依存しない．

以下を別々に表示する．

- Capability Coverage
- Test Case Pass Rate
- Bit-exact Pass Rate
- Workers Runtime Pass Rate
- Known Incompatibilities
- Unverified Features

全機能の母数にはCapability Manifestを使用する．

---

## 13. CI/CD

### 13.1 Pull Request CI

すべてのPRで実行する．

1. TypeScript Typecheck
2. ESLint
3. Unit Tests
4. Package Boundary Validation
5. Native Reference Tests
6. Differential Tests
7. Workers Integration Tests
8. Bundle Size Validation
9. Security Checks
10. Compatibility Report Generation

### 13.2 定期CI

定期実行する処理：

- FATE全体の実行
- 大規模差分テスト
- コーデック網羅テスト
- Fuzzing
- パフォーマンス測定
- Workers本番Runtimeの検証
- Upstream更新確認

### 13.3 Upstream Sync

上流バージョン更新を検出した場合，以下を実行する．

```text
Discover Release
      |
      v
Fetch Upstream Commit
      |
      v
Build Reference
      |
      v
Extract Capabilities
      |
      v
Compare Manifest
      |
      v
Generate Migration Report
      |
      v
Run Compatibility Tests
      |
      v
Review & Pin New Target
```

上流の新バージョンを検出しても，自動的に互換対象を置き換えない．

互換性の基準は明示的なレビューによって変更する．

---

## 14. 性能・リソース評価

### 14.1 計測項目

- CPU Time
- Wall-clock Time
- Peak Memory
- Wasm Memory
- I/O Read Bytes
- I/O Write Bytes
- R2 Request Count
- Output Throughput
- Codec Throughput
- Cold Start
- Bundle Size
- Output Accuracy
- Processing Cost

### 14.2 性能の比較基準

Native FFmpegとEdgeFFmpegを同じ入力データで比較する．

ただし，CPUアーキテクチャや実行環境が異なるため，速度の単純比較だけで優劣を判断しない．

互換性と性能を独立した評価軸として管理する．

### 14.3 負荷試験

以下の条件を網羅する．

- 短時間の音声
- 長時間の音声
- 低解像度動画
- Full HD動画
- 4K以上の動画
- 高ビットレート動画
- 多数の音声トラック
- 大量の字幕
- 長大なメタデータ
- 破損ファイル
- 複数ジョブの同時実行

---

## 15. セキュリティ設計

### 15.1 基本方針

メディアファイルは攻撃者が作成できる入力として扱う．

### 15.2 必須対策

- 入力サイズの上限管理
- コンテナ解析時の境界チェック
- 整数オーバーフロー対策
- Wasmメモリ管理
- CPU消費量の制御
- ネスト深度制限
- パス正規化
- ディレクトリトラバーサル対策
- SSRF対策
- URL Protocolの許可制御
- リソース枯渇対策
- 入力オブジェクトの完全性確認
- 出力ファイルのアクセス制御
- ジョブごとの権限分離

### 15.3 URL入力

`-i https://...`などをサポートする場合，任意のネットワークアクセスを無条件で許可しない．

リダイレクト先を含めてアクセス制限を検査する．

必要なProtocol互換性と，ライブラリを組み込むアプリケーションのセキュリティポリシーを分離する．

---

## 16. ライセンス設計

FFmpeg本体はLGPLを基本とし，オプションのGPL対象コードや外部ライブラリが存在する．

EdgeFFmpegでは，次を区別する．

**Independent Implementation**

仕様と動作を参照して独立に実装したコード．

**Adapted Implementation**

FFmpegや外部実装のコードを翻訳・改変・移植したコード．

後者については，元コードのライセンス，著作権表示，配布義務を継承する必要が生じ得る．

ライセンス戦略：

1. 依存ライブラリのライセンスを一覧管理する．
2. ソースコードを移植した場合は出典を明記する．
3. コーデック単位でライセンスを識別する．
4. npmパッケージの再配布条件を確認する．
5. 商用利用を想定した法務レビューを行う．
6. コーデック特許の問題を著作権ライセンスとは別に扱う．

OSSの公開ライセンスは，移植コードの有無と採用モジュールの組み合わせを監査したうえで確定する．

---

## 17. 開発フェーズ

### Phase 0：仕様と参照実装の固定

成果物：

- Git submodule
- Upstream Lock
- Reference Build
- Capability Manifest
- FATE Adapter初期版
- TypeScriptモノレポ

### Phase 1：Core互換

成果物：

- Rational / Timestamp
- Packet / Frame
- CLI Parser
- Registry
- Execution Planner
- Resource Budget
- Virtual File System

### Phase 2：コンテナ互換

成果物：

- Demux / Mux
- Format Detection
- Stream Selection
- Seek
- Timestamp Handling
- Bitstream Filter統合

### Phase 3：音声互換

成果物：

- Audio Decoder / Encoder
- Audio Filtering
- Resampling
- Channel Layout
- Audio Format Conversion
- Workers上での音声変換

### Phase 4：動画互換

成果物：

- Video Decoder / Encoder
- Pixel Format
- Scaling
- Color Conversion
- Video Filter Graph
- コーデック固有設定

### Phase 5：全体機能の拡張

成果物：

- 字幕
- Attachment
- 多入力・多出力
- 複雑なフィルタグラフ
- Streaming Protocol
- Device Abstraction
- 追加コーデック・コンテナ

### Phase 6：分散実行

成果物：

- Work Unit Planner
- Checkpoint
- Queue Adapter
- Workflow Integration
- Distributed Encoding
- Output Finalization

### Phase 7：互換性の収束

成果物：

- FATEカバレッジ拡大
- Differential Test網羅
- Bit-exact Test
- 性能最適化
- 不整合の修正
- 本番Workers互換性レポート

各フェーズは完了後に固定するものではない．上位機能の実装で必要になった変更を下位モジュールへ反映し，継続的に互換性を高める．

---

## 18. リリース方針

| リリース | 完了基準 |
|---|---|
| 0.1 | コアAPIとCLI Parser |
| 0.2 | 基本的なDemux / Mux |
| 0.3 | 音声処理のEnd-to-End |
| 0.4 | 動画処理のEnd-to-End |
| 0.5 | Filter Graph |
| 0.6 | Workers分散実行 |
| 0.7 | 追加コーデック・形式の拡大 |
| 0.8 | FATE・差分テストの拡張 |
| 0.9 | 互換性の既知差分整理 |
| 1.0 | 公開した互換性契約を満たす安定版 |

1.0はFFmpegの全機能への完全互換が自動的に達成されたことを意味しない．完全互換の最終目標は維持しつつ，リリース時点の保証範囲を明示する．

---

## 19. 主な技術的リスク

| リスク | 影響 | 対策 |
|---|---|---|
| 128 MBメモリ上限 | 高 | 分割，外部化，再計算 |
| CPU時間制限 | 高 | WorkUnit化，処理再開 |
| Wasmスレッド非対応 | 高 | Single-thread実装，分散化 |
| Codec実装差分 | 高 | 参照テスト，数値検証 |
| Bit-exact不一致 | 高 | 演算順序，丸め，設定の追跡 |
| Stateful Codecの分割 | 高 | 状態保存，Replay |
| Worker Bundle制限 | 中〜高 | モジュール分割 |
| Runtime APIの不足 | 高 | Adapter，Capability検証 |
| 外部ライブラリのライセンス | 高 | 依存監査と分離 |
| 上流FFmpegの変更 | 中 | Version Pin，差分管理 |

実行環境に存在しないハードウェア機能については，ユーザー空間で解決できないケースがある．

この場合は実装欠落ではなく，Runtime Capabilityの不足として記録する．

---

## 20. 最終受け入れ基準

次の条件を満たすことを最終的な技術目標とする．

- FFmpeg参照ビルドの機能一覧がすべて追跡されている．
- 対応機能のコマンド意味論が参照実装と一致する．
- 対象機能の出力互換性が自動検証されている．
- 実装済み機能はCloudflare Workers上で実際にテストされている．
- FFmpeg本体への実行時依存が存在しない．
- Workers以外の計算サーバーへの暗黙のフォールバックが存在しない．
- 制約を超える処理は明確な理由とともに処理される．
- 再試行可能な処理は中断・再開できる．
- OSSのライセンス要件が満たされている．
- 互換性レポートが自動生成される．

最終的に未対応・部分対応・Runtime制約のある機能が残る限り，無条件の「FFmpeg完全互換」は宣言しない．

---

## 21. 設計上の最終決定

**D-001：** FFmpeg 9.0.2を初期の互換性基準とする．

**D-002：** Git submoduleをUpstreamの唯一のソース参照として使用する．

**D-003：** 固定したReference Buildの挙動を検証基準とする．

**D-004：** TypeScriptを主要実装言語とする．

**D-005：** FFmpeg非依存のWebAssemblyを許可する．

**D-006：** CoreをCloudflare固有APIから分離する．

**D-007：** Workers Runtimeでの実動作を必須の検証対象とする．

**D-008：** メディア処理をストリーム指向に設計する．

**D-009：** 大規模処理にはWorkUnit単位の分散実行を提供する．

**D-010：** FATEおよびDifferential Testingによって互換性を検証する．

**D-011：** 機能互換とバイナリ互換を区別して管理する．

**D-012：** Workersで実現できない機能を隠蔽しない．

**D-013：** 上流更新は独立した互換性ターゲットとして段階的に追従する．

**D-014：** すべての互換性主張にテストと再現可能な構成を関連付ける．

**D-015：** 最終目標はFFmpeg完全互換とし，工数を理由に目標を縮小しない．

---

## 22. 推奨する最初の開発作業

初回の開発では，以下を一つの変更セットとして実装する．

- モノレポの初期化
- FFmpeg 9.0.2 submoduleの追加
- Reference Buildの定義
- Upstream Lock生成
- Capability Manifest抽出
- CLI Parserの基本設計
- TypeScriptのMediaPacket / Timestamp型
- Cloudflare Runtime Adapterの雛形
- FATE Adapterの最小実装
- Native FFmpegとのDifferential Test
- GitHub Actionsによる自動検証

この時点では動画変換機能の実装より，互換性を継続的に測定できる開発基盤を先に確立する．

**EdgeFFmpegの開発における最上位原則は，FFmpegとの互換性を推測ではなく，固定したUpstreamの実際の挙動によって証明することである．**
