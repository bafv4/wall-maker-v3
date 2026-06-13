/** Tailwind className を結合する軽量 helper。null/undefined/false を除去するだけ。 */
export type ClassValue =
  | string
  | number
  | null
  | undefined
  | false
  | ClassValue[];

export function cn(...inputs: ClassValue[]): string {
  const out: string[] = [];
  const visit = (v: ClassValue): void => {
    if (v === null || v === undefined || v === false || v === '') return;
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    out.push(String(v));
  };
  inputs.forEach(visit);
  return out.join(' ');
}
