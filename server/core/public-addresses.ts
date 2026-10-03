// Which addresses the public access page shows and the self-check requests. Pure module, also
// imported by the page so both sides use the same rule.
import type { TunnelMode } from './config'

/**
 * Addresses to show and check. Own tunnel: the saved domain first, then what the tunnel routes
 * here. Quick tunnel (decision 31): only the *.trycloudflare.com address the running process
 * printed; the saved domain and the own tunnel's host names do not lead here then.
 */
export function publicAddresses(
  pub: { tunnelMode: TunnelMode, domain: string },
  tunnel: { hostnames: string[] | null | undefined, quickHost: string | null | undefined },
): string[] {
  const hosts = pub.tunnelMode === 'quick' ? [tunnel.quickHost ?? ''] : [pub.domain, ...(tunnel.hostnames ?? [])]
  return [...new Set(hosts.map(h => h.trim().toLowerCase()).filter(Boolean))]
}
