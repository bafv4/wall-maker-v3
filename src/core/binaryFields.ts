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
 *    `buildPack` 内の throw は最後の砦（開発時の不変条件チェック）で、
 *    ユーザ操作の経路ではここに到達しない。
 */

import {
  SOUND_EVENT_KEYS,
  type BinaryRef,
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

  // background.png — visible な image レイヤだけが合成対象
  for (const layer of state.background.layers) {
    if (layer.type === 'image' && layer.visible) {
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

  // sounds — globalMode='off' は全イベント off 出力で ogg を使わない
  if (state.sounds.globalMode !== 'off') {
    for (const key of SOUND_EVENT_KEYS) {
      const entry = state.sounds.events[key];
      if (entry.mode === 'custom') check(entry.ogg, 'sound');
    }
  }

  return BINARY_FIELD_KINDS.filter((k) => found.has(k));
}
