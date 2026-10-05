// Data that never changes while Starkline runs (the permission policy, what each
// provider supports), loaded once and shared by every screen that shows it.
import { useEffect, useState } from "react";

const cache = new Map<string, Promise<unknown>>();

/** The value, or undefined until it loads; a failed load is retried next time. */
export function useOnce<T>(key: string, load: () => Promise<T>): T | undefined {
  const [value, setValue] = useState<T | undefined>(undefined);
  useEffect(() => {
    let live = true;
    let pending = cache.get(key) as Promise<T> | undefined;
    if (!pending) {
      pending = load();
      cache.set(key, pending);
      pending.catch(() => cache.delete(key));
    }
    pending.then((v) => live && setValue(v)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [key, load]);
  return value;
}
