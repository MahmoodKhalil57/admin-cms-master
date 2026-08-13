/**
 * The template combos a project can be created from.
 *
 * A combo is a pair: a **repository** that new projects are cloned from, and
 * the **node** that maintains it. They are a pair because neither half is a
 * template on its own — the repo carries the markup, the content model and the
 * builder's drawings, while the node carries the forms those pages post to and
 * the panel they are edited in. Cloning one without the other gives a site with
 * nowhere to submit, or a node with nothing to serve.
 *
 * The base node is not a demo of the template; it *is* the template. Editing it
 * edits what future projects will start from, which is the point — a template
 * curated through the same panel operators use, rather than by hand-editing
 * files nobody previews.
 *
 * Code is the catalog, the database is the state, the same way features work.
 * A new combo is an entry here plus a repository; nothing has to migrate.
 */
export interface TemplateDefinition {
  /** stable id, recorded on every node created from it */
  key: string
  name: string
  description: string
  /** `owner/name` — what a new project's repository is generated from */
  repo: string
  /**
   * The node that maintains this template. It is a real, running node whose
   * repository *is* `repo`, so its panel edits the template directly.
   */
  baseNode?: string
  /** what a project created from this combo starts with switched on */
  features: Array<string>
}

export const TEMPLATE_CATALOG: Array<TemplateDefinition> = [
  {
    key: 'pure-frontend',
    name: 'Pure frontend',
    description:
      'A static site with no build step: forms, a visual page builder, and a content model its own editors can change.',
    repo: 'MahmoodKhalil57/pure-frontend',
    baseNode: 'livetest',
    features: ['forms', 'github-pages'],
  },
]

export const DEFAULT_TEMPLATE = TEMPLATE_CATALOG[0]!.key

export function templateFor(key?: string | null): TemplateDefinition {
  return (
    TEMPLATE_CATALOG.find((entry) => entry.key === key) ??
    TEMPLATE_CATALOG.find((entry) => entry.key === DEFAULT_TEMPLATE)!
  )
}

/** Which template a node maintains, if it is a base node rather than a project. */
export function templateMaintainedBy(
  slug: string,
): TemplateDefinition | undefined {
  return TEMPLATE_CATALOG.find((entry) => entry.baseNode === slug)
}
