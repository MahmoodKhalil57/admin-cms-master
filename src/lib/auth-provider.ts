import type { AuthProvider } from 'ra-core'

import { authClient } from '#/lib/auth-client'

interface Credentials {
  email: string
  password: string
}

/**
 * Bridges Better Auth to ra-core's `authProvider` contract.
 *
 * Note there is no `signUp` here and none is possible: ra-core's contract has
 * no such concept, and master disables the endpoint anyway.
 *
 * Session reads are memoised for a few seconds because ra-core calls
 * `checkAuth` on every navigation; without it each route change costs a
 * round trip.
 */
let cached: { at: number; session: unknown } | null = null
const CACHE_MS = 5_000

async function currentSession(force = false) {
  if (!force && cached && Date.now() - cached.at < CACHE_MS) {
    return cached.session as { user?: { id: string; name?: string; email: string; image?: string } } | null
  }
  const { data } = await authClient.getSession()
  cached = { at: Date.now(), session: data }
  return data as { user?: { id: string; name?: string; email: string; image?: string } } | null
}

export const authProvider: AuthProvider = {
  async login(params) {
    const { email, password } = params as Credentials
    const { error } = await authClient.signIn.email({ email, password })
    if (error) {
      throw new Error(error.message ?? 'Could not sign in.')
    }
    cached = null
    await currentSession(true)
  },

  async logout() {
    await authClient.signOut()
    cached = null
    return '/login'
  },

  async checkAuth() {
    const session = await currentSession()
    if (!session?.user) throw new Error('Not signed in.')
  },

  async checkError(error) {
    const status = (error as { status?: number }).status
    if (status === 401) {
      cached = null
      throw new Error('Session expired.')
    }
    // A 403 is an authorisation failure, not an authentication one — showing the
    // error beats bouncing a signed-in operator back to the login form.
    if (status === 403) throw { message: false, logoutUser: false }
  },

  async getIdentity() {
    const session = await currentSession()
    if (!session?.user) throw new Error('Not signed in.')
    return {
      id: session.user.id,
      fullName: session.user.name || session.user.email,
      avatar: session.user.image ?? undefined,
    }
  },

  async getPermissions() {
    const session = await currentSession()
    return session?.user ? { role: 'admin' } : null
  },
}
