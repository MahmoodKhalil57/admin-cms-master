/**
 * Publishes a packed node image to a **public** GitHub release.
 *
 *   cd ../admin-cms-node-template && bun run build
 *   cd ../admin-cms-master && bun run publish:release
 *
 * This exists so a node can build projects on its operator's own
 * infrastructure without holding a key of ours. Master's own images live in a
 * private bucket read with our API token; a layer-2 node must not have that
 * token, and proxying the download through master would put our credential
 * back in the middle of somebody else's provisioning.
 *
 * A public release is the honest answer. Downloads from public repositories are
 * unmetered, so this costs nothing however many projects are created, and the
 * fetch needs no authentication at all. What it gives up is privacy of the
 * artifact — which it never really had, since most of it is already served to
 * every browser that opens a panel.
 *
 * `releases/latest/download/<name>` is a stable URL that always resolves to the
 * newest release, so a node does not have to be told a version to get a current
 * image.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

import { packed, packedBody } from './pack-image'

const REPO = process.env.IMAGE_REPO ?? 'MahmoodKhalil57/admincms-node-image'
const ASSET = 'node-image.json'
const tag = `v${packed.version}`

console.log(
  `image ${packed.version}: ${packed.modules.length} modules, ` +
    `${Object.keys(packed.assets).length} assets, ` +
    `${packed.migrations.length} migrations, ` +
    `${(packedBody.length / 1048576).toFixed(2)} MB`,
)

const file = join(tmpdir(), ASSET)
await writeFile(file, packedBody)

function gh(args: Array<string>): { ok: boolean; out: string } {
  const result = spawnSync('gh', args, { encoding: 'utf8' })
  return {
    ok: result.status === 0,
    out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim(),
  }
}

// Idempotent: the version is a content hash, so republishing an unchanged build
// finds its own release already there and only replaces the asset.
const existing = gh(['release', 'view', tag, '--repo', REPO])
if (!existing.ok) {
  const made = gh([
    'release', 'create', tag,
    '--repo', REPO,
    '--title', tag,
    '--notes', `Node image ${packed.version}. Fetched by nodes that build projects on their own infrastructure.`,
  ])
  if (!made.ok) {
    console.error(`Could not create release ${tag}: ${made.out}`)
    process.exit(1)
  }
  console.log(`created release ${tag}`)
}

const uploaded = gh([
  'release', 'upload', tag, `${file}#${ASSET}`,
  '--repo', REPO, '--clobber',
])
if (!uploaded.ok) {
  console.error(`Could not upload the image: ${uploaded.out}`)
  process.exit(1)
}

console.log(`published ${packed.version} to`)
console.log(`  https://github.com/${REPO}/releases/download/${tag}/${ASSET}`)
console.log(`  https://github.com/${REPO}/releases/latest/download/${ASSET}  (what nodes fetch)`)
