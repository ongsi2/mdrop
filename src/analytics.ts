import { inject, pageview, track } from '@vercel/analytics';

type PublicRoute = '/' | '/en/' | '/install/' | '/en/install/';

const ROUTES = new Set<PublicRoute>(['/', '/en/', '/install/', '/en/install/']);
const enabled = import.meta.env.PROD;
let initialized = false;

function publicRoute(): PublicRoute {
  const path = location.pathname.endsWith('/') ? location.pathname : `${location.pathname}/`;
  return ROUTES.has(path as PublicRoute) ? (path as PublicRoute) : '/';
}

/* Only public route names leave the browser. An open document's title,
   filename, heading hash, query string and contents never become analytics
   fields. History tracking stays off because pushState marks private reader
   state rather than a new public page. */
export function initAnalytics(): void {
  if (!enabled || initialized) return;
  initialized = true;
  inject({
    mode: 'production',
    disableAutoTrack: true,
    beforeSend: (event) => ({
      ...event,
      url: new URL(publicRoute(), location.origin).href,
    }),
  });
  const route = publicRoute();
  pageview({ route, path: route });
}

export type IntakeMethod =
  | 'picker'
  | 'input'
  | 'drop-file'
  | 'drop-folder'
  | 'paste-file'
  | 'paste-text'
  | 'recent'
  | 'launch'
  | 'handoff'
  | 'sample';

export function trackDocumentOpen(method: IntakeMethod): void {
  if (enabled) track('Document Open', { method });
}

export function trackInstallResult(
  result: 'prompt' | 'accepted' | 'dismissed' | 'installed' | 'manual',
): void {
  if (enabled) track('Install', { result });
}
