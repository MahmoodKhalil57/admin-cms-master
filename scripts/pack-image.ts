/**
 * Packs a built node template into the image both publishers send.
 *
 * Lifted out of `publish-image.ts` when a second publisher arrived: nodes that
 * create their own projects fetch the image from a public GitHub release rather
 * than from master's private bucket, and an image packed two slightly different
 * ways is a bug that only shows up on somebody else's infrastructure.
 *
 * Migrations travel inside the image alongside the code they belong to, so a
 * project can never be provisioned with code from one build and a schema from
 * another. The version is a content hash: an unchanged build packs identically.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const NODE_TEMPLATE =
  process.env.NODE_TEMPLATE_DIR ??
  join(process.cwd(), '..', 'admin-cms-node-template')

async function walk(dir: string): Promise<Array<string>> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath ?? dir, entry.name))
}

const serverDir = join(NODE_TEMPLATE, '.output', 'server')
const publicDir = join(NODE_TEMPLATE, '.output', 'public')
const migrationsDir = join(NODE_TEMPLATE, 'drizzle')

// Modules. Paths stay relative to .output/server and posix-separated, because
// Cloudflare resolves imports by that exact string.
const modules: Array<{ path: string; source: string }> = []
for (const file of await walk(serverDir)) {
  if (!file.endsWith('.mjs') && !file.endsWith('.js')) continue
  modules.push({
    path: relative(serverDir, file).split(sep).join('/'),
    source: await readFile(file, 'utf8'),
  })
}
modules.sort((a, b) => a.path.localeCompare(b.path))

const assets: Record<string, string> = {}
try {
  for (const file of await walk(publicDir)) {
    assets['/' + relative(publicDir, file).split(sep).join('/')] = (
      await readFile(file)
    ).toString('base64')
  }
} catch {
  // A build with no client assets is legitimate.
}

const migrations: Array<{ name: string; sql: string }> = []
for (const name of (await readdir(migrationsDir))
  .filter((f) => f.endsWith('.sql'))
  .sort()) {
  migrations.push({ name, sql: await readFile(join(migrationsDir, name), 'utf8') })
}

if (migrations.length === 0) {
  console.error(
    `No migrations in ${migrationsDir} — run \`bun run db:generate\` in the node template.`,
  )
  process.exit(1)
}

const generated = JSON.parse(
  await readFile(join(serverDir, 'wrangler.json'), 'utf8'),
) as { compatibility_date?: string; compatibility_flags?: Array<string> }

const digest = createHash('sha256')
for (const m of modules) digest.update(m.path).update(m.source)
for (const p of Object.keys(assets).sort()) digest.update(p).update(assets[p])
for (const m of migrations) digest.update(m.name).update(m.sql)
const version = digest.digest('hex').slice(0, 16)

const image = {
  version,
  mainModule: 'index.mjs',
  modules,
  assets,
  migrations,
  compatibilityDate: generated.compatibility_date ?? '2025-07-13',
  compatibilityFlags: generated.compatibility_flags ?? ['nodejs_compat'],
}


export const packed = image
export const packedBody = JSON.stringify(image)
