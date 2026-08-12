/**
 * Packs a built node template and publishes it to master's R2 bucket.
 *
 *   cd ../admin-cms-node-template && bun run build
 *   cd ../admin-cms-master && bun run publish:image
 *
 * Master runs on a Worker with no filesystem, so this is the only way a node
 * image reaches it. Migrations travel inside the image alongside the code they
 * belong to, so a node can never be provisioned with code from one build and a
 * schema from another.
 *
 * The version is a content hash: an unchanged build republishes to the same key.
 */
import { createHash } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const NODE_TEMPLATE =
  process.env.NODE_TEMPLATE_DIR ??
  join(process.cwd(), '..', 'admin-cms-node-template')
const BUCKET = process.env.IMAGES_BUCKET ?? 'admincms-images'

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

const body = JSON.stringify(image)
console.log(
  `image ${version}: ${modules.length} modules, ${Object.keys(assets).length} assets, ` +
    `${migrations.length} migrations, ${(body.length / 1048576).toFixed(2)} MB`,
)

const imagePath = join(tmpdir(), `admincms-image-${version}.json`)
const pointerPath = join(tmpdir(), `admincms-current-${version}.json`)
await writeFile(imagePath, body)
await writeFile(
  pointerPath,
  JSON.stringify({ version, key: `node-template/${version}.json` }),
)

function put(key: string, file: string) {
  const result = spawnSync(
    'wrangler',
    ['r2', 'object', 'put', `${BUCKET}/${key}`, '--file', file, '--remote'],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) {
    console.error(`Failed to upload ${key}`)
    process.exit(1)
  }
}

put(`node-template/${version}.json`, imagePath)
// The pointer is written last, so a half-uploaded image is never the current one.
put('node-template/current.json', pointerPath)

console.log(`\npublished ${version} to r2://${BUCKET}/node-template/`)
