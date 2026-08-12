import { createFileRoute } from '@tanstack/react-router'
import { getMigrations } from 'better-auth/db/migration'

import { getAuth } from '#/lib/auth'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'

/**
 * Creates master's auth tables and its first operator account.
 *
 * Sign-up is disabled, so this is the only way an account gets in. It exists as
 * a guarded route rather than a script because master runs on a Worker — the
 * D1 binding, and therefore Better Auth's Kysely adapter and `getMigrations()`,
 * only exist inside a request.
 *
 * Guarded by `MASTER_SEED_TOKEN`, which should be rotated or removed once the
 * first account exists. Idempotent: with a user already present it does
 * nothing, so this cannot be used to overwrite an operator's password.
 */
export const Route = createFileRoute('/api/internal/seed-admin')(
  serverRoute({
    POST: async ({ request }) => {
      const env = getEnv(request) as unknown as {
        MASTER_SEED_TOKEN?: string
      } & ReturnType<typeof getEnv>

      const expected = env.MASTER_SEED_TOKEN
      if (!expected || request.headers.get('authorization') !== `Bearer ${expected}`) {
        return Response.json({ error: 'Unauthorized' }, { status: 401 })
      }

      const body = (await request.json()) as {
        email?: string
        password?: string
        name?: string
      }
      if (!body.email || !body.password) {
        return Response.json(
          { error: 'email and password are required' },
          { status: 400 },
        )
      }

      const auth = getAuth(env)

      const { toBeCreated, toBeAdded, runMigrations } = await getMigrations(
        auth.options,
      )
      const migrated = toBeCreated.length > 0 || toBeAdded.length > 0
      if (migrated) await runMigrations()

      const ctx = await auth.$context

      const existing = await ctx.internalAdapter.findUserByEmail(body.email)
      if (existing) {
        return Response.json({ ok: true, migrated, seeded: false })
      }

      const user = await ctx.internalAdapter.createUser({
        email: body.email,
        name: body.name ?? 'Administrator',
        emailVerified: true,
      })

      // Without a credential account there is nothing for sign-in to check the
      // password against — a user row alone cannot log in.
      await ctx.internalAdapter.linkAccount({
        userId: user.id,
        accountId: user.id,
        providerId: 'credential',
        password: await ctx.password.hash(body.password),
      })

      return Response.json({ ok: true, migrated, seeded: true, userId: user.id })
    },
  }),
)
