/**
 * Brings every node onto the current build.
 *
 *   bun run roll
 *
 * Which publishes the image to both places — master's private bucket for our
 * own nodes, and the public release that projects on other people's
 * infrastructure fetch — and then rolls the fleet.
 *
 * Master is not rolled. It is the thing holding the images, and it is deployed
 * with `bun run deploy` like any other application.
 */
const MASTER = process.env.MASTER_URL ?? 'https://admincms-master.the-montiapple.workers.dev'
const EMAIL = process.env.MASTER_EMAIL
const PASSWORD = process.env.MASTER_PASSWORD

if (!EMAIL || !PASSWORD) {
  console.error(
    'Set MASTER_EMAIL and MASTER_PASSWORD to roll the fleet from the command line,\n' +
      'or use the Fleet screen in master.',
  )
  process.exit(1)
}

const signIn = await fetch(`${MASTER}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: MASTER },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
})
if (!signIn.ok) {
  console.error(`Could not sign in to master (${signIn.status}).`)
  process.exit(1)
}
const cookie = signIn.headers.get('set-cookie') ?? ''

const before = await (
  await fetch(`${MASTER}/api/fleet`, { headers: { cookie } })
).json()
console.log(
  `current ${before.current?.slice(0, 12)} — ${before.behind} of ${before.nodes.length} node(s) behind`,
)
if (before.behind === 0) {
  console.log('nothing to roll')
  process.exit(0)
}

const response = await fetch(`${MASTER}/api/fleet`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', cookie, Origin: MASTER },
  body: JSON.stringify({}),
})
const result = (await response.json()) as {
  ok: boolean
  rolled: Array<{ slug: string; ok: boolean; from: string | null; to?: string; detail?: string }>
}

for (const one of result.rolled) {
  console.log(
    `  ${one.ok ? '✓' : '✗'} ${one.slug} ${one.from?.slice(0, 12) ?? '—'} -> ${one.to?.slice(0, 12) ?? '—'}` +
      (one.detail ? ` (${one.detail})` : ''),
  )
}
process.exit(result.ok ? 0 : 1)

export {}
