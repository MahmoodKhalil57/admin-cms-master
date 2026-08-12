import { createFileRoute } from '@tanstack/react-router'

import { getDb } from '#/db'
import { deleteResource, getResource, updateResource } from '#/lib/rest'
import { serverRoute } from '#/lib/server-route'
import { getEnv } from '#/server/env'

export const Route = createFileRoute('/api/$resource/$id')(
  serverRoute({
    GET: ({ request, params }) =>
      getResource(getDb(getEnv(request)), params.resource, params.id),
    PUT: ({ request, params }) =>
      updateResource(getDb(getEnv(request)), params.resource, params.id, request),
    DELETE: ({ request, params }) =>
      deleteResource(getDb(getEnv(request)), params.resource, params.id),
  }),
)
