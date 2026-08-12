import { Form, required, useLogin, useNotify } from 'ra-core'
import { useState } from 'react'

import { TextInput } from '#/components/admin'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'

/**
 * Sign-in for the control plane.
 *
 * Replaces the vendored kit's login page, which ships "Acme Inc" branding and a
 * `janedoe@acme.com / password` hint. Deliberately offers no way to register —
 * accounts are seeded, and the sign-up endpoint is disabled server-side.
 */
export const LoginPage = ({
  title = 'adminCms',
  subtitle = 'Control plane',
}: {
  title?: string
  subtitle?: string
}) => {
  const login = useLogin()
  const notify = useNotify()
  const [busy, setBusy] = useState(false)

  const submit = (values: Partial<{ email: string; password: string }>) => {
    setBusy(true)
    login(values)
      .catch((error: Error) => {
        notify(error.message || 'Could not sign in.', { type: 'error' })
      })
      .finally(() => setBusy(false))
  }

  return (
    <div className="bg-muted flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <p className="text-muted-foreground text-sm">{subtitle}</p>
        </CardHeader>
        <CardContent>
          <Form onSubmit={submit}>
            <div className="flex flex-col gap-4">
              <TextInput
                source="email"
                type="email"
                validate={required()}
                autoFocus
              />
              <TextInput
                source="password"
                type="password"
                validate={required()}
              />
              <Button type="submit" disabled={busy}>
                {busy ? 'Signing in…' : 'Sign in'}
              </Button>
            </div>
          </Form>
        </CardContent>
      </Card>
    </div>
  )
}
