/**
 * Safe key/value storage. Uses localStorage when it works, otherwise keeps data in memory
 * so the app never crashes (private mode, blocked storage, quota errors).
 */
const NS = 'nyx.';

export function createStorage(backend) {
  const mem = new Map();
  let usable = Boolean(backend);
  if (usable) {
    try {
      backend.setItem(`${NS}__probe`, '1');
      backend.removeItem(`${NS}__probe`);
    } catch {
      usable = false;
    }
  }

  return {
    get persistent() { return usable; },
    get(key, fallback = null) {
      try {
        const raw = usable ? backend.getItem(NS + key) : mem.get(NS + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      const raw = JSON.stringify(value);
      try {
        if (usable) backend.setItem(NS + key, raw);
        else mem.set(NS + key, raw);
        return true;
      } catch {
        return false; // quota exceeded or storage blocked
      }
    },
    remove(key) {
      try { if (usable) backend.removeItem(NS + key); } catch { /* ignore */ }
      mem.delete(NS + key);
    },
    clear() {
      try {
        if (usable) {
          for (let i = backend.length - 1; i >= 0; i--) {
            const k = backend.key(i);
            if (k && k.startsWith(NS)) backend.removeItem(k);
          }
        }
      } catch { /* ignore */ }
      mem.clear();
    },
  };
}

function defaultBackend() {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export const storage = createStorage(defaultBackend());
