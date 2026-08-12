/**
 * Typed wrapper for TanStack Start server-route handlers.
 *
 * `createFileRoute(...)({ server: { handlers } })` is supported at runtime —
 * `@tanstack/start-server-core`'s `createStartHandler` reads
 * `route.options.server.handlers` directly — but the published route-options
 * type does not include `server`, because `@tanstack/react-start` (1.168, the
 * latest release) has not caught up to `@tanstack/react-router` (1.170). The
 * scaffold's own `src/routes/mcp.ts` hits the same error.
 *
 * Keeping the cast here means the handlers stay fully typed at every call site,
 * and there is exactly one line to delete once the versions realign.
 */

export interface ServerHandlerCtx {
  request: Request
  params: Record<string, string>
}

export type ServerHandler = (
  ctx: ServerHandlerCtx,
) => Response | Promise<Response>

export type ServerHandlers = Partial<
  Record<'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', ServerHandler>
>

export function serverRoute(handlers: ServerHandlers) {
  // `never` is assignable to the route-options parameter, which is what lets
  // this pass while the upstream type is missing `server`.
  return { server: { handlers } } as never
}
