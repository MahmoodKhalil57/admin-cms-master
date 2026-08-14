const API = 'https://api.cloudflare.com/client/v4'

export interface CfConfig {
  accountId: string
  apiToken: string
}

export interface CfResult<T = unknown> {
  ok: boolean
  status: number
  result?: T
  errors?: Array<{ code: number; message: string }>
}

/**
 * Minimal Cloudflare API client over plain `fetch`.
 *
 * Deliberately not the `cloudflare` SDK: its dispatch-namespace script upload
 * builds a multipart body and then forces `Content-Type: application/javascript`
 * over it, so the API reads the `--boundary` line as a decrement operator and
 * rejects the upload with a syntax error at `worker.js:1:4`. Any multipart call
 * here must let `fetch` set the boundary itself.
 */
export async function cf<T = unknown>(
  cfg: CfConfig,
  path: string,
  init: RequestInit = {},
): Promise<CfResult<T>> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${cfg.apiToken}`)
  // No Content-Type for FormData bodies — see above.
  if (init.body && typeof init.body === 'string') {
    headers.set('Content-Type', 'application/json')
  }

  const response = await fetch(`${API}${path}`, { ...init, headers })
  const text = await response.text()

  let body: { result?: T; errors?: Array<{ code: number; message: string }> } =
    {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = {
      errors: [{ code: 0, message: text.slice(0, 300) || 'non-JSON response' }],
    }
  }

  return {
    ok: response.ok,
    status: response.status,
    result: body.result,
    errors: body.errors,
  }
}

/**
 * Whether a failed create can be treated as success.
 *
 * Codes 10053 and 7003 are excluded: they carry conflict-ish wording but mean
 * something else, and swallowing them would hide a real failure.
 */
export function alreadyExists(res: CfResult): boolean {
  if (res.status === 409) return true
  if (!res.errors?.length) return false

  return res.errors.some((error) => {
    if (error.code === 10053 || error.code === 7003) return false
    return /already exists|duplicate|conflict/i.test(error.message)
  })
}

export function errorText(res: CfResult): string {
  if (!res.errors?.length) return `HTTP ${res.status}`
  return res.errors.map((e) => `${e.code}: ${e.message}`).join('; ')
}

// --- D1 -------------------------------------------------------------------

export async function createD1(cfg: CfConfig, name: string) {
  return cf<{ uuid: string }>(cfg, `/accounts/${cfg.accountId}/d1/database`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export async function findD1(cfg: CfConfig, name: string) {
  const res = await cf<Array<{ uuid: string; name: string }>>(
    cfg,
    `/accounts/${cfg.accountId}/d1/database?name=${encodeURIComponent(name)}&per_page=100`,
  )
  return res.result?.find((db) => db.name === name)?.uuid
}

/** Runs SQL against a database. Statements may be semicolon-joined. */
export async function queryD1(cfg: CfConfig, databaseId: string, sql: string) {
  return cf(cfg, `/accounts/${cfg.accountId}/d1/database/${databaseId}/query`, {
    method: 'POST',
    body: JSON.stringify({ sql }),
  })
}

export async function deleteD1(cfg: CfConfig, databaseId: string) {
  return cf(cfg, `/accounts/${cfg.accountId}/d1/database/${databaseId}`, {
    method: 'DELETE',
  })
}

// --- R2 -------------------------------------------------------------------

export async function createR2Bucket(cfg: CfConfig, name: string) {
  return cf(cfg, `/accounts/${cfg.accountId}/r2/buckets`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export async function deleteR2Bucket(cfg: CfConfig, name: string) {
  return cf(cfg, `/accounts/${cfg.accountId}/r2/buckets/${name}`, {
    method: 'DELETE',
  })
}

// --- KV -------------------------------------------------------------------

export async function createKvNamespace(cfg: CfConfig, title: string) {
  return cf<{ id: string }>(
    cfg,
    `/accounts/${cfg.accountId}/storage/kv/namespaces`,
    { method: 'POST', body: JSON.stringify({ title }) },
  )
}

/**
 * Finds a KV namespace by title.
 *
 * The list endpoint has no title filter, so this pages through. Cloudflare caps
 * `per_page` at 100.
 */
export async function findKvNamespace(cfg: CfConfig, title: string) {
  for (let page = 1; page <= 20; page++) {
    const res = await cf<Array<{ id: string; title: string }>>(
      cfg,
      `/accounts/${cfg.accountId}/storage/kv/namespaces?per_page=100&page=${page}`,
    )
    const hit = res.result?.find((ns) => ns.title === title)
    if (hit) return hit.id
    if (!res.result || res.result.length < 100) return undefined
  }
  return undefined
}

export async function deleteKvNamespace(cfg: CfConfig, namespaceId: string) {
  return cf(
    cfg,
    `/accounts/${cfg.accountId}/storage/kv/namespaces/${namespaceId}`,
    { method: 'DELETE' },
  )
}

// --- Workers for Platforms ------------------------------------------------

export async function getDispatchNamespace(cfg: CfConfig, name: string) {
  return cf<{ namespace_name: string }>(
    cfg,
    `/accounts/${cfg.accountId}/workers/dispatch/namespaces/${name}`,
  )
}

/**
 * Creates the dispatch namespace if it is missing.
 *
 * Checks with a GET first rather than creating and interpreting the failure:
 * creating a namespace that exists returns HTTP 400 code 100120, whose message
 * covers *both* "it already exists" and "the name is invalid". Treating that as
 * success would silently accept a malformed namespace name.
 */
export async function ensureDispatchNamespace(
  cfg: CfConfig,
  name: string,
): Promise<{ ok: boolean; created: boolean; res?: CfResult }> {
  const existing = await getDispatchNamespace(cfg, name)
  if (existing.ok) return { ok: true, created: false }

  const res = await cf(
    cfg,
    `/accounts/${cfg.accountId}/workers/dispatch/namespaces`,
    { method: 'POST', body: JSON.stringify({ name }) },
  )
  return res.ok
    ? { ok: true, created: true }
    : { ok: false, created: false, res }
}

export async function uploadDispatchScript(
  cfg: CfConfig,
  namespace: string,
  scriptName: string,
  form: FormData,
) {
  return cf(
    cfg,
    `/accounts/${cfg.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}`,
    { method: 'PUT', body: form },
  )
}

export async function deleteDispatchScript(
  cfg: CfConfig,
  namespace: string,
  scriptName: string,
) {
  return cf(
    cfg,
    `/accounts/${cfg.accountId}/workers/dispatch/namespaces/${namespace}/scripts/${scriptName}?force=true`,
    { method: 'DELETE' },
  )
}

/**
 * Every script in the dispatch namespace, by name.
 *
 * So the fleet can notice what it has forgotten. A script with no node row
 * behind it is never rolled and never torn down — it simply keeps answering on
 * whatever build it was left on, and nothing in master would ever mention it.
 */
export async function listDispatchScripts(
  cfg: CfConfig,
  namespace: string,
): Promise<Array<string>> {
  const answer = await cf<Array<{ id?: string; script_name?: string }>>(
    cfg,
    `/accounts/${cfg.accountId}/workers/dispatch/namespaces/${namespace}/scripts`,
  )
  if (!answer.ok) return []
  return (answer.result ?? [])
    .map((script) => script.script_name ?? script.id ?? '')
    .filter(Boolean)
}

/**
 * Puts a node's panel and API on a hostname that lives on the platform's zone.
 *
 * Two things have to be true and only one of them is a DNS record.
 *
 * The record must be **proxied**. A grey-cloud record goes straight to GitHub
 * Pages and never touches Cloudflare's edge, so a Worker route on it can never
 * fire — the website works and `/admin` and `/api` quietly do not. That was the
 * state this fixes: the records were written unproxied on the theory that
 * proxying breaks GitHub's certificate, and the node that has worked all along
 * has been proxied the entire time.
 *
 * Then the routes. Only `/admin*` and `/api*` go to the dispatcher; everything
 * else stays with Pages, which is what lets one hostname be both a website and
 * a node without either knowing about the other.
 *
 * Master does this rather than the node. It needs an account-scoped token that
 * must never reach a node, and the node's own Cloudflare connection is granted
 * DNS only — deliberately, since it is somebody else's account.
 */
export async function routeHostnameToDispatcher(
  cfg: CfConfig,
  hostname: string,
  script: string,
): Promise<{ ok: boolean; note: string }> {
  const root = hostname.split('.').slice(-2).join('.')
  const zones = await cf<Array<{ id: string; name: string }>>(
    cfg,
    `/zones?name=${encodeURIComponent(root)}`,
  )
  const zone = zones.result?.[0]
  if (!zone) {
    // Not our zone. That is the Cloudflare-for-SaaS case, handled elsewhere.
    return { ok: false, note: `${root} is not on this platform's account.` }
  }

  const records = await cf<Array<{ id: string; proxied: boolean }>>(
    cfg,
    `/zones/${zone.id}/dns_records?name=${encodeURIComponent(hostname)}&per_page=100`,
  )
  const record = records.result?.[0]
  if (!record) {
    return { ok: false, note: `No DNS record for ${hostname} yet.` }
  }
  if (!record.proxied) {
    const proxied = await cf(cfg, `/zones/${zone.id}/dns_records/${record.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ proxied: true }),
    })
    if (!proxied.ok) {
      return { ok: false, note: `Could not proxy the record for ${hostname}.` }
    }
  }

  const existing = await cf<Array<{ pattern: string }>>(
    cfg,
    `/zones/${zone.id}/workers/routes`,
  )
  const have = new Set((existing.result ?? []).map((route) => route.pattern))

  for (const pattern of [`${hostname}/admin*`, `${hostname}/api*`]) {
    if (have.has(pattern)) continue
    const made = await cf(cfg, `/zones/${zone.id}/workers/routes`, {
      method: 'POST',
      body: JSON.stringify({ pattern, script }),
    })
    if (!made.ok) {
      return { ok: false, note: `Could not add the route ${pattern}.` }
    }
  }

  return {
    ok: true,
    note: `${hostname}/admin and /api routed to this node; the rest stays with the website.`,
  }
}
