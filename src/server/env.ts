import type {
  D1Database,
  ExecutionContext,
  Fetcher,
  R2Bucket,
} from '@cloudflare/workers-types'

/**
 * Master's Cloudflare bindings and secrets.
 *
 * Master holds the Cloudflare API token, which is account-wide write access to
 * every node's database, bucket and script. That is why it is a secret binding
 * and never leaves this Worker.
 */
export interface MasterEnv {
  /** master's own control-plane database */
  DB: D1Database
  /** built node-template images, content-addressed assets */
  IMAGES: R2Bucket
  /**
   * Service binding to the dispatch Worker.
   *
   * Required, not an optimisation: a Worker cannot fetch another Worker over
   * `workers.dev` — the subrequest fails with Cloudflare error 1042. Master has
   * to reach a freshly provisioned node to seed its owner, so that call goes
   * through this binding rather than over the public internet.
   */
  GATEWAY?: Fetcher

  CLOUDFLARE_ACCOUNT_ID: string
  CLOUDFLARE_API_TOKEN: string
  BETTER_AUTH_SECRET: string
  /** derives each node's session secret; must be stable */
  MASTER_NODE_KEY: string
  /** where provisioned nodes answer, so master can finish setting them up */
  DISPATCHER_URL?: string
  NODE_ZONE?: string

  /**
   * The platform's GitHub OAuth app, handed to every node that runs the
   * github-pages feature.
   *
   * Platform-level, not per node: one OAuth app serves the whole fleet, so the
   * credentials belong to master and are injected as node bindings. Which nodes
   * actually *use* them is still the node's own decision.
   */
  GITHUB_CLIENT_ID?: string
  GITHUB_CLIENT_SECRET?: string
  /** repo new sites are generated from, as `owner/repo` */
  GITHUB_TEMPLATE_REPO?: string
  /**
   * Id of the shared hostname -> node KV namespace.
   *
   * Bound into every node so a node can register its own custom domain, and
   * read by the dispatch Worker to resolve one.
   */
  ROUTING_KV_ID?: string
}

type CloudflareRequest = Request & {
  runtime?: { cloudflare?: { env: MasterEnv; context: ExecutionContext } }
}

/**
 * Reads the bindings for the current request.
 *
 * Nitro's Cloudflare handler sets both `globalThis.__env__` and
 * `request.runtime.cloudflare` on every fetch, and neither exists at module
 * scope — so nothing may build a database client or auth instance at import
 * time. That works under `vite dev` and throws on the first production request.
 */
export function getEnv(request?: Request): MasterEnv {
  const fromRequest = (request as CloudflareRequest | undefined)?.runtime
    ?.cloudflare?.env
  if (fromRequest?.DB) return fromRequest

  const fromGlobal = (globalThis as { __env__?: MasterEnv }).__env__
  if (fromGlobal?.DB) return fromGlobal

  throw new Error(
    'Cloudflare bindings unavailable — getEnv() was called outside a request.',
  )
}
