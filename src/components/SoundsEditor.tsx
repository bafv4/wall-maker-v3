/**
 * SoundsEditor — 全 13 イベントのサウンド設定。
 *
 * 仕様: REWRITE_SPEC.md 第6.6章 / 第9章。
 *  - 全 13 イベント（SOUND_EVENT_KEYS）を網羅。
 *  - globalMode='off': 全イベントを無音出力（per-event 設定は state に保持）。
 *  - globalMode='custom': per-event を反映。
 *  - resetUnified=true: UI 上で reset_instance/reset_all/reset_column/reset_row を 1 行に集約。
 *      切替時は reset_instance の値を他 3 イベントに伝播する。
 *  - custom 選択時のみ ogg ファイルが必要。
 *
 * 音声形式:
 *  - 受け付けは `audio/*`。OGG はそのまま使い、それ以外（MP3/WAV/AAC/M4A/FLAC/OPUS/WEBM）は
 *    self-host した `ffmpeg.wasm` で Ogg Vorbis に変換する（`src/audio/convert.ts`）。
 *  - 変換中は行単位で「変換中…」表示し、二重操作を抑止。
 *  - FFmpeg ライセンス表記は AboutModal と README に明記。
 */

import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { convertToOgg, isSupportedAudioExt } from '../audio/convert';
import { errMsg } from '../core/errors';
import {
  SOUND_EVENT_KEYS,
  type SoundEntry,
  type SoundEventKey,
} from '../core/state';
import { useWallStore } from '../store/useWallStore';
import { Select, Switch, toast } from './ui';
import { cn } from './ui/cn';

const MODE_VALUES = ['default', 'off', 'custom'] as const;

/** SeedQueue 既定で内蔵音が割り当てられているイベント（第6.6章）。 */
const HAS_BUILTIN: Record<SoundEventKey, boolean> = {
  play_instance: false,
  lock_instance: true,
  reset_instance: true,
  reset_all: false,
  reset_column: false,
  reset_row: false,
  schedule_join: false,
  schedule_all: false,
  scheduled_join_warning: false,
  start_benchmark: false,
  finish_benchmark: false,
  open_wall: false,
  bypass_wall: false,
};

const RESET_KEYS: readonly SoundEventKey[] = [
  'reset_instance',
  'reset_all',
  'reset_column',
  'reset_row',
];

// ---------------------------------------------------------------------------
// 単一イベント行
// ---------------------------------------------------------------------------

/** ファイル名から拡張子（小文字、`.` なし）。無ければ空文字。 */
function getExt(name: string): string {
  return (name.split('.').pop() ?? '').toLowerCase();
}

interface EventRowProps {
  label: string;
  hasBuiltin: boolean;
  entry: SoundEntry;
  onChange: (next: SoundEntry) => void;
  disabled?: boolean;
  highlight?: boolean;
}

