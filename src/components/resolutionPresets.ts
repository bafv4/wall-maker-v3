/**
 * components/resolutionPresets.ts — 解像度プリセットを 1 箇所に集約する。
 *
 * `PackInfoEditor` の解像度セクションと `ImportResolutionDialog` で同じ表をそれぞれ
 * 持っていたため、ここに統合した。プリセットの追加・ラベル変更はこのファイルだけで完結する。
 *
 * `useResolutionPresets()` は i18n フックなので React の関数コンポーネント / カスタムフック内
 * からのみ呼べる（react-i18next の `useTranslation` 制約）。
 */

import { useTranslation } from 'react-i18next';

/** プリセット解像度の `<width>x<height>` 文字列。`custom` 以外の選択肢の正規ソース。 */
export const RESOLUTION_PRESET_VALUES = [
  '1920x1080',
  '2560x1440',
  '3840x2160',
] as const;

export type ResolutionPresetValue =
  | (typeof RESOLUTION_PRESET_VALUES)[number]
  | 'custom';

/** 与えられた解像度がプリセットに一致するか判定し、対応する value を返す（一致しなければ `'custom'`）。 */
export function presetValueOf(width: number, height: number): ResolutionPresetValue {
  const key = `${width}x${height}` as (typeof RESOLUTION_PRESET_VALUES)[number];
  return (RESOLUTION_PRESET_VALUES as readonly string[]).includes(key)
    ? key
    : 'custom';
}

/** React 用：プリセットの value/label ペアを翻訳済みで返す（Select の options に直接渡せる形）。 */
export function useResolutionPresets(): { value: string; label: string }[] {
  const { t } = useTranslation();
  return [
    { value: '1920x1080', label: t('resolution.presetOptions.fhd') },
    { value: '2560x1440', label: t('resolution.presetOptions.wqhd') },
    { value: '3840x2160', label: t('resolution.presetOptions.uhd') },
    { value: 'custom', label: t('resolution.presetOptions.custom') },
  ];
}
