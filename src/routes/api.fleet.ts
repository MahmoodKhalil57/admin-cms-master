import { createFileRoute } from '@tanstack/react-router'

import { getAuth } from '#/lib/auth'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'
import { fleetState, rollFleet } from '#/server/fleet'

/**
 * What every node is running, and bringing them all to one build.
 *
 * `GET` answers the only question worth asking about a fleet — *is any of this
 * out of date* — and `POST` fixes it. Everything below master shares one image;
 * master is excluded because it is the thing holding the images.
 */
export const Route = createFileRoute('/api/fleet')(
  serverRoute({
    GET: async ({ request }) => {
      const env = getEnv(request)
      const session = await getAuth(env).api.getSession({
        headers: request.headers,
      })
      if (!session) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }
      return Response.json(await fleetState(env))
    },

    /**
     * Rolls the fleet. Slow by nature — one Worker upload per node, in
     * sequence — and safe to run again, because provisioning is idempotent and
     * a node already on the current build is skipped.
     */
    POST: async ({ request }) => {
      const env = getEnv(request)
      const session = await getAuth(env).api.getSession({
        headers: request.headers,
      })
      if (!session) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const body = (await request.json().catch(() => ({}))) as {
        only?: Array<string>
        /** roll even the ones already current, for a forced redeploy */
        all?: boolean
      }

      const result = await rollFleet(env, {
        only: body.only,
        includeCurrent: Boolean(body.all),
      })

      const failed = result.rolled.filter((one) => !one.ok)
      return Response.json(
        {
          ok: failed.length === 0,
          current: result.current,
          rolled: result.rolled,
          failed: failed.length,
        },
        { status: failed.length ? 207 : 200 },
      )
    },
  }),
)
