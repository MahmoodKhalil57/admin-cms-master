import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  like,
} from 'drizzle-orm'
import type { SQL } from 'drizzle-orm'

import type { MasterDb } from '#/db'
import { nodes } from '#/db/schema'

/**
 * A generic REST layer speaking ra-data-simple-rest's dialect, so the admin's
 * dataProvider stays configuration rather than bespoke code.
 *
 * Only the tables listed here are reachable. Anything else is a 404 — the route
 * takes a resource name straight from the URL, so this map is the boundary that
 * stops it addressing an arbitrary table.
 */
const RESOURCES = {
  nodes,
}

// Drizzle's table types are heavily generic; the generic handlers below work
// over any of them, so the shared shape is deliberately loose.
type AnyTable = (typeof RESOURCES)[keyof typeof RESOURCES]
/* eslint-disable @typescript-eslint/no-explicit-any */
type LooseTable = any

function resolveResource(resource: string): AnyTable | null {
  return Object.prototype.hasOwnProperty.call(RESOURCES, resource)
    ? RESOURCES[resource as keyof typeof RESOURCES]
    : null
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function notFound(resource: string) {
  return Response.json({ error: `Unknown resource "${resource}"` }, { status: 404 })
}

/**
 * Translates react-admin's `filter` object into SQL. Arrays become `IN` (which
 * is how getMany and getManyReference arrive), strings on text columns become
 * partial matches so the filter inputs behave like search, and everything else
 * is exact equality. Unknown keys are ignored rather than erroring, because
 * react-admin sends its own bookkeeping fields through the same object.
 */
function buildWhere(
  table: LooseTable,
  filter: Record<string, unknown>,
): SQL | undefined {
  const columns = getTableColumns(table)
  const conditions: Array<SQL> = []

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined || value === null || value === '') continue
    const column = columns[key]
    if (!column) continue

    if (Array.isArray(value)) {
      if (value.length === 0) continue
      conditions.push(inArray(column, value))
    } else if (typeof value === 'string' && column.dataType === 'string') {
      conditions.push(like(column, `%${value}%`))
    } else {
      conditions.push(eq(column, value))
    }
  }

  return conditions.length > 0 ? and(...conditions) : undefined
}

export async function listResource(db: MasterDb, resource: string, url: URL) {
  const table = resolveResource(resource)
  if (!table) return notFound(resource)

  const columns = getTableColumns(table as LooseTable)
  const filter = parseJson<Record<string, unknown>>(
    url.searchParams.get('filter'),
    {},
  )
  const [sortField, sortOrder] = parseJson<[string, string]>(
    url.searchParams.get('sort'),
    ['id', 'ASC'],
  )
  const [start, end] = parseJson<[number, number]>(
    url.searchParams.get('range'),
    [0, 24],
  )

  const where = buildWhere(table, filter)
  const sortColumn = columns[sortField] ?? columns.id
  const direction = String(sortOrder).toUpperCase() === 'DESC' ? desc : asc

  const rows = await db
    .select()
    .from(table as LooseTable)
    .where(where)
    .orderBy(direction(sortColumn))
    .limit(Math.max(1, end - start + 1))
    .offset(Math.max(0, start))

  const [totals] = await db
    .select({ total: count() })
    .from(table as LooseTable)
    .where(where)
  const total = totals?.total ?? 0

  // react-admin reads the total from Content-Range; without exposing the header
  // it is invisible to the browser whenever the API is not same-origin.
  return Response.json(rows, {
    headers: {
      'Content-Range': `${resource} ${start}-${start + Math.max(0, rows.length - 1)}/${total}`,
      'Access-Control-Expose-Headers': 'Content-Range',
    },
  })
}

export async function getResource(db: MasterDb, resource: string, id: string) {
  const table = resolveResource(resource)
  if (!table) return notFound(resource)

  const columns = getTableColumns(table as LooseTable)
  const [row] = await db
    .select()
    .from(table as LooseTable)
    .where(eq(columns.id, Number(id)))
    .limit(1)

  if (!row) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json(row)
}

export async function createResource(
  db: MasterDb,
  resource: string,
  request: Request,
) {
  const table = resolveResource(resource)
  if (!table) return notFound(resource)

  const body = (await request.json()) as Record<string, unknown>
  const rows = (await db
    .insert(table as LooseTable)
    .values(stripReadOnly(table, body))
    .returning()) as Array<Record<string, unknown>>

  return Response.json(rows[0], { status: 201 })
}

export async function updateResource(
  db: MasterDb,
  resource: string,
  id: string,
  request: Request,
) {
  const table = resolveResource(resource)
  if (!table) return notFound(resource)

  const columns = getTableColumns(table as LooseTable)
  const body = (await request.json()) as Record<string, unknown>
  const rows = (await db
    .update(table as LooseTable)
    .set(stripReadOnly(table, body))
    .where(eq(columns.id, Number(id)))
    .returning()) as Array<Record<string, unknown>>

  if (!rows[0]) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json(rows[0])
}

export async function deleteResource(db: MasterDb, resource: string, id: string) {
  const table = resolveResource(resource)
  if (!table) return notFound(resource)

  const columns = getTableColumns(table as LooseTable)
  const rows = (await db
    .delete(table as LooseTable)
    .where(eq(columns.id, Number(id)))
    .returning()) as Array<Record<string, unknown>>

  if (!rows[0]) return Response.json({ error: 'Not found' }, { status: 404 })
  return Response.json(rows[0])
}

/**
 * Drops keys that are not real columns, plus the primary key and any
 * server-owned timestamp. react-admin round-trips the whole record on update,
 * so without this an edit would try to write `id` and `created_at` back.
 */
function stripReadOnly(table: LooseTable, body: Record<string, unknown>) {
  const columns = getTableColumns(table)
  const values: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(body)) {
    if (key === 'id' || key === 'createdAt') continue
    if (!columns[key]) continue
    values[key] = value
  }

  return values
}
