/** The dispatch namespace adminCms nodes live in. */
export const DISPATCH_NAMESPACE = 'admincms-nodes'

/**
 * The `n-` prefix is a safety boundary, not a naming preference.
 *
 * This Cloudflare account is shared with live production projects, including
 * odash's `t-`-prefixed tenants. Teardown deletes by *derived* name only, so
 * every resource a node owns must be reconstructible from its slug alone and
 * must carry the prefix. Nothing here is ever read back from the database.
 */
export const NODE_PREFIX = 'n-'

/** 3–32 chars, starts with a letter, no trailing dash. */
const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/

export interface NodePlan {
  slug: string
  scriptName: string
  d1Name: string
  r2Bucket: string
  kvTitle: string
}

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug)
}

export function planNode(slug: string): NodePlan {
  if (!isValidSlug(slug)) {
    throw new Error(
      `Invalid node slug "${slug}" — 3-32 chars, lowercase letters, digits and dashes, starting with a letter.`,
    )
  }

  return {
    slug,
    scriptName: `${NODE_PREFIX}${slug}`,
    d1Name: `${NODE_PREFIX}${slug}`,
    r2Bucket: `${NODE_PREFIX}${slug}-media`,
    kvTitle: `${NODE_PREFIX}${slug}-session`,
  }
}
