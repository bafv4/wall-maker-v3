/**
 * AboutModal — アプリ情報、サードパーティライセンス、言語切替。
 *
 * 仕様: REWRITE_SPEC.md 第9章 / CLAUDE.md「FFmpeg ライセンス表記は README とアプリ内 About に必須」。
 *
 * FFmpeg / @ffmpeg/core (GPL v2+) と ffmpeg.wasm (MIT) を MP3/WAV → OGG 変換に使用しており、
 * その表記をユーザに対して可視に保つ。AppHeader（Web）と FileEditor（Desktop）から開く。
 * 言語切替（ja/en）もここに集約する。
 */

import { useTranslation, Trans } from 'react-i18next';
import { SUPPORTED_LANGUAGES, setLanguage, type SupportedLanguage } from '../i18n';
import { Modal } from './ui';

export interface AboutModalProps {
  open: boolean;
  onClose: () => void;
}

const SEEDQUEUE_REPO = 'https://github.com/contariaa/seedqueue';
const PROJECT_REPO = 'https://github.com/bafv4/wall-maker-v3';
const FFMPEG_REPO = 'https://github.com/FFmpeg/FFmpeg';
const FFMPEG_WASM_REPO = 'https://github.com/ffmpegwasm/ffmpeg.wasm';
const GPL3_URL = 'https://www.gnu.org/licenses/gpl-3.0.html';
const GPL2_URL = 'https://www.gnu.org/licenses/old-licenses/gpl-2.0.html';

interface LinkProps {
  href: string;
  // Trans に渡すときは children が空のまま使うため optional。
  children?: React.ReactNode;
}

function ExternalLink({ href, children }: LinkProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-blue-600 underline hover:text-blue-800"
    >
      {children}
    </a>
  );
}

function LanguageSwitcher() {
  const { t, i18n } = useTranslation();
  const current = (i18n.resolvedLanguage ??
    i18n.language) as SupportedLanguage;
  const labels: Record<SupportedLanguage, string> = {
    ja: t('about.languageJa'),
    en: t('about.languageEn'),
  };
  return (
    <section className="space-y-2">
      <h4 className="text-sm font-semibold text-fg">
        {t('about.languageHeading')}
      </h4>
      <p className="text-xs text-fg-muted">{t('about.languageDescription')}</p>
      <div className="inline-flex overflow-hidden rounded-md border border-border-strong">
        {SUPPORTED_LANGUAGES.map((lng) => (
          <button
            key={lng}
            type="button"
            onClick={() => void setLanguage(lng)}
            className={
              current === lng
                ? // 反転ピル（fg↔surface）。ライト=濃紺地に白、ダーク=明地に暗字で、
                  // どちらでも面（surface）とコントラストが出る。
                  'cursor-pointer bg-fg px-3 py-1.5 text-xs font-medium text-surface'
                : 'cursor-pointer bg-surface px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-muted'
            }
            aria-pressed={current === lng}
          >
            {labels[lng]}
          </button>
        ))}
      </div>
    </section>
  );
}

export function AboutModal({ open, onClose }: AboutModalProps) {
  const { t } = useTranslation();

  return (
    <Modal open={open} onClose={onClose} title={t('about.title')}>
      <div className="space-y-5 text-sm text-fg-muted">
        <section className="space-y-1">
          <h3 className="text-base font-semibold text-fg">
            {t('about.appHeading')}{' '}
            <span className="text-xs font-normal text-fg-subtle">
              {__APP_VERSION__}
            </span>
          </h3>
          <p className="text-xs text-fg-muted">
            <Trans
              i18nKey="about.appDescription"
              components={[<ExternalLink href={SEEDQUEUE_REPO} />]}
            />
          </p>
          <p className="text-[11px] text-fg-subtle">
            <Trans
              i18nKey="about.appLicenseLine"
              components={[<ExternalLink href={GPL3_URL} />]}
            />
          </p>
        </section>

        <LanguageSwitcher />

        <section className="space-y-2">
          <h4 className="text-sm font-semibold text-fg">
            {t('about.ffmpegHeading')}
          </h4>
          <p className="text-xs leading-relaxed">{t('about.ffmpegIntro')}</p>
          <ul className="space-y-2 rounded-md border border-border bg-panel p-3 text-xs">
            <li>
              <Trans
                i18nKey="about.ffmpegCore"
                components={{ strong: <strong /> }}
              />
              <br />
              <ExternalLink href={FFMPEG_REPO}>{FFMPEG_REPO}</ExternalLink>
              {' / '}
              <ExternalLink href={GPL2_URL}>GPL v2</ExternalLink>
            </li>
            <li>
              <Trans
                i18nKey="about.ffmpegWasm"
                components={{ strong: <strong /> }}
              />
              <br />
              <ExternalLink href={FFMPEG_WASM_REPO}>
                {FFMPEG_WASM_REPO}
              </ExternalLink>
            </li>
          </ul>
          <p className="text-[11px] text-fg-subtle">{t('about.ffmpegNote')}</p>
        </section>

        <section className="space-y-1">
          <h4 className="text-sm font-semibold text-fg">
            {t('about.linksHeading')}
          </h4>
          <ul className="space-y-1 text-xs">
            <li>
              {t('about.linkSeedQueue', { repo: '' })}
              <ExternalLink href={SEEDQUEUE_REPO}>contariaa/seedqueue</ExternalLink>
            </li>
            <li>
              {t('about.linkRepo', { repo: '' })}
              <ExternalLink href={PROJECT_REPO}>bafv4/wall-maker-v3</ExternalLink>
            </li>
          </ul>
        </section>
      </div>
    </Modal>
  );
}
