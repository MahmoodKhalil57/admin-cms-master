/**
 * What things cost, in credits.
 *
 * Code rather than data, and versioned, for the same reason the feature and
 * permission catalogs are: what a node *can* be charged for is a property of
 * what the platform can measure, which ships with a build. What anybody
 * actually owes is a property of one node, and lives in its rows.
 *
 * **Credits, never currency.** A credit spent last month was spent at last
 * month's rate, and the moment the ledger stores money instead, a repricing
 * quietly rewrites what everybody already owes. It also means the three
 * settlement models — published rate, cost-plus markup, profit share — are
 * strategies over one meter rather than three meters.
 *
 * Dependency-free: read by the node that counts, by master that bills, and by
 * the screens on both.
 */

export type MeterSource =
  /** derived from the node's own event log, so it can be counted after the fact */
  | 'events'
  /** sampled from the world, and therefore only true for the moment it was taken */
  | 'measured'

export interface MeterItem {
  key: string
  name: string
  description: string
  source: MeterSource
  /** the event that increments it, for counted items */
  eventName?: string
  /** what one of them costs */
  credits: number
  /** what one of them is, for a screen that has to say "40 per GB-month" */
  unit: string
  /**
   * Quantity is divided by this before pricing.
   *
   * Bytes are counted in bytes and priced in gigabytes; counting in gigabytes
   * would mean rounding every measurement to the nearest billion.
   */
  per?: number
  /** not yet actually measured, and the screens should say so rather than show zero */
  pending?: boolean
}

/**
 * Bumped whenever a price changes.
 *
 * Stamped onto every meter row, so a period always says what it was priced at.
 * Without it a repricing makes last month's bill unreproducible, and the first
 * time anybody notices is when a customer disputes one.
 */
export const PRICE_LIST_VERSION = 1

export const PRICE_LIST: Array<MeterItem> = [
  {
    key: 'signup',
    name: 'Sign-ups',
    description: 'An account created on this node.',
    source: 'events',
    eventName: 'user.signed_up',
    credits: 1,
    unit: 'each',
  },
  {
    key: 'submission',
    name: 'Form submissions',
    description: 'An enquiry sent in from a website.',
    source: 'events',
    eventName: 'submission.created',
    credits: 1,
    unit: 'each',
  },
  {
    key: 'order',
    name: 'Paid orders',
    description: 'An order the payment provider confirmed.',
    source: 'events',
    eventName: 'order.paid',
    credits: 5,
    unit: 'each',
  },
  {
    key: 'booking',
    name: 'Appointments',
    description: 'A slot that became a real appointment.',
    source: 'events',
    eventName: 'booking.confirmed',
    credits: 3,
    unit: 'each',
  },
  {
    key: 'email',
    name: 'Emails sent',
    description: 'A notification, receipt or download link that left the node.',
    source: 'events',
    eventName: 'notification.sent',
    credits: 1,
    unit: 'each',
  },
  {
    key: 'commit',
    name: 'Site changes',
    description: 'A change to the website, committed to its repository.',
    source: 'events',
    eventName: 'content.committed',
    credits: 1,
    unit: 'each',
  },
  {
    key: 'storage',
    name: 'Files held',
    description: 'What is sitting in this node’s own storage, measured now.',
    source: 'measured',
    credits: 40,
    unit: 'GB',
    per: 1_073_741_824,
  },
  {
    /*
      Declared and not yet measured, on purpose.

      Cloudflare bills egress per *account*, not per node — one number for the
      whole fleet — so attributing it means measuring it ourselves at the point
      of use. Until something does, this reads zero, and a zero that means "not
      counted" must not look like a zero that means "none used". Hence the flag,
      and hence the screens saying so.
    */
    key: 'egress',
    name: 'Bytes served',
    description: 'What this node has sent to the internet.',
    source: 'measured',
    credits: 10,
    unit: 'GB',
    per: 1_073_741_824,
    pending: true,
  },
  {
    key: 'requests',
    name: 'Requests answered',
    description: 'How many times this node was asked for something.',
    source: 'measured',
    credits: 1,
    unit: '10k',
    per: 10_000,
    pending: true,
  },
]

export function meterItem(key: string): MeterItem | undefined {
  return PRICE_LIST.find((item) => item.key === key)
}

/**
 * What a quantity costs.
 *
 * Rounded up, and this one deliberately goes the platform's way: a fraction of
 * a credit is not a thing that can be owed, and rounding down would make every
 * partial gigabyte free. A whole credit is small enough that erring upward on
 * one is not a meaningful overcharge, which is exactly why it is the safe
 * direction here and the wrong one for a marketplace commission.
 */
export function creditsFor(item: MeterItem, quantity: number): number {
  const units = quantity / (item.per ?? 1)
  return Math.ceil(units * item.credits)
}

/** `YYYY-MM` in UTC — the period everything is bucketed into. */
export function periodOf(at: Date = new Date()): string {
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}`
}
