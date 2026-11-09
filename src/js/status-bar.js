/** Native edge-to-edge status-bar setup. No-op in the browser/PWA. */
import { Capacitor } from '@capacitor/core';
import { StatusBar, Style } from '@capacitor/status-bar';

/** Keeps Android system indicators legible over each supported app theme. */
export function syncStatusBar(theme) {
  if (!Capacitor.isNativePlatform()) return;

  // `Style.Dark` is the plugin's light-text mode; `Style.Light` is dark text.
  const style = theme === 'light' ? Style.Light : Style.Dark;
  void Promise.all([
    StatusBar.setOverlaysWebView({ overlay: true }),
    StatusBar.setStyle({ style }),
  ]).catch((error) => console.warn('[NYX] status bar setup failed', error));
}
