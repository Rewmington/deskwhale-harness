/**
 * Embedded dsh web host for the desktop shell.
 *
 * Boots the `web` profile in-process through `@deepseek-ai/dsh/api`'s
 * `runProfile`, then exposes the listening port. Teardown goes straight to
 * `ctx.fiber.dispose()` — the ProcessShutdown returned by runProfile would
 * eventually call `process.exit`, which in an Electron main process must never
 * run.
 */

import type { Context } from '@deepseek-ai/cordis'
import { loadLayeredEnv } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/api'

/** A live, embedded dsh web server. */
export interface DshHost {
  /** The actual listening port (OS-assigned; requested via `--port 0`). */
  port: number
  /**
   * The root Cordis context of the embedded tree. The shell lives in the same
   * process as the host, so it can subscribe to framework events directly
   * (`agent/status`, `session/event`, …) without a network hop.
   */
  ctx: Context
  /** Dispose the whole dsh tree. Idempotent and resolves at quiescence. */
  dispose(): Promise<void>
}

/**
 * Start the web profile on an OS-assigned loopback port and wait for the
 * server to be listening. Rejects (after disposing the partial tree) if the
 * webServer service never became available.
 */
export async function startDshWeb(): Promise<DshHost> {
  const { ctx } = await runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'web',
    patchFiles: [],
    args: ['--port', '0'],
    // Electron has no Node internals: the HMR service cannot start, and a
    // desktop app does not hot-edit its cordis config anyway.
    disableHmrWatch: true,
  })
  const webServer = ctx.get('webServer') as { port?: number } | undefined
  if (webServer?.port === undefined) {
    await ctx.fiber.dispose()
    throw new Error('dsh web: webServer 服务启动后未就绪')
  }
  return {
    port: webServer.port,
    ctx,
    dispose() {
      return ctx.fiber.dispose()
    },
  }
}
