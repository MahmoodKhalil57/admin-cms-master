import type { CfConfig } from './cloudflare'
import {
  alreadyExists,
  createD1,
  createKvNamespace,
  createR2Bucket,
  deleteD1,
  deleteDispatchScript,
  deleteKvNamespace,
  deleteR2Bucket,
  ensureDispatchNamespace,
  errorText,
  findD1,
  findKvNamespace,
  queryD1,
  uploadDispatchScript,
} from './cloudflare'
import type { MasterEnv } from './env'
import { DISPATCH_NAMESPACE, planNode } from './node-plan'
import type { Binding, NodeImage } from './node-image'
import { buildUploadForm, loadImageFromR2 } from './node-image'
import { uploadNodeAssets } from './node-assets'
import { templateFor } from '#/lib/template-catalog'

export interface ProvisionStep {
  name: string
  status: 'created' | 'already-existed' | 'skipped' | 'failed'
  detail?: string
}

export interface ProvisionResult {
  ok: boolean
  slug: string
  steps: Array<ProvisionStep>
  d1DatabaseId?: string
  kvNamespaceId?: string
  templateVersion?: string
  /** which template combo was used */
  templateKey?: string
  /** one-time password for the seeded owner, returned only on first creation */
  ownerPassword?: string
  error?: string
}

export interface NodeOwner {
  /** the master account id this operator corresponds to */
  masterUserId: string
  email: string
  name?: string
}

export function cfConfigFrom(env: MasterEnv): CfConfig {
  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.CLOUDFLARE_API_TOKEN) {
    throw new Error(
      'CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN must be set on the Worker.',
    )
  }
  return {
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
  }
}

/**
 * Where a node is reachable, so master can finish setting it up.
 *
 * Prefers the real mechanism — one hostname per node — and falls back to the
 * dispatcher's `/n/<slug>` path form, which is what exists before a domain is
 * bought.
 */
export function nodeBaseUrl(env: MasterEnv, slug: string): string | undefined {
  if (env.NODE_ZONE) return `https://${slug}.${env.NODE_ZONE}`
  return env.DISPATCHER_URL
    ? `${env.DISPATCHER_URL.replace(/\/+$/, '')}/n/${slug}`
    : undefined
}

/**
 * Derives one of a node's secrets from the master key.
 *
 * Deterministic on purpose, for two reasons. Re-uploading a node's Worker must
 * not invalidate every operator session it has open, which a freshly generated
 * signing secret would do. And the provisioning token has to be accepted by
 * whichever version of the script is actually answering — dispatch lookups are
 * eventually consistent, so a token minted for the upload that just happened is
 * rejected by the version still being served.
 */
