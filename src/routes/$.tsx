import { createFileRoute } from '@tanstack/react-router'

import { AdminApp } from '#/components/admin-app'

/**
 * Catch-all so react-admin's own routes (`/nodes`, `/nodes/1/edit`, …) resolve.
 * Without it every URL past `/` is a TanStack Router 404, because the admin
 * routes only exist inside ra-core.
 */
export const Route = createFileRoute('/$')({
  ssr: false,
  component: AdminApp,
})
