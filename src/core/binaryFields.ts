/**
 * binaryFields — `WallState` が持つバイナリフィールドの「種別」と、未解決 `BinaryRef` の検出。
 * 仕様: REWRITE_SPEC.md 第7.2章（永続化境界）。
 *
 * **未解決 ref の契約（この 1 箇所を正とする）**
 *
 * 永続化からの復元（`store/serialize.ts` の `resolveBinariesToInline`）で
 * `BinaryStorage.get` が失敗したフィールドは、`{ kind: 'ref' }` のまま state に残る。
 * これは「実体は無事かもしれないが、今はバイトが手元に無い」＝**未ロード**の意味。
 * 各レイヤの振る舞いをこの意味に揃える:
 *
 *  - **表示（`renderBackground`）** — 未ロードのレイヤは描画をスキップし、
 *    残りのレイヤの描画は継続する。プレビューを 1 フィールドの欠落で落とさない。
 *  - **出力（`buildPack`）** — 未ロードを黙って落とさない。欠けたまま書き出すと
 *    「見た目は普通なのにゲーム内で効かないパック」になり、目視で気づけないため。
 *  - **UI（書き出しハンドラ）** — 書き出し前に `collectUnresolvedBinaryFields` で検出し、
 *    **どのフィールドが未ロードなのかを翻訳済みメッセージで示して中止する**。
 *    `buildPack` が使う `resolveInline` の throw は最後の砦（開発時の不変条件チェック）で、
 *    ユーザ操作の経路ではここに到達しない。
 */

import { isPlayableOggVorbis } from './oggVorbis';
import {
  SOUND_EVENT_KEYS,
  type BinaryRef,
  type SoundEventKey,
  type WallState,
} from './state';

/** バイナリフィールドの種別。UI ラベルは i18n の `binaryField.<kind>`。 */
export type BinaryFieldKind =
  | 'packIcon'
  | 'backgroundImage'
  | 'extraTexture'
  | 'lockImage'
  | 'sound';

/** 表示順を固定するための正準順序（メッセージ内の列挙順）。 */
export const BINARY_FIELD_KINDS: readonly BinaryFieldKind[] = [
  'packIcon',
  'backgroundImage',
  'extraTexture',
  'lockImage',
  'sound',
];

/**
 * state 内の「これから書き出す予定なのに未ロード（`kind: 'ref'`）」なフィールドの種別を返す。
 * 空配列なら `buildPack` は未解決 ref に触れない。
 *
 * 判定条件は **`buildPack` の出力条件と 1:1 で一致させること**。
 * 出力されないフィールド（非表示の背景レイヤ、lock 無効時の画像、全 off 時のサウンド）は
 * そもそもバイトを必要としないので、書き出しを止める理由にしない。
 */
export function collectUnresolvedBinaryFields(
  state: WallState,
): BinaryFieldKind[] {
  const found = new Set<BinaryFieldKind>();
  const check = (
    ref: BinaryRef | null | undefined,
    kind: BinaryFieldKind,
  ): void => {
    if (ref && ref.kind === 'ref') found.add(kind);
  };

  // pack.png — icon があれば必ず出力する
  check(state.packInfo.icon, 'packIcon');

  // background.png — visible な image レイヤだけが合成対象。
  // 編集データ同梱時は非表示レイヤの元画像も wall-maker/ に書き出す（core/editorMeta.ts）。
  for (const layer of state.background.layers) {
    if (
      layer.type === 'image' &&
      (layer.visible || state.packInfo.embedEditorData)
    ) {
      check(layer.source, 'backgroundImage');
    }
  }

  // overlay / instance_background / instance_overlay — あれば必ず出力する
  check(state.extraTextures.overlay, 'extraTexture');
  check(state.extraTextures.instance_background, 'extraTexture');
  check(state.extraTextures.instance_overlay, 'extraTexture');

  // lock 画像 — enabled=false のときは透明プレースホルダのみで画像は使わない
  if (state.lockImages.enabled) {
    for (const img of state.lockImages.images) {
      check(img.source, 'lockImage');
    }
  }

  for (const { ogg } of exportedCustomSounds(state)) check(ogg, 'sound');

  return BINARY_FIELD_KINDS.filter((k) => found.has(k));
}

/**
 * 書き出される custom 音声（`sounds/custom/<event>.ogg` になるもの）。
 * globalMode='off' は全イベント off 出力で ogg を使わない。buildPack の出力条件と 1:1。
 */
function exportedCustomSounds(
  state: WallState,
): { event: SoundEventKey; ogg: BinaryRef }[] {
  if (state.sounds.globalMode === 'off') return [];
  return SOUND_EVENT_KEYS.flatMap((event) => {
    const entry = state.sounds.events[event];
    return entry.mode === 'custom' ? [{ event, ogg: entry.ogg }] : [];
  });
}

/**
 * 書き出される custom 音声のうち、Minecraft で再生できない（Ogg Vorbis・1〜2ch 以外）
 * もののイベント。SeedQueue は seedqueue 名前空間の音声の読込失敗でゲームをクラッシュ
 * させるので、書き出しハンドラはこれが空でなければ中止する。アップロード時にも検査して
 * いるが、検査導入前に保存された編集内容には Opus 等の .ogg が残りうる。
 * 未ロード（ref）は `collectUnresolvedBinaryFields` の担当なので、inline だけを見る。
 */
export function collectUnplayableSoundEvents(
  state: WallState,
): SoundEventKey[] {
  return exportedCustomSounds(state)
    .filter(
      ({ ogg }) => ogg.kind === 'inline' && !isPlayableOggVorbis(ogg.bytes),
    )
    .map(({ event }) => event);
}

/**
 * 書き出し時に inline のバイトを取り出す。未解決 ref（＝未ロード）は黙って落とさず throw する。
 * 欠けたまま書き出すと「見た目は普通なのにゲーム内で効かないパック」になり目視で気づけないため。
 *
 * ここに到達するのは不変条件違反（開発時のバグ）で、メッセージは開発者向け。
 * ユーザ操作の経路では、書き出しハンドラが `collectUnresolvedBinaryFields` で
 * 事前に検出し、翻訳済みの具体的なメッセージで中止する。
 */
export function resolveInline(ref: BinaryRef): Uint8Array {
  if (ref.kind === 'inline') {
    return ref.bytes;
  }
  throw new Error(
    `received unresolved BinaryRef (storageKey=${ref.storageKey}). ` +
      'Callers must check collectUnresolvedBinaryFields() before building a pack.',
  );
}
