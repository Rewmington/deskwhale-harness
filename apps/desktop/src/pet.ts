/**
 * Desktop pet — a small, always-on-top transparent window that floats on the
 * desktop and mirrors what the embedded dsh tree is doing right now.
 *
 * The shell and the dsh host share one process, so this module subscribes to
 * framework events directly on `host.ctx` and pushes a derived one-line status
 * to the pet page over IPC. The pet page never touches /api: it is a pure
 * renderer fed by the main process.
 *
 * Status derivation (most-specific wins):
 * - any pending `approval/asked` not yet closed → `approval` (show tool + reason)
 * - any pending `ask_user_question` tool call → `approval` as a question
 * - a running agent executing a tool → `tool` (show tool name)
 * - any running agent → `running` (with count)
 * - otherwise → `idle`
 *
 * The pet only *notifies* about approvals; the actual decision stays with the
 * WebUI's answerer (apiproxy). It never listens on the `approval/request`
 * waterfall, so it cannot stall or short-circuit the approval chain.
 */

import { app, BrowserWindow, ipcMain, Menu, screen } from 'electron'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Side-effect type import: pulls the `approval/asked|decided` SessionEventMap
// augmentation into the compilation so the switch below stays typed.
import type {} from '@deepseek-ai/dsh-user-approval'
import type { DshHost } from './host.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Pet window content size — must match the layout in pet.html. */
const WIDTH = 220
const HEIGHT = 400
/** Margin from the work-area corner for the default position. */
const EDGE_MARGIN = 20

/** What the pet tells its page right now. */
export type PetState =
  | { status: 'idle' }
  | { status: 'running'; runningCount: number }
  | { status: 'tool'; toolName: string; runningCount: number }
  | {
    status: 'approval'
    kind?: 'approval' | 'question' | undefined
    toolName?: string | undefined
    reason?: string | undefined
    runningCount: number
  }

export interface PetHandle {
  /** Show the pet window (without stealing focus). */
  show(): void
  /** Hide the pet window; subscriptions stay alive so show() is instant. */
  hide(): void
  /** Destroy the window, its IPC handlers and its event subscriptions. */
  destroy(): void
}

interface PetWindowOptions {
  getMainWindow: () => BrowserWindow | null
  /** Request a real quit (used by the pet's context menu). */
  onQuit: () => void
  /** Enable/disable the pet (used by the pet's context menu). */
  togglePet: (enabled: boolean) => void
}

interface PendingApproval {
  toolName?: string
  reason?: string
}

let petWindow: BrowserWindow | null = null
/** Drag state: cursor-to-window offset while a drag is active (null otherwise). */
let dragOffset: { x: number; y: number } | null = null
/** Poll timer that follows the OS cursor during an active drag. */
let dragTimer: ReturnType<typeof setInterval> | null = null
/** Last wall-clock time a drag position was persisted (debounced). */
let lastDragSave = 0

function stopDragPolling(): void {
  if (dragTimer !== null) {
    clearInterval(dragTimer)
    dragTimer = null
  }
}

/** Per-agent bookkeeping: status flip + the last tool it started. */
const agents = new Map<string, { running: boolean; lastTool?: string | undefined }>()
/** Pending approvals keyed by the `approval/asked` event id, in ask order. */
const pending = new Map<string, PendingApproval>()
/** Pending `ask_user_question` tool calls keyed by call id, in ask order. */
const pendingQuestions = new Set<string>()

function positionFile(): string {
  return join(app.getPath('userData'), 'pet-position.json')
}

function settingsFile(): string {
  return join(app.getPath('userData'), 'pet-settings.json')
}

/** Whether the pet is enabled, persisted across runs. Defaults to on. */
export function isPetEnabled(): boolean {
  try {
    const parsed = JSON.parse(readFileSync(settingsFile(), 'utf8')) as { enabled?: boolean }
    return parsed.enabled !== false
  } catch {
    // Missing or corrupt settings file: default to enabled.
    return true
  }
}

/** Persist the pet's enabled state. */
export function setPetEnabled(enabled: boolean): void {
  try {
    writeFileSync(settingsFile(), JSON.stringify({ enabled }))
  } catch {
    // Best-effort; a failure must not affect the app.
  }
}

function loadPosition(): { x: number; y: number } | null {
  try {
    const parsed = JSON.parse(readFileSync(positionFile(), 'utf8')) as { x?: number; y?: number }
    if (typeof parsed.x === 'number' && typeof parsed.y === 'number') return { x: parsed.x, y: parsed.y }
  } catch {
    // Missing or corrupt position file: fall back to the default corner.
  }
  return null
}

function savePosition(x: number, y: number): void {
  try {
    writeFileSync(positionFile(), JSON.stringify({ x, y }))
  } catch {
    // Position persistence is best-effort; a failure must not affect the app.
  }
}

