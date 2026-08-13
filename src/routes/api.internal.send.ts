import { createFileRoute } from '@tanstack/react-router'
import { eq } from 'drizzle-orm'

import { getDb } from '#/db'
import { nodes } from '#/db/schema'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { deriveNodeSecret } from '#/server/provision'
import { ensureSendingDomain, sendMail } from '#/server/email'

/**
 * Sends a message for a node.
 *
 * Master holds the Cloudflare credential because sending is account-scoped and
 * an account-wide token must never sit inside a node. The node proves it is
 * itself with the same derived token provisioning uses — nothing extra is
 * stored, and a node can only ever ask on its own behalf.
 *
 * The `from` address is decided here, not passed in. A node that could name its
 * own sender could send as any tenant on the platform.
 */
export const Route = createFileRoute('/api/internal/send')(
  serverRoute({
    POST: async ({ request }) => {
      const env = getEnv(request)
      const body = (await request.json()) as {
        slug?: string
        to?: string
        subject?: string
        text?: string
        html?: string
        /** the node's own hostname, used to pick the sending domain */
        hostname?: string
      }

      if (!body.slug) {
        return Response.json({ error: 'Which node?' }, { status: 400 })
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

      if (!body.to || !body.subject || !body.text) {
        return Response.json({ error: 'Nothing to send' }, { status: 400 })
      }

      // The node's own hostname when we host it, and the platform address
      // otherwise — an invitation from us beats one that never arrives.
      const preferred = body.hostname || node.hostname || ''
      let from = env.MAIL_FROM ?? ''
      if (preferred) {
        const domain = await ensureSendingDomain(env, preferred)
        if (domain.ok && domain.from) from = domain.from
      }
      if (!from) {
        return Response.json(
          { error: 'This platform has no sending address configured.' },
          { status: 503 },
        )
      }

      const sent = await sendMail(env, {
        to: body.to,
        from,
        subject: body.subject,
        text: body.text,
        html: body.html ?? `<p>${body.text}</p>`,
      })

      return Response.json(
        { ok: sent.ok, from, id: sent.id, note: sent.note },
        { status: sent.ok ? 200 : 502 },
      )
    },
  }),
)
