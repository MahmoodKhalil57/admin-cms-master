import type { CfConfig } from './cloudflare'
import { cf } from './cloudflare'
import { assetHash, contentTypeFor } from './node-image'

interface UploadSession {
  jwt?: string
  /** hashes Cloudflare does NOT already hold, grouped into upload batches */
  buckets?: Array<Array<string>>
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Uploads a node's static assets and returns the completion token.
 *
 * Three steps, and the endpoints differ in a way that is easy to get wrong:
 *
 *  1. Register a manifest of `path -> {hash, size}` against the *dispatch-
 *     namespaced* script URL. Cloudflare answers with a JWT plus the buckets of
 *     hashes it is missing — and it holds them across versions and nodes, so on
 *     an unchanged build that list is empty and nothing is uploaded. That is
 *     what keeps provisioning the hundredth node as cheap as the second.
 *  2. Upload each bucket base64-encoded to the *account-level* assets endpoint,
 *     authenticated with the session JWT rather than the API token.
 *  3. The final bucket's response carries the completion token, which goes into
 *     the script upload metadata as `assets.jwt`.
 *
 * Returns null when the build has no assets at all.
 */
export async function uploadNodeAssets(
  cfg: CfConfig,
  namespace: string,
  scriptName: string,
  assets: Record<string, string>,
): Promise<string | null> {
  const paths = Object.keys(assets)
  if (paths.length === 0) return null

  const byHash = new Map<string, { path: string; base64: string }>()
  const manifest: Record<string, { hash: string; size: number }> = {}

  for (const path of paths) {
    const base64 = assets[path]
    const bytes = base64ToBytes(base64)
    const hash = await assetHash(bytes)
    manifest[path] = { hash, size: bytes.length }
    byHash.set(hash, { path, base64 })
  }

  const session = await cf<UploadSession>(
    cfg,
    `/accounts/${cfg.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}/assets-upload-session`,
    { method: 'POST', body: JSON.stringify({ manifest }) },
  )

  if (!session.ok) {
    throw new Error(
      `assets-upload-session failed: ${JSON.stringify(session.errors)}`,
    )
  }

  const buckets = session.result?.buckets ?? []
  // Nothing missing: Cloudflare already holds every byte from a previous
  // version or another node, so the session JWT is the completion token.
  if (buckets.every((bucket) => bucket.length === 0)) {
    return session.result?.jwt ?? null
  }

  let completionToken = session.result?.jwt ?? null

  for (const bucket of buckets) {
    if (bucket.length === 0) continue

    const form = new FormData()
    for (const hash of bucket) {
      const asset = byHash.get(hash)
      if (!asset) continue
      form.set(
        hash,
        new File([asset.base64], hash, { type: contentTypeFor(asset.path) }),
      )
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${cfg.accountId}/workers/assets/upload?base64=true`,
      {
        method: 'POST',
        // The session JWT, not the API token — and no Content-Type, so fetch
        // sets the multipart boundary itself.
        headers: { Authorization: `Bearer ${session.result?.jwt}` },
        body: form,
      },
    )

    const body = (await response.json()) as {
      result?: { jwt?: string }
      errors?: unknown
    }

    if (!response.ok) {
      throw new Error(
        `asset bucket upload failed: ${JSON.stringify(body.errors)}`,
      )
    }
    if (body.result?.jwt) completionToken = body.result.jwt
  }

  return completionToken
}