function defaultPosition(): { x: number; y: number } {
  const workArea = screen.getPrimaryDisplay().workArea
  return {
    x: workArea.x + workArea.width - WIDTH - EDGE_MARGIN,
    y: workArea.y + workArea.height - HEIGHT - EDGE_MARGIN,
  }
}

/**
 * Clamp the window top-left within the display that owns `anchor` (the cursor),
 * so at least a strip stays visible. The display is chosen by the cursor rather
 * than by the target rectangle: when the target straddles two monitors,
 * rectangle-based matching snapped the pet down to the other display. Returns
 * integers — Windows setPosition rejects fractional pixels.
 */
function clampToVisible(target: { x: number; y: number }, anchor: { x: number; y: number }): { x: number; y: number } {
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return defaultPosition()
  const area = screen.getDisplayNearestPoint(anchor).workArea
  return {
    x: Math.round(Math.min(Math.max(target.x, area.x - WIDTH + 80), area.x + area.width - 80)),
    y: Math.round(Math.min(Math.max(target.y, area.y), area.y + area.height - 80)),
  }
}

function runningCount(): number {
  let count = 0
  for (const entry of agents.values()) if (entry.running) count += 1
  return count
}

function recompute(): void {
  if (petWindow === null || petWindow.isDestroyed()) return
  const count = runningCount()

  const firstPending = pending.values().next().value as PendingApproval | undefined
  if (firstPending !== undefined) {
    petWindow.webContents.send('pet:state', {
      status: 'approval',
      kind: 'approval',
      toolName: firstPending.toolName,
      reason: firstPending.reason,
      runningCount: count,
    } satisfies PetState)
    return
  }
  if (pendingQuestions.size > 0) {
    petWindow.webContents.send('pet:state', {
      status: 'approval',
      kind: 'question',
      toolName: 'ask_user_question',
      runningCount: count,
    } satisfies PetState)
    return
  }

  // Among running agents, prefer the one that last started a tool.
  let runningAgent: { lastTool?: string | undefined } | undefined
  for (const entry of agents.values()) {
    if (entry.running) runningAgent = entry
  }
  if (runningAgent === undefined) {
    petWindow.webContents.send('pet:state', { status: 'idle' } satisfies PetState)
    return
  }
  if (runningAgent.lastTool !== undefined) {
    petWindow.webContents.send('pet:state', {
      status: 'tool',
      toolName: runningAgent.lastTool,
      runningCount: count,
    } satisfies PetState)
    return
  }
  petWindow.webContents.send('pet:state', {
    status: 'running',
    runningCount: count,
  } satisfies PetState)
}

