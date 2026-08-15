import { createFileRoute } from '@tanstack/react-router'

import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { getAuth } from '#/lib/auth'
import { getDb } from '#/db'
import { balances, grantCredits, usageFor } from '#/server/metering'
import { PRICE_LIST, PRICE_LIST_VERSION } from '#/lib/price-list'

/**
 * What the fleet has used, and what it has paid for.
 *
 * Master-side, so behind master's own session rather than a node's permission
 * system — everybody who can reach this console can already provision and
 * destroy nodes, and a bill is a smaller thing than that.
 *
 * `POST` puts credits in. It is the seam features 7 and 8 will attach a card
 * to; until then it is how somebody grants them by hand, which is also what an
 * operator wants on the day a customer pays by bank transfer.
 */
export const Route = createFileRoute('/api/usage')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const denied = await gate(env, request)
      if (denied) return denied

      const node = new URL(request.url).searchParams.get('node')

      return Response.json({
        priceListVersion: PRICE_LIST_VERSION,
        priceList: PRICE_LIST,
        balances: await balances(getDb(env)),
        periods: node ? await usageFor(getDb(env), Number(node)) : [],
      })
    },

    POST: async ({ request }) => {
      const env = getEnv(request)
      const denied = await gate(env, request)
      if (denied) return denied

      const body = (await request.json().catch(() => ({}))) as {
        nodeId?: number
        credits?: number
        amount?: number
        note?: string
        dedupeKey?: string
      }

      const credits = Math.trunc(Number(body.credits))
      if (!body.nodeId || !Number.isFinite(credits) || credits === 0) {
        return Response.json(
          { error: 'Which node, and how many credits?' },
          { status: 422 },
        )
      }

      const posted = await grantCredits(getDb(env), {
        nodeId: Number(body.nodeId),
        // By hand, so it says so. When a card pays for these the kind becomes
        // `purchase` and the dedupe key becomes the payment's id.
        kind: 'grant',
        credits,
        amount: Number(body.amount ?? 0),
        note: body.note ?? 'Granted from the console',
        dedupeKey: body.dedupeKey,
      })

      return Response.json({ ok: posted, credits })
    },
  }),
)

/** Master's own session, the same gate the fleet route uses. */
async function gate(
  env: ReturnType<typeof getEnv>,
  request: Request,
): Promise<Response | null> {
  const session = await getAuth(env).api.getSession({ headers: request.headers })
  return session ? null : Response.json({ error: 'Unauthorized' }, { status: 401 })
}