export async function deriveNodeSecret(
  env: MasterEnv,
  slug: string,
  purpose: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(env.MASTER_NODE_KEY),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${purpose}:${slug}`),
  )
  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Asks a freshly uploaded node to migrate its auth tables and create its owner.
 *
 * Retried because dispatch-namespace lookups are eventually consistent — a
 * Worker that was just uploaded can 404 or 503 for a few seconds before it
 * starts resolving.
 */
async function seedNodeOwner(
  env: MasterEnv,
  slug: string,
  token: string,
  owner: NodeOwner,
  password: string,
): Promise<{ ok: boolean; detail: string }> {
  const base = nodeBaseUrl(env, slug)
  if (!base) {
    return {
      ok: false,
      detail: 'no NODE_ZONE or DISPATCHER_URL set, so the node is unreachable',
    }
  }

  let lastDetail = 'no attempt made'

  // Worker-to-Worker over workers.dev is refused with Cloudflare error 1042, so
  // this goes through the service binding whenever one is configured. Plain
  // fetch is the fallback for a node on its own domain.
  const send: typeof fetch = env.GATEWAY
    ? (input, init) =>
        (env.GATEWAY as { fetch: typeof fetch }).fetch(input, init)
    : fetch

  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const response = await send(`${base}/api/internal/provision`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          email: owner.email,
          name: owner.name,
          password,
          masterUserId: owner.masterUserId,
        }),
      })

      const text = await response.text()
      if (response.ok) {
        const body = JSON.parse(text) as { seeded?: boolean }
        return {
          ok: true,
          detail: body.seeded
            ? `owner ${owner.email} created`
            : 'owner already existed',
        }
      }
      lastDetail = `HTTP ${response.status}: ${text.slice(0, 160)}`
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : String(error)
    }

    await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
  }

  return { ok: false, detail: lastDetail }
}

/**
 * Creates every Cloudflare resource a node owns, then uploads its Worker.
 *
 * Ordered storage-first, Worker-last: the expensive, hard-to-undo step goes at
 * the end, so a failure earlier leaves nothing serving. Each step is idempotent
 * — a resource that already exists is success, and the existing id is recovered
 * so a retry rebinds the same database rather than stranding it.
 *
 * There is no automatic rollback. On failure the caller keeps the ids that were
 * captured and can retry or tear down explicitly; silently deleting a database
 * that may already hold a node's data is not a decision this function should
 * make on its own.
 */
export async function provisionNode(
  env: MasterEnv,
  slug: string,
  options: { owner?: NodeOwner; template?: string | null } = {},
): Promise<ProvisionResult> {
  // Which repository this node's sites are generated from. A combo rather than
  // one fleet-wide setting, so a second template needs a catalog entry and not
  // a redeploy of every node.
  const template = templateFor(options.template)
  const plan = planNode(slug)
  const cfg = cfConfigFrom(env)
  const steps: Array<ProvisionStep> = []

  let d1DatabaseId: string | undefined
  let kvNamespaceId: string | undefined

  const fail = (error: string): ProvisionResult => ({
    ok: false,
    slug,
    templateKey: template.key,
    steps,
    d1DatabaseId,
    kvNamespaceId,
    error,
  })

  // 1. D1 — its id is the handle every later step binds against, so a failure
  //    to capture it stops everything.
  const d1 = await createD1(cfg, plan.d1Name)
  if (d1.ok && d1.result?.uuid) {
    d1DatabaseId = d1.result.uuid
    steps.push({ name: 'd1', status: 'created', detail: d1DatabaseId })
  } else if (alreadyExists(d1)) {
    d1DatabaseId = await findD1(cfg, plan.d1Name)
    if (!d1DatabaseId) {
      steps.push({
        name: 'd1',
        status: 'failed',
        detail: 'exists but not found',
      })
      return fail(`D1 ${plan.d1Name} already exists but could not be resolved`)
    }
    steps.push({ name: 'd1', status: 'already-existed', detail: d1DatabaseId })
  } else {
    steps.push({ name: 'd1', status: 'failed', detail: errorText(d1) })
    return fail(`Creating D1 ${plan.d1Name} failed: ${errorText(d1)}`)
  }

  // 2. R2
  const r2 = await createR2Bucket(cfg, plan.r2Bucket)
  if (r2.ok)
    steps.push({ name: 'r2', status: 'created', detail: plan.r2Bucket })
  else if (alreadyExists(r2)) {
    steps.push({ name: 'r2', status: 'already-existed', detail: plan.r2Bucket })
  } else {
    steps.push({ name: 'r2', status: 'failed', detail: errorText(r2) })
    return fail(`Creating R2 bucket ${plan.r2Bucket} failed: ${errorText(r2)}`)
  }

  // 3. KV
  const kv = await createKvNamespace(cfg, plan.kvTitle)
  if (kv.ok && kv.result?.id) {
    kvNamespaceId = kv.result.id
    steps.push({ name: 'kv', status: 'created', detail: kvNamespaceId })
  } else if (alreadyExists(kv)) {
    kvNamespaceId = await findKvNamespace(cfg, plan.kvTitle)
    if (!kvNamespaceId) {
      steps.push({
        name: 'kv',
        status: 'failed',
        detail: 'exists but not found',
      })
      return fail(`KV ${plan.kvTitle} already exists but could not be resolved`)
    }
    steps.push({ name: 'kv', status: 'already-existed', detail: kvNamespaceId })
  } else {
    steps.push({ name: 'kv', status: 'failed', detail: errorText(kv) })
    return fail(`Creating KV ${plan.kvTitle} failed: ${errorText(kv)}`)
  }

  // 4. Image. Read before the schema step because the migrations travel inside
  //    it — code and schema come from the same build or not at all.
  let image: NodeImage
  try {
    image = await loadImageFromR2(env.IMAGES)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    steps.push({ name: 'image', status: 'failed', detail })
    return fail(detail)
  }
  steps.push({
    name: 'image',
    status: 'created',
    detail: `${image.version} (${image.modules.length} modules, ${Object.keys(image.assets).length} assets)`,
  })

  // 5. Schema. Applied here rather than on the node's first request, because a
  //    node that migrates at request time makes its first visitor wait for it
  //    (and time out).
  try {
    const applied = await applyNodeSchema(cfg, d1DatabaseId, image)
    steps.push({
      name: 'schema',
      status: 'created',
      detail: `${applied} statements`,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    steps.push({ name: 'schema', status: 'failed', detail })
    return fail(`Applying the node schema failed: ${detail}`)
  }

  // 6. Namespace
  const namespace = await ensureDispatchNamespace(cfg, DISPATCH_NAMESPACE)
  if (!namespace.ok) {
    const detail = namespace.res ? errorText(namespace.res) : 'unknown'
    steps.push({ name: 'namespace', status: 'failed', detail })
    return fail(
      `Could not ensure dispatch namespace ${DISPATCH_NAMESPACE}: ${detail}`,
    )
  }
  steps.push({
    name: 'namespace',
    status: namespace.created ? 'created' : 'already-existed',
    detail: DISPATCH_NAMESPACE,
  })

  // 7. Assets
  let assetsJwt: string | null = null
  try {
    assetsJwt = await uploadNodeAssets(
      cfg,
      DISPATCH_NAMESPACE,
      plan.scriptName,
      image.assets,
    )
    steps.push({ name: 'assets', status: assetsJwt ? 'created' : 'skipped' })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    steps.push({ name: 'assets', status: 'failed', detail })
    return fail(`Uploading assets failed: ${detail}`)
  }

  // 8. Worker
  // Derived rather than random, so the version of the script that is currently
  // being served accepts it even if it predates this upload.
  const provisionToken = await deriveNodeSecret(env, slug, 'provision')

  const bindings: Array<Binding> = [
    { type: 'd1', name: 'DB', id: d1DatabaseId },
    { type: 'r2_bucket', name: 'MEDIA', bucket_name: plan.r2Bucket },
    { type: 'kv_namespace', name: 'KV', namespace_id: kvNamespaceId },
    { type: 'plain_text', name: 'NODE_ID', text: slug },
    { type: 'plain_text', name: 'NODE_NAME', text: slug },
    // The node cannot work its own public address out from a request, because
    // the dispatch Worker strips the /n/<slug> prefix before forwarding.
    {
      type: 'plain_text',
      name: 'PUBLIC_URL',
      text: nodeBaseUrl(env, slug) ?? '',
    },
    // One OAuth callback serves the whole fleet, because Cloudflare matches
    // redirect_uri exactly and cannot take a per-node path.
    {
      type: 'plain_text',
      name: 'OAUTH_CALLBACK_BASE',
      text: (env.DISPATCHER_URL ?? '').replace(/\/+$/, ''),
    },
    // The one hostname every custom domain is CNAMEd at, so the DNS
    // instruction is identical wherever the domain was bought.
    {
      type: 'plain_text',
      name: 'ORIGIN_HOST',
      text: env.ORIGIN_HOST ?? '',
    },
    // A service binding, not a URL: a Worker cannot fetch another Worker over
    // workers.dev (Cloudflare error 1042), and a node has to reach master for
    // the platform-side half of custom hostnames.
    {
      type: 'service',
      name: 'MASTER',
      service: env.MASTER_SCRIPT ?? 'admincms-master',
      environment: 'production',
    },
    // secret_text, not plain_text: neither of these may be readable back out of
    // the Workers API.
    {
      type: 'secret_text',
      name: 'BETTER_AUTH_SECRET',
      text: await deriveNodeSecret(env, slug, 'auth'),
    },
    { type: 'secret_text', name: 'PROVISION_TOKEN', text: provisionToken },
  ]

  // The GitHub app is platform-level; a node that has the feature switched off
  // simply never uses these.
  if (env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET) {
    bindings.push(
      {
        type: 'plain_text',
        name: 'GITHUB_CLIENT_ID',
        text: env.GITHUB_CLIENT_ID,
      },
      {
        type: 'secret_text',
        name: 'GITHUB_CLIENT_SECRET',
        text: env.GITHUB_CLIENT_SECRET,
      },
    )
  }
  // Optional: lets a node offer to write DNS records for an operator whose
  // domain is already on Cloudflare.
  if (env.CLOUDFLARE_CLIENT_ID && env.CLOUDFLARE_CLIENT_SECRET) {
    bindings.push(
      {
        type: 'plain_text',
        name: 'CLOUDFLARE_CLIENT_ID',
        text: env.CLOUDFLARE_CLIENT_ID,
      },
      {
        type: 'secret_text',
        name: 'CLOUDFLARE_CLIENT_SECRET',
        text: env.CLOUDFLARE_CLIENT_SECRET,
      },
    )
  }

  // Lets a node register a verified custom domain with the router.
  if (env.ROUTING_KV_ID) {
    bindings.push({
      type: 'kv_namespace',
      name: 'ROUTING',
      namespace_id: env.ROUTING_KV_ID,
    })
  }
  // The combo's repository, falling back to the fleet-wide setting for nodes
  // provisioned before there was a catalog.
  const templateRepo = template.repo || env.GITHUB_TEMPLATE_REPO
  if (templateRepo) {
    bindings.push({
      type: 'plain_text',
      name: 'GITHUB_TEMPLATE_REPO',
      text: templateRepo,
    })
  }
  if (assetsJwt) bindings.push({ type: 'assets', name: 'ASSETS' })

  const upload = await uploadDispatchScript(
    cfg,
    DISPATCH_NAMESPACE,
    plan.scriptName,
    buildUploadForm(image, bindings, assetsJwt),
  )

  if (!upload.ok) {
    steps.push({ name: 'worker', status: 'failed', detail: errorText(upload) })
    return fail(`Uploading the node Worker failed: ${errorText(upload)}`)
  }
  steps.push({ name: 'worker', status: 'created', detail: plan.scriptName })

  // 9. Owner. The node creates its own auth tables and hashes the password with
  //    its own Better Auth instance — master only supplies the identity and the
  //    master user id that links the two accounts.
  let ownerPassword: string | undefined
  if (options.owner) {
    ownerPassword = crypto.randomUUID()
    const seeded = await seedNodeOwner(
      env,
      slug,
      provisionToken,
      options.owner,
      ownerPassword,
    )
    steps.push({
      name: 'owner',
      status: seeded.ok ? 'created' : 'failed',
      detail: seeded.detail,
    })
    if (!seeded.ok)
      return fail(`Seeding the node owner failed: ${seeded.detail}`)
  } else {
    steps.push({ name: 'owner', status: 'skipped', detail: 'no owner given' })
  }

  return {
    ok: true,
    slug,
    steps,
    d1DatabaseId,
    kvNamespaceId,
    templateVersion: image.version,
    templateKey: template.key,
    ownerPassword,
  }
}

/** Runs the migrations carried in the image against a node's database. */
async function applyNodeSchema(
  cfg: CfConfig,
  databaseId: string,
  image: NodeImage,
): Promise<number> {
  if (image.migrations.length === 0) {
    throw new Error('The published image carries no migrations.')
  }

  let count = 0
  for (const migration of image.migrations) {
    for (const statement of migration.sql
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean)) {
      // Re-running provisioning must not fail on tables that already exist.
      const guarded = statement
        .replace(/^CREATE TABLE /i, 'CREATE TABLE IF NOT EXISTS ')
        .replace(/^CREATE INDEX /i, 'CREATE INDEX IF NOT EXISTS ')
        .replace(/^CREATE UNIQUE INDEX /i, 'CREATE UNIQUE INDEX IF NOT EXISTS ')

      const res = await queryD1(cfg, databaseId, guarded)
      if (!res.ok) throw new Error(errorText(res))
      count++
    }
  }

  return count
}

/**
 * Removes a node's Cloudflare resources.
 *
 * Reverse of provisioning — the Worker goes first so the node stops serving
 * before its data disappears. Every name is derived from the slug, never read
 * back from a record, so this can only ever address `n-`-prefixed resources.
 *
 * Note that dispatch-namespace lookups are eventually consistent: requests to a
 * just-deleted node can still succeed for a few seconds. Deletion is fine;
 * suspension needs a check in the dispatch Worker instead.
 */
export async function deprovisionNode(
  env: MasterEnv,
  slug: string,
  options: { d1DatabaseId?: string; kvNamespaceId?: string } = {},
): Promise<ProvisionResult> {
  const plan = planNode(slug)
  const cfg = cfConfigFrom(env)
  const steps: Array<ProvisionStep> = []

  const worker = await deleteDispatchScript(
    cfg,
    DISPATCH_NAMESPACE,
    plan.scriptName,
  )
  steps.push({
    name: 'worker',
    status: worker.ok ? 'created' : 'failed',
    detail: worker.ok ? plan.scriptName : errorText(worker),
  })

  const d1Id = options.d1DatabaseId ?? (await findD1(cfg, plan.d1Name))
  if (d1Id) {
    const res = await deleteD1(cfg, d1Id)
    steps.push({ name: 'd1', status: res.ok ? 'created' : 'failed' })
  } else {
    steps.push({ name: 'd1', status: 'skipped', detail: 'not found' })
  }

  const kvId =
    options.kvNamespaceId ?? (await findKvNamespace(cfg, plan.kvTitle))
  if (kvId) {
    const res = await deleteKvNamespace(cfg, kvId)
    steps.push({ name: 'kv', status: res.ok ? 'created' : 'failed' })
  } else {
    steps.push({ name: 'kv', status: 'skipped', detail: 'not found' })
  }

  // R2 last, and only the bucket — a bucket with objects in it will refuse to
  // delete, which is the right outcome: discarding someone's uploads should be
  // an explicit, separate act.
  const r2 = await deleteR2Bucket(cfg, plan.r2Bucket)
  steps.push({
    name: 'r2',
    status: r2.ok ? 'created' : 'failed',
    detail: r2.ok ? plan.r2Bucket : errorText(r2),
  })

  return { ok: steps.every((s) => s.status !== 'failed'), slug, steps }
}
