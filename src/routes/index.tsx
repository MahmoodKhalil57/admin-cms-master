import { createFileRoute } from '@tanstack/react-router'

import { AdminApp } from '#/components/admin-app'

export const Route = createFileRoute('/')({
  ssr: false,
  component: AdminApp,
})