function EventRow({
  label,
  hasBuiltin,
  entry,
  onChange,
  disabled,
  highlight,
}: EventRowProps) {
  const { t } = useTranslation();
  const modeOptions = MODE_VALUES.map((value) => ({
    value,
    label: t(`sound.modeOptions.${value}`),
  }));
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [converting, setConverting] = useState(false);

  const promptFile = () => fileInputRef.current?.click();

  const handleFile = async (file: File) => {
    const ext = getExt(file.name);
    if (!isSupportedAudioExt(file.name)) {
      toast.error(t('sound.unsupported', { filename: file.name }));
      return;
    }
    const inputBytes = new Uint8Array(await file.arrayBuffer());
    let oggBytes: Uint8Array;
    if (ext === 'ogg') {
      oggBytes = inputBytes;
    } else {
      // 非 OGG → ffmpeg.wasm で Ogg Vorbis に変換。初回は core 資材のダウンロードが入る。
      setConverting(true);
      try {
        oggBytes = await convertToOgg(inputBytes, ext);
        toast.success(t('sound.convertSuccess', { filename: file.name }));
      } catch (e) {
        console.error('audio convert failed', e);
        toast.error(
          t('sound.convertFailed', { filename: file.name, error: errMsg(e) }),
        );
        return;
      } finally {
        setConverting(false);
      }
    }
    onChange({
      mode: 'custom',
      ogg: {
        kind: 'inline',
        bytes: oggBytes,
        mimeType: 'audio/ogg',
      },
      originalFileName: file.name,
    });
  };

  const handleModeChange = (value: string) => {
    const mode = value as SoundEntry['mode'];
    if (mode === 'custom') {
      // custom には ogg が必須。state は変えずにファイルピッカを開く。
      promptFile();
      return;
    }
    onChange({ mode });
  };

  const rowDisabled = disabled || converting;

  return (
    <li
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-md border bg-surface p-2 text-sm',
        highlight ? 'border-blue-300 bg-accent-soft' : 'border-border',
        rowDisabled && 'opacity-60',
      )}
    >
      <div className="min-w-[140px] flex-1">
        <span className="font-medium text-fg">{label}</span>
        {hasBuiltin && (
          <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[10px] text-fg-subtle">
            {t('sound.builtinBadge')}
          </span>
        )}
      </div>

      <div className="w-44">
        <Select
          value={entry.mode}
          onValueChange={handleModeChange}
          disabled={rowDisabled}
          options={modeOptions}
        />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.ogg,.mp3,.wav,.flac,.aac,.m4a,.opus,.webm"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          if (fileInputRef.current) fileInputRef.current.value = '';
        }}
      />

      {converting ? (
        <div className="flex items-center gap-1 text-[10px] text-fg-subtle">
          <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-border-strong border-t-blue-500" />
          {t('sound.converting')}
        </div>
      ) : (
        entry.mode === 'custom' && (
          <div className="flex items-center gap-1">
            <code className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-fg-muted">
              {entry.originalFileName ?? t('sound.customDefault')}
            </code>
            <button
              type="button"
              onClick={promptFile}
              disabled={rowDisabled}
              className="text-[10px] text-blue-600 underline hover:text-blue-800 disabled:opacity-40"
            >
              {t('sound.replace')}
            </button>
          </div>
        )
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// 本体
// ---------------------------------------------------------------------------

const NON_INSTANCE_RESET_KEYS: ReadonlySet<SoundEventKey> = new Set([
  'reset_all',
  'reset_column',
  'reset_row',
]);

export function SoundsEditor() {
  const { t } = useTranslation();
  const sounds = useWallStore((s) => s.wall.sounds);
  const setSoundGlobalMode = useWallStore((s) => s.setSoundGlobalMode);
  const setSoundResetUnified = useWallStore((s) => s.setSoundResetUnified);
  const setSoundEvent = useWallStore((s) => s.setSoundEvent);

  const eventDisabled = sounds.globalMode === 'off';

  // resetUnified の切替時、reset_instance を他 3 イベントへ伝播
  const handleResetUnifiedToggle = (b: boolean) => {
    setSoundResetUnified(b);
    if (b) {
      const ref = sounds.events.reset_instance;
      NON_INSTANCE_RESET_KEYS.forEach((key) => setSoundEvent(key, ref));
    }
  };

  // unified 行の操作は 4 イベント同時更新
  const handleUnifiedChange = (entry: SoundEntry) => {
    for (const key of RESET_KEYS) setSoundEvent(key, entry);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-panel p-3">
        <div className="px-1 text-xs font-medium text-fg-muted">
          {t('sound.outputMode')}
        </div>
        <div
          role="group"
          aria-label={t('sound.outputMode')}
          className="mt-2 inline-flex rounded-md border border-border-strong p-0.5"
        >
          {(
            [
              { mode: 'custom', label: t('sound.perEventLabel') },
              { mode: 'off', label: t('sound.allOffLabel') },
            ] as const
          ).map(({ mode, label }) => {
            const active = sounds.globalMode === mode;
            return (
              <button
                key={mode}
                type="button"
                aria-pressed={active}
                onClick={() => setSoundGlobalMode(mode)}
                className={cn(
                  'cursor-pointer rounded px-3 py-1.5 text-sm font-medium transition-colors',
                  'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
                  active
                    ? 'bg-fg text-surface'
                    : 'text-fg-muted hover:bg-muted hover:text-fg',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        {eventDisabled && (
          <p className="mt-2 text-[11px] text-amber-700 dark:text-amber-500">
            {t('sound.allOffNote')}
          </p>
        )}
      </div>

      <div className="flex items-center justify-between rounded-md bg-panel p-3">
        <div>
          <span className="block text-sm font-medium text-fg">
            {t('sound.resetUnifiedTitle')}
          </span>
          <span className="block text-[11px] text-fg-subtle">
            {t('sound.resetUnifiedDescription')}
          </span>
        </div>
        <Switch
          checked={sounds.resetUnified}
          onChange={handleResetUnifiedToggle}
          disabled={eventDisabled}
        />
      </div>

      <ul className="space-y-2">
        {SOUND_EVENT_KEYS.map((key) => {
          // resetUnified: reset_instance の位置に unified 行を 1 つ出し、他 3 つは skip。
          if (sounds.resetUnified && NON_INSTANCE_RESET_KEYS.has(key)) {
            return null;
          }
          if (sounds.resetUnified && key === 'reset_instance') {
            return (
              <EventRow
                key="__unified_reset__"
                label={t('sound.unifiedRowLabel')}
                hasBuiltin
                entry={sounds.events.reset_instance}
                onChange={handleUnifiedChange}
                disabled={eventDisabled}
                highlight
              />
            );
          }
          return (
            <EventRow
              key={key}
              label={t(`sound.events.${key}`)}
              hasBuiltin={HAS_BUILTIN[key]}
              entry={sounds.events[key]}
              onChange={(entry) => setSoundEvent(key, entry)}
              disabled={eventDisabled}
            />
          );
        })}
      </ul>

      <details className="text-xs text-fg-subtle">
        <summary className="cursor-pointer text-fg-muted">
          {t('sound.specMemo')}
        </summary>
        <ul className="mt-2 list-disc space-y-1 pl-4">
          <li>{t('sound.specDefault')}</li>
          <li>{t('sound.specOff')}</li>
          <li>{t('sound.specCustom')}</li>
          <li>{t('sound.specFormat')}</li>
        </ul>
      </details>
    </div>
  );
}
