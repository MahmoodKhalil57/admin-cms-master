import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { nodes } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import {
  CustomHostnameError,
  ensureCustomHostname,
  ensureFallbackOrigin,
} from '#/server/custom-hostnames'
import { getEnv } from '#/server/env'
import { cfConfigFrom, deriveNodeSecret } from '#/server/provision'

/**
 * Registers a customer hostname so Cloudflare issues a certificate for it.
 *
 * Master does this rather than the node, because it acts on the platform's own
 * zone with an account-wide token that must never reach a node. The node proves
 * it is itself with the same derived token provisioning uses — master
 * recomputes it, so nothing extra is stored or shared.
 */
/** Fetches a hostname from outside and reports what answered. */
async function probeHostname(
  hostname: string,
): Promise<{ site: number; api: number; node?: string }> {
  const get = async (path: string) => {
    try {
      const response = await fetch(`https://${hostname}${path}`, {
        headers: { accept: 'application/json' },
      })
      return { status: response.status, body: await response.text() }
    } catch {
      return { status: 0, body: '' }
    }
  }

  const site = await get('/')
  const api = await get('/api/health')

  let node: string | undefined
  try {
    node = (JSON.parse(api.body) as { node?: string }).node
  } catch {
    node = undefined
  }

  return { site: site.status, api: api.status, node }
}

export const Route = createFileRoute('/api/internal/hostname')(
  serverRoute({
    POST: async ({ request }) => {
      const env = getEnv(request)
      const body = (await request.json().catch(() => ({}))) as {
        slug?: string
        hostname?: string
      }

      if (!body.slug || !body.hostname) {
        return Response.json(
          { error: 'slug and hostname are required' },
          { status: 400 },
        )
      }

      const expected = await deriveNodeSecret(env, body.slug, 'provision')
      if (request.headers.get('authorization') !== `Bearer ${expected}`) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const [node] = await getDb(env)
        .select()
        .from(nodes)
        .where(eq(nodes.slug, body.slug))
        .limit(1)
      if (!node) return Response.json({ error: 'Unknown node' }, { status: 404 })

      try {
        const cfg = cfConfigFrom(env)
        // Cheap and idempotent, and it has to be right before any hostname can
        // work — so it is checked here rather than assumed to have been done.
        await ensureFallbackOrigin(env, cfg)

        const registered = await ensureCustomHostname(env, cfg, body.hostname)

        // Master probes rather than the node, for two reasons: a Worker's
        // subrequest to a hostname on its own zone bypasses the Worker route
        // (Cloudflare avoids the loop) and lands on the origin instead, and a
        // proxied record hides its CNAME so inspecting DNS answers nothing.
        // Asking from outside is the only way to learn whether it serves.
        const probe = await probeHostname(body.hostname)

        return Response.json({ ok: true, ...registered, probe })
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error)
        return Response.json(
          {
            ok: false,
            error: message,
            notEnabled:
              error instanceof CustomHostnameError ? error.notEnabled : false,
          },
          { status: 400 },
        )
      }
    },
  }),
)
