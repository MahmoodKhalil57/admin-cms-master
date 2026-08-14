import { useEffect, useState } from 'react'
import { useNotify } from 'ra-core'
import { RefreshCw } from 'lucide-react'

import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '#/components/ui/card'

/**
 * What every node is running.
 *
 * Everything below master shares one build, so the only question this screen
 * has to answer is whether any of them does not — and the count is the answer.
 * Master is not listed: it is the thing holding the images, so it is never one
 * of the things being rolled.
 */

interface FleetNode {
  id: number
  slug: string
  status: string
  version: string | null
  behind: boolean
}

interface RollOutcome {
  slug: string
  ok: boolean
  from: string | null
  to?: string
  detail?: string
}

const short = (version: string | null) =>
  version ? version.slice(0, 12) : '—'

export const FleetPage = () => {
  const notify = useNotify()
  const [current, setCurrent] = useState<string | null>(null)
  const [nodes, setNodes] = useState<Array<FleetNode>>([])
  const [busy, setBusy] = useState(false)
  const [rolled, setRolled] = useState<Array<RollOutcome>>([])
  const [orphans, setOrphans] = useState<Array<string>>([])

  const load = () =>
    fetch('/api/fleet')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!body) return
        setCurrent(body.current)
        setNodes(body.nodes ?? [])
        setOrphans(body.orphans ?? [])
      })
      .catch(() => undefined)

  useEffect(() => {
    void load()
  }, [])

  const behind = nodes.filter((node) => node.behind)

  const roll = async (all: boolean) => {
    setBusy(true)
    setRolled([])
    try {
      const response = await fetch('/api/fleet', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all }),
      })
      const body = await response.json()
      setRolled(body.rolled ?? [])
      notify(
        body.ok
          ? `${(body.rolled ?? []).length} node(s) on ${short(body.current)}.`
          : `${body.failed} node(s) did not roll.`,
        { type: body.ok ? 'success' : 'warning' },
      )
      await load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex w-full min-w-0 max-w-4xl flex-col gap-6">
      <h2 className="font-display text-2xl font-semibold tracking-tight">
        Fleet
      </h2>

      <Card>
        <CardHeader>
          <CardTitle>
            {behind.length === 0
              ? 'Every node is on the current build'
              : `${behind.length} node${behind.length > 1 ? 's are' : ' is'} behind`}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-sm">
          <p className="text-muted-foreground">
            Everything below master runs one image. Publishing a build changes
            what the next node gets and nothing about the ones already running,
            so rolling is a decision rather than a side effect — one bad build
            should not reach the whole fleet before anybody notices.
          </p>
          <p className="text-muted-foreground">
            Current image{' '}
            <code className="font-mono text-xs">{short(current)}</code>
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={() => roll(false)}
              disabled={busy || behind.length === 0}
            >
              <RefreshCw className="size-4" />
              {busy ? 'Rolling…' : `Update ${behind.length || 'all'} node(s)`}
            </Button>
            <Button
              variant="outline"
              onClick={() => roll(true)}
              disabled={busy || nodes.length === 0}
            >
              Redeploy every node
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            One Worker upload per node, in sequence, so this takes a while.
            Safe to run again — a node already on the current build is skipped.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Nodes</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 text-sm">
          {nodes.map((node) => (
            <div
              key={node.id}
              className="border-border/70 flex flex-wrap items-center gap-3 rounded-lg border p-3"
            >
              <span className="min-w-0 flex-1 truncate font-medium">
                {node.slug}
              </span>
              <code className="text-muted-foreground font-mono text-xs">
                {short(node.version)}
              </code>
              {node.status !== 'active' ? (
                <Badge variant="secondary">{node.status}</Badge>
              ) : node.behind ? (
                <Badge variant="destructive">behind</Badge>
              ) : (
                <Badge variant="outline">current</Badge>
              )}
            </div>
          ))}
          {nodes.length === 0 ? (
            <p className="text-muted-foreground text-xs">No nodes yet.</p>
          ) : null}
        </CardContent>
      </Card>

      {orphans.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Scripts with no node behind them</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2 text-sm">
            <p className="text-muted-foreground">
              These are running in the dispatch namespace, and master has no
              record of them — so they are never rolled and never torn down.
              They keep answering on whatever build they were left on. Nothing
              here can update one: without a node row there is nothing to
              provision from, so the choices are to adopt it or remove it.
            </p>
            {orphans.map((name) => (
              <code key={name} className="font-mono text-xs">
                {name}
              </code>
            ))}
          </CardContent>
        </Card>
      ) : null}

      {rolled.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>What happened</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 font-mono text-xs">
            {rolled.map((one) => (
              <p key={one.slug}>
                {one.ok ? '✓' : '✗'} {one.slug} — {short(one.from)} →{' '}
                {short(one.to ?? null)}
                {one.detail ? ` (${one.detail})` : ''}
              </p>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  )
}
