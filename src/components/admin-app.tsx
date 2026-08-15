import { Resource } from 'ra-core'
import { Gauge, Layers } from 'lucide-react'
import { tanStackRouterProvider } from 'ra-router-tanstack'

import { Admin } from '#/components/admin'
import { LoginPage } from '#/components/login-page'
import { FleetPage } from '#/components/resources/fleet'
import { UsagePage } from '#/components/resources/usage'
import { authProvider } from '#/lib/auth-provider'
import { dataProvider } from '#/lib/data-provider'
import {
  NodeCreate,
  NodeEdit,
  NodeList,
  NodeShow,
} from '#/components/resources/nodes'

/**
 * The master console.
 *
 * Mounted from both `/` and the `/$` splat so that react-admin's client-side
 * URLs (`/nodes`, `/nodes/1`, …) resolve — with only an index route they are a
 * router 404. Both mounts set `ssr: false`: the vendored kit's `breadcrumb.tsx`
 * reads `document` during render, and `ra-router-tanstack` falls back to a hash
 * history when it can't find a router, so this subtree must not be server-
 * rendered.
 *
 * `disableTelemetry` stops the vendored `<Admin>` beaconing the hostname to
 * marmelab in production.
 */
export function AdminApp() {
  return (
    <Admin
      routerProvider={tanStackRouterProvider}
      dataProvider={dataProvider}
      authProvider={authProvider}
      loginPage={LoginPage}
      requireAuth
      disableTelemetry
      title="adminCms"
    >
      <Resource
        name="fleet"
        options={{ label: 'Fleet' }}
        list={FleetPage}
        icon={Layers}
      />
      <Resource
        name="usage"
        options={{ label: 'Usage' }}
        list={UsagePage}
        icon={Gauge}
      />
      <Resource
        name="nodes"
        list={NodeList}
        edit={NodeEdit}
        create={NodeCreate}
        show={NodeShow}
        recordRepresentation="name"
      />
    </Admin>
  )
}
