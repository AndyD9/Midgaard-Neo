/**
 * @file Point d'entrée de `@midgaard/browser` (Slice 7) : le navigateur isolé
 * des agents — un Chromium jetable derrière un proxy gardé, dont aucun
 * processus ne survit.
 *
 * Le paquet ne connaît ni le daemon, ni la base, ni les approbations : il
 * ouvre une session, exécute ce qu'on lui demande, et dit ce qu'il a vu. Les
 * règles d'usage — session approuvée, saisie approuvée à chaque fois — sont
 * celles des outils (étape 4).
 */
export { startGuardedProxy, splitHostPort } from './proxy.ts'
export type { GuardedProxy, HostGuard, ProxyRefusal } from './proxy.ts'
export { ALLOWED_KEYS, BrowserError, BrowserSession, DEFAULT_VIEWPORT, NAVIGATION_TIMEOUT_MS } from './session.ts'
export type { AllowedKey, BrowserSessionOptions, PageState } from './session.ts'
