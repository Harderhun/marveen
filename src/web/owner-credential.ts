import type { RouteContext } from './routes/types.js'

// Is the caller the OWNER, as far as the dashboard can tell? Only a browser-login session or a
// full-scope device key says so. The shared dashboard token does not: every agent of the fleet
// can read it, so a route that must mean "a human decided" cannot accept it (measured on the
// skill-approve route, kanban 2c72e07c: a token caller read a quarantined skill's hash and put it
// live in the global root the whole fleet loads). An operator-scope device key is a limited key
// by design and does not count either.
export function isOwnerCredential(auth: RouteContext['auth']): boolean {
  return auth?.kind === 'session' || (auth?.kind === 'device' && auth.scope !== 'operator')
}
