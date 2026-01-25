/**
 * Game mode switching - standalone vs multiplayer
 *
 * - Standalone: Current local-only demo, no network
 * - Multiplayer: Connect to server, use network state
 */

// ============================================================================
// Types
// ============================================================================

export type GameMode = 'standalone' | 'multiplayer';

export interface ModeConfig {
  serverUrl: string;
}

// ============================================================================
// Mode Detection
// ============================================================================

/**
 * Get game mode from URL parameters
 * Default: standalone (preserves current demo behavior)
 *
 * Usage:
 *   ?mode=standalone  - Local only (default)
 *   ?mode=multiplayer - Connect to server
 *   ?mode=multiplayer&server=ws://localhost:8080 - Custom server URL
 */
export function getModeFromUrl(): { mode: GameMode; config: ModeConfig } {
  const params = new URLSearchParams(window.location.search);

  const modeParam = params.get('mode');
  const mode: GameMode = modeParam === 'multiplayer' ? 'multiplayer' : 'standalone';

  const serverUrl = params.get('server') || getDefaultServerUrl();

  return {
    mode,
    config: { serverUrl },
  };
}

/**
 * Get default server URL based on current location
 */
function getDefaultServerUrl(): string {
  // In development, use localhost
  if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
    return 'ws://localhost:8080';
  }

  // In production, use wss:// with same host
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

/**
 * Check if running in multiplayer mode
 */
export function isMultiplayer(): boolean {
  return getModeFromUrl().mode === 'multiplayer';
}

/**
 * Check if running in standalone mode
 */
export function isStandalone(): boolean {
  return getModeFromUrl().mode === 'standalone';
}

/**
 * Get URL for switching modes (for UI)
 */
export function getModeUrl(mode: GameMode): string {
  const url = new URL(window.location.href);
  url.searchParams.set('mode', mode);
  return url.toString();
}
