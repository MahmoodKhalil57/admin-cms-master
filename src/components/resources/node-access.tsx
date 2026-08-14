import { useState } from 'react'
import { useNotify, useRecordContext } from 'ra-core'
import { Copy, KeyRound } from 'lucide-react'

import { Button } from '#/components/ui/button'

interface NodeRecord {
  slug: string
  status: string
}

interface Granted {
  email: string
  password: string
}

/**
 * The way into a node.
 *
 * A node's root admin is the guaranteed way in — the account provisioning
 * seeds, holding everything, outside the node's own permission system so it
 * cannot be locked out. Its password is shown once, when the node is built, and
 * until now that was the only time anybody saw it. Missing that moment meant
 * rebuilding the node, which is a poor answer to the most ordinary mistake
 * there is.
 *
 * Shown here rather than stored anywhere. Master could keep it and save
 * everybody the trouble; it would also mean master holds a working credential
 * for every node it has ever created, which is a much worse thing to have than
 * an occasional reset is an inconvenience.
 */
export const NodeAccess = () => {
  const record = useRecordContext<NodeRecord>()
  const notify = useNotify()
  const [busy, setBusy] = useState(false)
  const [granted, setGranted] = useState<Granted | null>(null)

  if (!record) return null

  const reset = async () => {
    if (
      !window.confirm(
        `Give "${record.slug}" a new root admin password? Whoever is signed in as that account will be signed out.`,
      )
    ) {
      return
    }

    setBusy(true)
    try {
      const response = await fetch(`/api/nodes/${record.slug}/owner`, {
        method: 'POST',
      })
      const body = (await response.json()) as {
        ok?: boolean
        email?: string
        password?: string
        error?: string
      }

      if (!response.ok || !body.password) {
        notify(body.error ?? 'Could not reset that.', { type: 'error' })
        return
      }
      setGranted({ email: body.email!, password: body.password })
    } finally {
      setBusy(false)
    }
  }

  const copy = (value: string) => {
    void navigator.clipboard.writeText(value)
    notify('Copied.', { type: 'info' })
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-3">
      <Button
        variant="outline"
        size="sm"
        onClick={reset}
        disabled={busy || record.status !== 'active'}
      >
        <KeyRound className="size-4" />
        {busy ? 'Resetting…' : 'Reset root admin password'}
      </Button>

      {granted ? (
        <div className="border-primary/40 bg-primary/5 flex flex-col gap-2 rounded-lg border p-3">
          <p className="text-sm font-medium">Copy these now</p>
          {(
            [
              ['Email', granted.email],
              ['Password', granted.password],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="flex items-center gap-2">
              <span className="text-muted-foreground w-20 text-xs">{label}</span>
              <code className="bg-background min-w-0 flex-1 truncate rounded border px-2 py-1 font-mono text-xs">
                {value}
              </code>
              <Button variant="outline" size="sm" onClick={() => copy(value)}>
                <Copy className="size-4" />
              </Button>
            </div>
          ))}
          <p className="text-muted-foreground text-xs">
            This is the only time it is shown. Nothing here keeps a copy — the
            next one is another reset.
          </p>
        </div>
      ) : null}
    </div>
  )
}
