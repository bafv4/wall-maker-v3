import {
  createContext,
  useContext,
  useMemo,
  type ReactNode,
} from 'react';
import { cn } from './cn';

interface TabsContextValue {
  value: string;
  onValueChange: (next: string) => void;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabs(): TabsContextValue {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('Tabs.* must be used inside <Tabs>');
  return ctx;
}

export interface TabsProps {
  value: string;
  onValueChange: (next: string) => void;
  children: ReactNode;
  className?: string;
}

export function Tabs({ value, onValueChange, children, className }: TabsProps) {
  const ctx = useMemo<TabsContextValue>(
    () => ({ value, onValueChange }),
    [value, onValueChange],
  );
  return (
    <TabsContext.Provider value={ctx}>
      <div className={className}>{children}</div>
    </TabsContext.Provider>
  );
}

export function TabsList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex h-10 items-center gap-1 rounded-md bg-muted p-1',
        className,
      )}
    >
      {children}
    </div>
  );
}

export interface TabsTriggerProps {
  value: string;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
}

export function TabsTrigger({
  value,
  children,
  className,
  disabled,
}: TabsTriggerProps) {
  const tabs = useTabs();
  const active = tabs.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      onClick={() => tabs.onValueChange(value)}
      className={cn(
        // whitespace-nowrap: ボタン内でラベルが折り返さないようにする。タブが横幅に
        // 収まらないときは親コンテナの overflow-x-auto で横スクロールに切り替わる。
        'inline-flex h-8 items-center justify-center whitespace-nowrap rounded px-3.5 text-sm font-medium transition-colors',
        'cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
        active
          ? // アクティブタブは track より一段「持ち上げ」たい。surface(=slate-900) だと
            // ダークで track(slate-800) より暗く沈むため、ダークのみ slate-700 を当てる。
            'bg-white text-fg shadow-sm dark:bg-neutral-700'
          : 'text-fg-muted hover:text-fg',
        disabled && 'cursor-not-allowed opacity-50',
        className,
      )}
    >
      {children}
    </button>
  );
}

export interface TabsContentProps {
  value: string;
  children: ReactNode;
  className?: string;
}

export function TabsContent({ value, children, className }: TabsContentProps) {
  const tabs = useTabs();
  if (tabs.value !== value) return null;
  return (
    <div role="tabpanel" className={className}>
      {children}
    </div>
  );
}
