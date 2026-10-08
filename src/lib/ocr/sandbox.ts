/**
 * Defence in depth for the OCR worker. A dedicated worker loaded from a file:// script gets the policy of its own response, and
 * file:// responses carry no Content-Security-Policy header, so the page CSP does not restrict it (evidence/ocr/spike.md, section 1).
 * Before any engine code runs, every network and code-loading entry point of the worker scope is replaced by a non-configurable
 * stub that throws. The engine is handed its bytes and never needs any of them.
 */
export const BLOCKED_WORKER_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebTransport', 'EventSource', 'importScripts', 'Worker', 'SharedWorker', 'BroadcastChannel'] as const;

/** Returns the names that are now blocked (a global the scope does not have is skipped, a non-configurable one is reported missing). */
export function blockNetworkAccess(scope: object): string[] {
  const blocked: string[] = [];
  for (const name of BLOCKED_WORKER_GLOBALS) {
    if (!(name in scope)) continue;
    const stub = function blockedGlobal(): never { throw new Error(`${name} is disabled in the text recognition worker.`); };
    try {
      Object.defineProperty(scope, name, { value: stub, configurable: false, writable: false, enumerable: false });
      blocked.push(name);
    } catch { /* a non-configurable global stays; it is simply not reported as blocked */ }
  }
  return blocked;
}
