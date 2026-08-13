import type { MasterEnv } from './env'
import { cfConfigFrom } from './provision'
import type { CfConfig } from './cloudflare'

/**
 * Sending mail on a node's behalf.
 *
 * Cloudflare rather than an email provider, and it lives here rather than in
 * the node for one reason each.
 *
 * Cloudflare, because it turns out to be enough: a sending domain is onboarded
 * per zone and Cloudflare writes the MX, SPF, DKIM and DMARC records itself
 * when it is authoritative. Three thousand messages a month are free. The one
 * thing it will not do is send as a domain we do not host — `subdomain must be
 * within zone` — so a tenant on a subdomain of ours sends as itself, and a
 * tenant insisting on their own brand domain has to point its nameservers here.
 *
 * Here rather than in the node, because sending needs an account-wide
 * Cloudflare token and a node must never hold one. Nodes ask over the service
 * binding they already have, proving who they are with the same derived token
 * provisioning uses.
 */

interface CfResult<T> {
  success: boolean
  errors?: Array<{ code?: number; message?: string }>
  result?: T
}

async function cf<T>(
  cfg: CfConfig,
  method: string,
  path: string,
  body?: unknown,
): Promise<CfResult<T>> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.apiToken}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  return (await response.json()) as CfResult<T>
}

function errorText(result: CfResult<unknown>): string {
  return (
    result.errors?.map((error) => error.message).filter(Boolean).join('; ') ||
    'Cloudflare refused that.'
  )
}

/** The zone in this account that a hostname belongs to, if any. */
async function zoneFor(
  cfg: CfConfig,
  hostname: string,
): Promise<{ id: string; name: string } | null> {
  const zones = await cf<Array<{ id: string; name: string }>>(
    cfg,
    'GET',
    `/zones?account.id=${cfg.accountId}&per_page=50`,
  )
  if (!zones.success) return null

  // The longest matching suffix, so `a.b.example.com` prefers `b.example.com`
  // over `example.com` when both are held here.
  const matches = (zones.result ?? []).filter(
    (zone) => hostname === zone.name || hostname.endsWith(`.${zone.name}`),
  )
  matches.sort((a, b) => b.name.length - a.name.length)
  return matches[0] ?? null
}

interface Subdomain {
  id: string
  name: string
  enabled?: boolean
}

/**
 * Make sure this hostname can send, and say what address it sends from.
 *
 * Idempotent: onboarding the same name twice returns the existing entry, which
 * matters because this runs on every provision.
 */
export async function ensureSendingDomain(
  env: MasterEnv,
  hostname: string,
): Promise<{ ok: boolean; from?: string; domain?: string; note: string }> {
  const cfg = cfConfigFrom(env)
  const zone = await zoneFor(cfg, hostname)
  if (!zone) {
    return {
      ok: false,
      note: `${hostname} is not a zone in this account, and Cloudflare only sends from domains it hosts.`,
    }
  }

  const listed = await cf<Array<Subdomain>>(
    cfg,
    'GET',
    `/zones/${zone.id}/email/sending/subdomains`,
  )
  if (!listed.success) return { ok: false, note: errorText(listed) }

  const existing = (listed.result ?? []).find((entry) => entry.name === hostname)
  if (existing) {
    return {
      ok: true,
      domain: hostname,
      from: `invites@${hostname}`,
      note: 'Already able to send.',
    }
  }

  const created = await cf<Subdomain>(
    cfg,
    'POST',
    `/zones/${zone.id}/email/sending/subdomains`,
    { name: hostname },
  )
  if (!created.success) return { ok: false, note: errorText(created) }

  // Cloudflare writes the MX, SPF, DKIM and DMARC records into the zone itself
  // when it is authoritative, which it is for anything it let us onboard.
  return {
    ok: true,
    domain: hostname,
    from: `invites@${hostname}`,
    note: 'Sending set up.',
  }
}

export interface OutgoingMail {
  to: string
  from: string
  subject: string
  text: string
  html: string
}

export async function sendMail(
  env: MasterEnv,
  mail: OutgoingMail,
): Promise<{ ok: boolean; id?: string; note: string }> {
  const cfg = cfConfigFrom(env)
  const sent = await cf<{ message_id?: string; delivered?: Array<string> }>(
    cfg,
    'POST',
    `/accounts/${cfg.accountId}/email/sending/send`,
    {
      from: mail.from,
      to: [mail.to],
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    },
  )

  if (!sent.success) return { ok: false, note: errorText(sent) }
  return {
    ok: true,
    id: sent.result?.message_id,
    note: sent.result?.delivered?.length ? 'Delivered.' : 'Queued.',
  }
}
