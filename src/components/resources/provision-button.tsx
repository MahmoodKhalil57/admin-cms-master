import { useState } from 'react'
import { useNotify, useRecordContext, useRefresh } from 'ra-core'

import { Button } from '#/components/ui/button'

interface NodeRecord {
  slug: string
  status: string
}

interface ProvisionStep {
  name: string
  status: string
  detail?: string
}

/**
 * Runs provisioning for the current node.
 *
 * This blocks until every Cloudflare resource is created and the Worker is
 * uploaded, which takes tens of seconds — acceptable for an operator clicking
 * one node, and the point at which a queue is needed once nodes are created by
 * signup traffic.
 */
export const ProvisionButton = ({
  action = 'provision',
}: {
  action?: 'provision' | 'destroy'
}) => {
  const record = useRecordContext<NodeRecord>()
  const notify = useNotify()
  const refresh = useRefresh()
  const [busy, setBusy] = useState(false)
  const [steps, setSteps] = useState<Array<ProvisionStep>>([])

  if (!record) return null

  const destroy = action === 'destroy'

  const run = async () => {
    if (
      destroy &&
      !window.confirm(
        `Delete every Cloudflare resource for "${record.slug}"? Its database and uploads go with it.`,
      )
    ) {
      return
    }

    setBusy(true)
    setSteps([])

    try {
      const response = await fetch(`/api/provision/${record.slug}`, {
        method: destroy ? 'DELETE' : 'POST',
      })
      const body = (await response.json()) as {
        ok: boolean
        steps?: Array<ProvisionStep>
        error?: string
      }

      setSteps(body.steps ?? [])
      notify(
        body.ok
          ? destroy
            ? 'Node torn down.'
            : 'Node provisioned.'
          : (body.error ?? 'Provisioning failed.'),
        { type: body.ok ? 'success' : 'error' },
      )
      refresh()
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), {
        type: 'error',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant={destroy ? 'destructive' : 'default'}
        onClick={run}
        disabled={busy}
        className="w-fit"
      >
        {busy
          ? destroy
            ? 'Tearing down…'
            : 'Provisioning…'
          : destroy
            ? 'Tear down'
            : 'Provision'}
      </Button>

      {steps.length > 0 && (
        <ul className="text-muted-foreground font-mono text-xs">
          {steps.map((step) => (
            <li key={step.name}>
              {step.status === 'failed' ? '✗' : '✓'} {step.name} — {step.status}
              {step.detail ? ` (${step.detail})` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
