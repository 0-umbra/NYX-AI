/** Reveal complete response text in bounded, Unicode-safe chunks; this is not network streaming. */
export async function revealText(text, { signal, onText, delay = 30, maxDuration = 2400 } = {}) {
  const chars = Array.from(text);
  const chunk = Math.max(2, Math.ceil(chars.length / Math.max(1, maxDuration / delay)));
  for (let i = 0; i < chars.length; i += chunk) {
    if (signal?.aborted) throw new DOMException('Request cancelled.', 'AbortError');
    onText(chars.slice(i, i + chunk).join(''));
    if (i + chunk < chars.length) {
      await new Promise((resolve, reject) => {
        const stop = () => { clearTimeout(timer); reject(new DOMException('Request cancelled.', 'AbortError')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, delay);
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted) stop();
      });
    }
  }
}
