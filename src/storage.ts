const memory = new Map<string, string>();

/**
 * Browser storage is optional. Privacy settings and embedded browsers can
 * throw even while reading `localStorage`, so callers always get a usable
 * in-memory fallback for the current visit.
 */
export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key) ?? memory.get(key) ?? null;
  } catch {
    return memory.get(key) ?? null;
  }
}

export function safeSet(key: string, value: string): boolean {
  memory.set(key, value);
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function safeRemove(key: string): void {
  memory.delete(key);
  try {
    localStorage.removeItem(key);
  } catch {
    // The in-memory value is already gone.
  }
}
