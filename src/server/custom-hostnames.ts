import type { CfConfig } from './cloudflare'
import { cf, errorText } from './cloudflare'
import type { MasterEnv } from './env'

/**
 * Certificates for domains the platform does not own.
 *
 * This is the part that makes `api.theirdomain.com` work no matter where the
 * domain was bought. A CNAME only says "ask that host instead" — whoever
 * answers still needs a certificate for the name in the browser's address bar,
 * and a wildcard for our own zone obviously does not cover someone else's
 * domain. Cloudflare for SaaS issues one certificate per customer hostname,
 * which is exactly the missing piece.
 *
 * The operator's side stays plain DNS: one CNAME, from any registrar. This runs
 * on our side afterwards.
 */

export interface CustomHostname {
  id: string
  hostname: string
  status: string
  sslStatus: string
  /** what the operator must add if Cloudflare asks for TXT validation */
  validation?: { type: string; name: string; value: string }
}

function shape(result: Record<string, unknown>): CustomHostname {
  const ssl = (result.ssl ?? {}) as Record<string, unknown>
  const records = (ssl.validation_records ?? []) as Array<Record<string, string>>
  const txt = records.find((record) => record.txt_name)

  return {
    id: String(result.id),
    hostname: String(result.hostname),
    status: String(result.status ?? 'unknown'),
    sslStatus: String(ssl.status ?? 'unknown'),
    validation: txt
      ? { type: 'TXT', name: txt.txt_name, value: txt.txt_value }
      : undefined,
  }
}

export class CustomHostnameError extends Error {
  /** true when Cloudflare for SaaS is simply not switched on for the zone */
  notEnabled: boolean
  constructor(message: string, notEnabled = false) {
    super(message)
    this.name = 'CustomHostnameError'
    this.notEnabled = notEnabled
  }
}

async function saasZoneId(cfg: CfConfig, zoneName: string): Promise<string> {
  const zones = await cf<Array<{ id: string; name: string }>>(
    cfg,
    `/zones?name=${encodeURIComponent(zoneName)}&status=active`,
  )
  const zone = zones.result?.[0]
  if (!zone) throw new CustomHostnameError(`No active zone for ${zoneName}.`)
  return zone.id
}

/**
 * Where customer hostnames are sent once Cloudflare terminates them.
 *
 * Set once per zone. Everything then arrives at the dispatch Worker with the
 * customer's hostname intact, which is what lets it resolve the right node.
 */
export async function ensureFallbackOrigin(
  env: MasterEnv,
  cfg: CfConfig,
): Promise<{ ok: boolean; detail: string }> {
  if (!env.SAAS_ZONE || !env.ORIGIN_HOST) {
    return { ok: false, detail: 'SAAS_ZONE and ORIGIN_HOST must be set.' }
  }

  const zoneId = await saasZoneId(cfg, env.SAAS_ZONE)
  const current = await cf<{ origin?: string }>(
    cfg,
    `/zones/${zoneId}/custom_hostnames/fallback_origin`,
  )

  if (current.ok && current.result?.origin === env.ORIGIN_HOST) {
    return { ok: true, detail: `Already ${env.ORIGIN_HOST}.` }
  }

  const set = await cf(cfg, `/zones/${zoneId}/custom_hostnames/fallback_origin`, {
    method: 'PUT',
    body: JSON.stringify({ origin: env.ORIGIN_HOST }),
  })

  return set.ok
    ? { ok: true, detail: `Set to ${env.ORIGIN_HOST}.` }
    : { ok: false, detail: errorText(set) }
}

/** Registers a customer hostname, or returns the existing registration. */
export async function ensureCustomHostname(
  env: MasterEnv,
  cfg: CfConfig,
  hostname: string,
): Promise<CustomHostname> {
  if (!env.SAAS_ZONE) {
    throw new CustomHostnameError('SAAS_ZONE is not set on this platform.')
  }

  const zoneId = await saasZoneId(cfg, env.SAAS_ZONE)

  const existing = await cf<Array<Record<string, unknown>>>(
    cfg,
    `/zones/${zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
  )
  if (existing.ok && existing.result?.length) {
    return shape(existing.result[0])
  }

  const created = await cf<Record<string, unknown>>(
    cfg,
    `/zones/${zoneId}/custom_hostnames`,
    {
      method: 'POST',
      body: JSON.stringify({
        hostname,
        // TXT rather than HTTP validation. HTTP validation requires the
        // hostname to already answer over plain HTTP, which it cannot do until
        // the certificate exists — a deadlock in every case where the operator
        // points DNS at us and waits. A TXT record is independent of whether
        // anything is serving yet, so the certificate can be issued first.
        ssl: { method: 'txt', type: 'dv', settings: { min_tls_version: '1.2' } },
      }),
    },
  )

  if (!created.ok || !created.result) {
    const quota = created.errors?.some((error) => error.code === 1404)
    throw new CustomHostnameError(
      quota
        ? 'Cloudflare for SaaS is not enabled on this zone. It is free for the first 100 custom hostnames — turn it on under SSL/TLS → Custom Hostnames.'
        : errorText(created),
      quota,
    )
  }

  return shape(created.result)
}

export async function getCustomHostname(
  env: MasterEnv,
  cfg: CfConfig,
  hostname: string,
): Promise<CustomHostname | null> {
  if (!env.SAAS_ZONE) return null
  const zoneId = await saasZoneId(cfg, env.SAAS_ZONE)
  const existing = await cf<Array<Record<string, unknown>>>(
    cfg,
    `/zones/${zoneId}/custom_hostnames?hostname=${encodeURIComponent(hostname)}`,
  )
  return existing.ok && existing.result?.length ? shape(existing.result[0]) : null
}