function registerIpc(options: PetWindowOptions): void {
  const showMain = (): void => {
    const win = options.getMainWindow()
    if (win === null) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  ipcMain.on('pet:open-main', showMain)
  // v1: "去处理" just surfaces the main window, where the approval panel lives.
  ipcMain.on('pet:handle-approval', showMain)
  // Pointer-drag, driven by the OS cursor so the window can never feed its own
  // position back into the loop (that caused self-drift). The pet page only
  // signals press/release; movement follows screen.getCursorScreenPoint().
  ipcMain.on('pet:drag-start', () => {
    if (petWindow === null || petWindow.isDestroyed()) return
    const cursor = screen.getCursorScreenPoint()
    const winPos = petWindow.getPosition()
    const wx = winPos[0]
    const wy = winPos[1]
    if (typeof wx !== 'number' || typeof wy !== 'number') return
    dragOffset = { x: cursor.x - wx, y: cursor.y - wy }
    stopDragPolling()
    lastDragSave = 0
    let lastX = wx
    let lastY = wy
    dragTimer = setInterval(() => {
      if (dragOffset === null) return
      if (petWindow === null || petWindow.isDestroyed()) {
        stopDragPolling()
        return
      }
      const point = screen.getCursorScreenPoint()
      const target = clampToVisible({ x: point.x - dragOffset.x, y: point.y - dragOffset.y }, point)
      // Compare against the position we last APPLIED, not getPosition() — that
      // removes one tick of perceived lag during a fast drag.
      if (target.x !== lastX || target.y !== lastY) {
        lastX = target.x
        lastY = target.y
        petWindow.setPosition(target.x, target.y)
      }
      // Debounced save so a missed drag-end (cursor released outside the window)
      // never loses more than half a second of travel.
      const now = Date.now()
      if (now - lastDragSave > 500) {
        lastDragSave = now
        savePosition(target.x, target.y)
      }
    }, 8)
  })
  ipcMain.on('pet:drag-end', () => {
    stopDragPolling()
    if (petWindow === null || petWindow.isDestroyed() || dragOffset === null) {
      dragOffset = null
      return
    }
    const point = screen.getCursorScreenPoint()
    const target = clampToVisible({ x: point.x - dragOffset.x, y: point.y - dragOffset.y }, point)
    petWindow.setPosition(target.x, target.y)
    savePosition(target.x, target.y)
    dragOffset = null
  })
  // Right-click anywhere on the pet body pops this menu.
  ipcMain.on('pet:context-menu', () => {
    if (petWindow === null || petWindow.isDestroyed()) return
    const menu = Menu.buildFromTemplate([
      { label: '显示主窗口', click: showMain },
      { type: 'separator' },
      {
        type: 'checkbox',
        label: '桌宠',
        checked: isPetEnabled(),
        click: () => options.togglePet(!isPetEnabled()),
      },
      { type: 'separator' },
      { label: '退出', click: options.onQuit },
    ])
    menu.popup({ window: petWindow })
  })
  ipcMain.on('pet:set-interactive', (_event, interactive: boolean) => {
    if (petWindow === null || petWindow.isDestroyed()) return
    petWindow.setIgnoreMouseEvents(!interactive, { forward: true })
  })
}

function unregisterIpc(): void {
  ipcMain.removeAllListeners('pet:open-main')
  ipcMain.removeAllListeners('pet:handle-approval')
  ipcMain.removeAllListeners('pet:drag-start')
  ipcMain.removeAllListeners('pet:drag-end')
  ipcMain.removeAllListeners('pet:context-menu')
  ipcMain.removeAllListeners('pet:set-interactive')
}

/**
 * Create the pet window and start mirroring dsh activity into it.
 * Subscriptions are registered on the host fiber, so `host.dispose()` cleans
 * them up; only the window and IPC handlers are owned here.
 */
export function createPetWindow(host: DshHost, options: PetWindowOptions): PetHandle {
  registerIpc(options)

  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    frame: false,
    // Windows can still draw a thin edge on frameless windows; strip it so the
    // pet silhouette is the only visible boundary.
    thickFrame: false,
    transparent: true,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../pet-preload.cjs'),
    },
  })
  petWindow = win
  // Explicitly enforce top-most once the window exists. On Windows the
  // `alwaysOnTop` constructor option is not guaranteed to set WS_EX_TOPMOST by
  // itself; without this the pet silently renders behind the main window.
  win.setAlwaysOnTop(true, 'screen-saver')

  const loaded = loadPosition() ?? defaultPosition()
  const pos = clampToVisible(loaded, loaded)
  win.setPosition(pos.x, pos.y)
  win.setIgnoreMouseEvents(true, { forward: true })
  void win.loadFile(join(__dirname, '../assets/pet/pet.html'))
  win.once('ready-to-show', () => {
    win.showInactive()
    recompute()
  })
  win.on('closed', () => {
    if (petWindow === win) petWindow = null
  })

  const ctx: Context = host.ctx
  // Disposers are collected so destroy() can unsubscribe — the pet may be torn
  // down and recreated at runtime via the enabled switch, and the host fiber
  // would otherwise never release these listeners.
  const disposers: Array<() => void> = []
  disposers.push(ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: AgentStatus }) => {
    const entry = agents.get(agent.id) ?? { running: false }
    entry.running = status === 'running'
    if (!entry.running) entry.lastTool = undefined
    agents.set(agent.id, entry)
    recompute()
  }))
  disposers.push(ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    agents.delete(agent.id)
    recompute()
  }))
  disposers.push(ctx.on('session/event', (session, event: SessionEvent) => {
    switch (event.type) {
      case 'tool/call': {
        if (event.data.name === 'ask_user_question') {
          pendingQuestions.add(String(event.data.callId))
        }
        const entry = agents.get(session.id) ?? { running: false }
        entry.lastTool = event.data.name
        agents.set(session.id, entry)
        recompute()
        break
      }
      case 'tool/result': {
        const callId = event.data.message.content[0]?.toolCallId
        if (callId !== undefined) pendingQuestions.delete(String(callId))
        const entry = agents.get(session.id)
        if (entry !== undefined) {
          entry.lastTool = undefined
          recompute()
        }
        break
      }
      case 'approval/asked':
        pending.set(event.data.id, {
          toolName: event.data.toolName,
          ...event.data.reason !== undefined ? { reason: event.data.reason } : {},
        })
        recompute()
        break
      case 'approval/decided':
        pending.delete(event.data.id)
        recompute()
        break
      default:
        break
    }
  }))

  return {
    show() {
      if (petWindow !== null && !petWindow.isDestroyed()) petWindow.showInactive()
    },
    hide() {
      if (petWindow !== null && !petWindow.isDestroyed()) petWindow.hide()
    },
    destroy() {
      stopDragPolling()
      unregisterIpc()
      for (const off of disposers) off()
      agents.clear()
      pending.clear()
      pendingQuestions.clear()
      if (petWindow !== null && !petWindow.isDestroyed()) petWindow.destroy()
      petWindow = null
    },
  }
}
