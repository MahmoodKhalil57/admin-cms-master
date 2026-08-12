import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { createResource, listResource } from '#/lib/rest'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'

export const Route = createFileRoute('/api/$resource/')(
  serverRoute({
    GET: ({ request, params }) =>
      listResource(
        getDb(getEnv(request)),
        params.resource,
        new URL(request.url),
      ),
    POST: ({ request, params }) =>
      createResource(getDb(getEnv(request)), params.resource, request),
  }),
)
