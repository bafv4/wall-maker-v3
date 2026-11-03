import { cn } from './cn';

export interface SwitchProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  disabled?: boolean;
  id?: string;
  /**
   * `label` を使わないときの読み上げ名。見える文言が別の場所にあるなら、そちらを
   * `<label htmlFor={id}>` にして結び付けるほうがよい（文言のクリックでも切り替わる）。
   */
  'aria-label'?: string;
  /** 補足説明の要素 id。 */
  'aria-describedby'?: string;
}

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': ariaDescribedBy,
}: SwitchProps) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'inline-flex items-center gap-2 select-none',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
      )}
    >
      <span className="relative">
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="sr-only peer"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-describedby={ariaDescribedBy}
        />
        <span
          aria-hidden
          className={cn(
            'block h-6 w-11 rounded-full bg-border-strong transition-colors',
            'peer-checked:bg-blue-600',
            'peer-focus-visible:ring-2 peer-focus-visible:ring-blue-500 peer-focus-visible:ring-offset-1 peer-focus-visible:ring-offset-surface',
          )}
        />
        <span
          aria-hidden
          className={cn(
            'absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform',
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </span>
      {label && <span className="text-sm text-fg-muted">{label}</span>}
    </label>
  );
}
