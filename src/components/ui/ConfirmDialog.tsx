/**
 * ConfirmDialog — 破壊的操作の前に挟む確認ダイアログ。
 *
 * `window.confirm` の置き換え（CLAUDE.md「alert() を使わず非ブロッキング表示に統一」）。
 * バックドロップクリックでは閉じず（`dismissOnBackdrop=false`）、Escape / キャンセル /
 * 確定の明示操作だけで閉じる。確定ボタンは既定で danger 配色。
 */

import { Button, type ButtonVariant } from './Button';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  /** 確定ボタンの配色（既定: danger） */
  confirmVariant?: ButtonVariant;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel,
  cancelLabel,
  confirmVariant = 'danger',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      className="max-w-md"
      dismissOnBackdrop={false}
    >
      <p className="text-sm text-fg-muted">{message}</p>
      <div className="mt-6 flex justify-end gap-3">
        <Button variant="outline" size="sm" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={confirmVariant} size="sm" onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
