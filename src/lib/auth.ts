import { betterAuth } from 'better-auth'

import type { MasterEnv } from '#/server/env'

/**
 * Master's authentication.
 *
 * Sign-up is disabled outright: the operator account is seeded (see
 * `scripts/seed-admin.ts`), and there is no public registration path into the
 * control plane — so the endpoint should not exist rather than be hidden.
 *
 * The D1 binding is passed raw rather than through a Drizzle adapter, because
 * Better Auth's `getMigrations()` only works with its built-in Kysely adapter.
 * That is what lets the seed route create the auth tables in a fresh database.
 */
function createAuth(env: MasterEnv) {
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    // Left unset so Better Auth infers it from the request — master answers on
    // a workers.dev host now and a custom domain later.
    basePath: '/api/auth',
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
    },
    session: {
      // Keeps ra-core's per-navigation `checkAuth` off the database.
      cookieCache: { enabled: true, maxAge: 60 },
    },
  })
}

export type MasterAuth = ReturnType<typeof createAuth>

const cache = new WeakMap<MasterEnv, MasterAuth>()

export function getAuth(env: MasterEnv): MasterAuth {
  const hit = cache.get(env)
  if (hit) return hit

  const auth = createAuth(env)
  cache.set(env, auth)
  return auth
}
