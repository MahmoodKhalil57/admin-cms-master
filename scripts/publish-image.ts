/**
 * Publishes a packed node image to master's private R2 bucket.
 *
 *   cd ../admin-cms-node-template && bun run build
 *   cd ../admin-cms-master && bun run publish:image
 *
 * Master runs on a Worker with no filesystem, so this is the only way an image
 * reaches it. The packing itself lives in `pack-image.ts`, shared with the
 * public release publisher.
 */
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

import { packed, packedBody } from './pack-image'

const BUCKET = process.env.IMAGES_BUCKET ?? 'admincms-images'

const body = packedBody
const { version, modules, assets, migrations } = packed
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
