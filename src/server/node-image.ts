import type { R2Bucket } from '@cloudflare/workers-types'

/**
 * A built node template, packed into one object.
 *
 * Master runs on a Worker and has no filesystem, so the whole image — Worker
 * modules, client assets and the schema migrations that go with them — is
 * stored in R2 and read through a binding. Keeping the migrations *inside* the
 * image is what stops a node being provisioned with code from one build and a
 * schema from another.
 */
export interface NodeImage {
  /** content hash of the build; identical source gives an identical version */
  version: string
  mainModule: string
  modules: Array<{ path: string; source: string }>
  /** public path -> base64 bytes */
  assets: Record<string, string>
  /** the node's Drizzle migrations, in order */
  migrations: Array<{ name: string; sql: string }>
  compatibilityDate: string
  compatibilityFlags: Array<string>
}

export const IMAGE_PREFIX = 'node-template'
export const CURRENT_POINTER = `${IMAGE_PREFIX}/current.json`

export function imageKey(version: string): string {
  return `${IMAGE_PREFIX}/${version}.json`
}

/**
 * Cloudflare identifies an asset by the first 32 hex chars of its sha256.
 *
 * Uses Web Crypto so the same function works on a Worker and in the Node
 * packing script; `node:crypto` is not available in both.
 */
export async function assetHash(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32)
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
}

export function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.')
  return (
    (dot >= 0 ? CONTENT_TYPES[path.slice(dot).toLowerCase()] : undefined) ??
    'application/octet-stream'
  )
}

/** Reads the published image from R2, newest unless a version is named. */
export async function loadImageFromR2(
  bucket: R2Bucket,
  version?: string,
): Promise<NodeImage> {
  let key = version ? imageKey(version) : undefined

  if (!key) {
    const pointer = await bucket.get(CURRENT_POINTER)
    if (!pointer) {
      throw new Error(
        `No node image published — run \`bun run publish:image\` (missing ${CURRENT_POINTER}).`,
      )
    }
    key = ((await pointer.json()) as { key: string }).key
  }

  const object = await bucket.get(key)
  if (!object) throw new Error(`Node image ${key} is missing from R2.`)

  return (await object.json()) as NodeImage
}

export type Binding =
  | { type: 'd1'; name: string; id: string }
  | { type: 'r2_bucket'; name: string; bucket_name: string }
  | { type: 'kv_namespace'; name: string; namespace_id: string }
  | { type: 'plain_text'; name: string; text: string }
  | { type: 'secret_text'; name: string; text: string }
  | { type: 'assets'; name: string }

/**
 * Builds the multipart body for a script upload.
 *
 * Each module is added with its path as BOTH the part name and the filename.
 * Cloudflare keys the module by the filename, so a part named `_libs/x.mjs`
 * carrying filename `x.mjs` uploads cleanly and then fails at boot with
 * `No such module`.
 */
export function buildUploadForm(
  image: NodeImage,
  bindings: Array<Binding>,
  assetsJwt?: string | null,
): FormData {
  const form = new FormData()

  const metadata: Record<string, unknown> = {
    main_module: image.mainModule,
    compatibility_date: image.compatibilityDate,
    compatibility_flags: image.compatibilityFlags,
    bindings,
  }
  if (assetsJwt) metadata.assets = { jwt: assetsJwt }

  form.set('metadata', JSON.stringify(metadata))

  for (const module of image.modules) {
    form.set(
      module.path,
      new File([module.source], module.path, {
        type: 'application/javascript+module',
      }),
    )
  }

  return form
}
