import { drizzle } from 'drizzle-orm/d1'

import type { MasterEnv } from '#/server/env'
import * as schema from './schema'

/**
 * Master's control-plane database.
 *
 * A factory, not a module-level client: the D1 binding only exists once a
 * request is in flight.
 */
export function getDb(env: MasterEnv) {
  return drizzle(env.DB, { schema })
}

export type MasterDb = ReturnType<typeof getDb>
