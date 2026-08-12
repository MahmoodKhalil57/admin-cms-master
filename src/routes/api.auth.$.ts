import { createFileRoute } from '@tanstack/react-router'

import { getAuth } from '#/lib/auth'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'

export const Route = createFileRoute('/api/auth/$')(
  serverRoute({
    GET: ({ request }) => getAuth(getEnv(request)).handler(request),
    POST: ({ request }) => getAuth(getEnv(request)).handler(request),
  }),
)
