import { useEffect, useState } from 'react'
import { useNotify } from 'ra-core'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'

/**
 * What the fleet has used, and what it has paid for.
 *
 * The screen the meter exists for. Balances are arithmetic over two tables —
 * credits put in, minus what the meter says came out — so nothing here is a
 * stored number that could have drifted.
 *
 * A balance below zero is shown as a balance below zero rather than as an
 * alarm. Metering must not be the thing that breaks somebody's shop, so going
 * under is allowed and what happens at the floor is a product decision nobody
 * has made yet.
 */

interface Balance {
  nodeId: number
  slug: string
  purchased: number
  used: number
  balance: number
}

interface Period {
  period: string
  credits: number
  lines: Array<{
    item: string
    name: string
    unit: string
    quantity: number
    credits: number
    pending: boolean
  }>
}

interface Usage {
  priceListVersion: number
  priceList: Array<{ key: string; name: string; credits: number; unit: string; pending?: boolean }>
  balances: Array<Balance>
  periods: Array<Period>
}

/** Bytes read as bytes are unreadable; everything else is already a count. */
function quantity(item: string, value: number): string {
  if (item === 'storage' || item === 'egress') {
    const gb = value / 1_073_741_824
    return gb >= 0.01 ? `${gb.toFixed(2)} GB` : `${(value / 1_048_576).toFixed(1)} MB`
  }
  return String(value)
}

export const UsagePage = () => {
  const notify = useNotify()
  const [data, setData] = useState<Usage | null>(null)
  const [chosen, setChosen] = useState<number | null>(null)
  const [amount, setAmount] = useState('')

  const load = (node?: number | null) => {
    const query = node ? `?node=${node}` : ''
    void fetch(`/api/usage${query}`)
      .then((response) => (response.ok ? response.json() : null))
      .then(setData)
      .catch(() => setData(null))
  }

  useEffect(() => {
    load(chosen)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosen])

  if (!data) {
    return <div className="text-muted-foreground p-6 text-sm">Reading the meter…</div>
  }

  const grant = async () => {
    const credits = Number(amount)
    if (!chosen || !Number.isFinite(credits) || credits === 0) return
    const response = await fetch('/api/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: chosen, credits }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      notify(body.error ?? 'Could not add them.', { type: 'error' })
      return
    }
    setAmount('')
    notify(`${credits} credits added.`, { type: 'info' })
    load(chosen)
  }

  return (
    <div className="flex w-full min-w-0 flex-col gap-5 p-6">
      <div>
        <h1 className="text-xl font-semibold">Usage and credits</h1>
        <p className="text-muted-foreground max-w-prose text-sm">
          What each node has used, priced at price list v{data.priceListVersion}.
          Balances can go below zero — the meter never stops a node working, and
          what happens at the floor is still an open decision.
        </p>
      </div>

      <div className="border-border/70 bg-card overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="text-muted-foreground border-border/70 border-b text-left text-xs">
            <tr>
              <th className="px-4 py-2 font-medium">Node</th>
              <th className="px-4 py-2 text-right font-medium">Credits in</th>
              <th className="px-4 py-2 text-right font-medium">Used</th>
              <th className="px-4 py-2 text-right font-medium">Balance</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {data.balances.map((row) => (
              <tr key={row.nodeId} className="border-border/40 border-b last:border-0">
                <td className="px-4 py-2 font-mono text-xs">{row.slug}</td>
                <td className="px-4 py-2 text-right tabular-nums">{row.purchased}</td>
                <td className="px-4 py-2 text-right tabular-nums">{row.used}</td>
                <td
                  className={`px-4 py-2 text-right tabular-nums ${
                    row.balance < 0 ? 'text-destructive font-medium' : ''
                  }`}
                >
                  {row.balance}
                </td>
                <td className="px-4 py-2 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setChosen(chosen === row.nodeId ? null : row.nodeId)}
                  >
                    {chosen === row.nodeId ? 'Hide' : 'Break down'}
                  </Button>
                </td>
              </tr>
            ))}
            {data.balances.length === 0 ? (
              <tr>
                <td className="text-muted-foreground px-4 py-4" colSpan={5}>
                  No nodes yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {chosen ? (
        <div className="flex flex-col gap-4">
          <div className="border-border/70 bg-muted/30 flex flex-wrap items-center gap-2 rounded-lg border p-4">
            <p className="text-sm font-medium">Add credits</p>
            <Input
              className="h-8 max-w-[10rem]"
              placeholder="1000"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
            />
            <Button size="sm" onClick={grant} disabled={!amount}>
              Add
            </Button>
            <p className="text-muted-foreground w-full text-xs">
              By hand for now. When a card pays for these, the same ledger takes
              the line with the payment's id as its key, so a webhook delivered
              twice cannot add them twice.
            </p>
          </div>

          {data.periods.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              This node has not reported anything yet. It reports when somebody
              opens its dashboard, at most once an hour.
            </p>
          ) : (
            data.periods.map((period) => (
              <div
                key={period.period}
                className="border-border/70 bg-card flex flex-col gap-2 rounded-lg border p-4"
              >
                <div className="flex items-baseline justify-between">
                  <p className="font-medium">{period.period}</p>
                  <p className="tabular-nums">{period.credits} credits</p>
                </div>
                {period.lines.map((line) => (
                  <div
                    key={line.item}
                    className="text-muted-foreground flex items-baseline gap-3 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {line.name}
                      {/* A zero that means "nobody counted this" must not read
                          as a zero that means "none was used". */}
                      {line.pending ? (
                        <span className="ml-2 text-xs italic">not measured yet</span>
                      ) : null}
                    </span>
                    <span className="tabular-nums">
                      {quantity(line.item, line.quantity)}
                    </span>
                    <span className="text-foreground w-16 text-right tabular-nums">
                      {line.credits}
                    </span>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      ) : null}

      <div className="border-border/70 bg-card flex flex-col gap-2 rounded-lg border p-4">
        <p className="text-muted-foreground text-xs">
          The price list — v{data.priceListVersion}, stamped on every row so a
          repricing cannot rewrite what anybody already owes
        </p>
        {data.priceList.map((item) => (
          <div key={item.key} className="flex items-baseline gap-3 text-sm">
            <span className="min-w-0 flex-1 truncate">
              {item.name}
              {item.pending ? (
                <span className="text-muted-foreground ml-2 text-xs italic">
                  declared, not yet measured
                </span>
              ) : null}
            </span>
            <span className="tabular-nums">
              {item.credits} / {item.unit}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
