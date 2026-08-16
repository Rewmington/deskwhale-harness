/**
 * DeepSeek Harness desktop shell — Electron main process.
 *
 * Boots the dsh `web` profile in-process (see host.ts), opens a BrowserWindow
 * on the server's loopback URL, and provides the standard Windows desktop
 * experience: single-instance lock, tray with "close to tray", system
 * notifications, and external-link delegation to the system browser.
 *
 * The Web UI talks to dsh over the same-origin HTTP at http://127.0.0.1:<port>
 * — the /api trust fence accepts loopback Host headers, so no custom protocol
 * or file:// loading is involved.
 */

import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDshWeb, type DshHost } from './host.js'
import { createPetWindow, isPetEnabled, setPetEnabled, type PetHandle } from './pet.js'
import { createTray, type TrayHandle } from './tray.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let logFile = ''

/** Initialize the crash/diagnostic log under the userData logs directory. */
function initLog(): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    logFile = join(dir, 'desktop.log')
  } catch {
    // Logging is best-effort; a failure must not block startup.
  }
}

/** Write one line to stderr and the log file. */
function log(...parts: unknown[]): void {
  const line = `[${new Date().toISOString()}] ${parts.join(' ')}`
  console.error(line)
  if (logFile !== '') {
    try {
      appendFileSync(logFile, line + '\n')
    } catch {
      // Ignore log-write failures.
    }
  }
}

let mainWindow: BrowserWindow | null = null
let host: DshHost | null = null
let tray: TrayHandle | null = null
let pet: PetHandle | null = null
/** A real quit is in flight: the window may close for good, no more hide-to-tray. */
let isQuitting = false
/** The dsh tree has already been disposed (before-quit re-entry guard). */
let hostDisposed = false

/** Height of the injected desktop title bar; must match the body top padding. */
const TITLEBAR_HEIGHT = 40

/** Pet model thumbnail, inlined so the title bar button works from the HTTP UI. */
const PET_THUMBNAIL_DATA_URL = ((): string => {
  try {
    const bytes = readFileSync(join(__dirname, '../assets/pet/idle.png'))
    return `data:image/png;base64,${bytes.toString('base64')}`
  } catch {
    // Missing pet art must never block the shell; the button falls back to empty.
    return ''
  }
})()

const TITLEBAR_CSS = `
  html, body { background: transparent !important; }
  body {
    box-sizing: border-box !important;
    padding-top: ${TITLEBAR_HEIGHT}px !important;
    --dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-00) 84%, transparent);
    --dsw-specific-sidebar-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-50) 88%, transparent);
  }
  body[data-ds-dark-theme] {
    --dsw-alias-bg-base: color-mix(in srgb, var(--dsw-static-neutral-bluish-950) 84%, transparent);
    --dsw-specific-sidebar-fill: color-mix(in srgb, var(--dsw-static-neutral-bluish-900) 88%, transparent);
  }
  .dsh-desktop-titlebar {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    height: ${TITLEBAR_HEIGHT}px;
    z-index: 2147483000;
    display: flex;
    align-items: center;
    justify-content: space-between;
    box-sizing: border-box;
    padding-left: 16px;
    background: var(--dsw-alias-bg-base);
    border-bottom: 1px solid var(--dsw-alias-border-l2);
    -webkit-app-region: drag;
    user-select: none;
  }
  .dsh-titlebar-label {
    font-family: var(--dsw-font-family, "Segoe UI", "Microsoft YaHei", system-ui, sans-serif);
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0.4px;
    color: var(--dsw-alias-label-tertiary, rgba(66, 72, 86, 0.78));
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .dsh-titlebar-controls {
    display: flex;
    align-items: stretch;
    height: 100%;
    -webkit-app-region: no-drag;
  }
  .dsh-titlebar-control {
    width: 46px;
    height: 100%;
    padding: 0;
    border: none;
    background: transparent;
    color: var(--dsw-alias-label-secondary, rgba(45, 50, 62, 0.82));
    display: grid;
    place-items: center;
    cursor: pointer;
  }
  .dsh-titlebar-control:hover { background: rgba(0, 0, 0, 0.07); }
  .dsh-titlebar-control.close:hover { background: #e81123; color: #fff; }
  .dsh-titlebar-control svg { width: 16px; height: 16px; display: block; }
  .dsh-titlebar-pet-icon { width: 24px; height: 26px; object-fit: contain; -webkit-user-drag: none; }
  .dsh-titlebar-control.pet-off .dsh-titlebar-pet-icon { opacity: 0.4; filter: grayscale(1); }
  .dsh-titlebar-control.pet-on .dsh-titlebar-pet-icon { opacity: 1; }
  .dsh-titlebar-maximize-icon { display: grid; }
  .dsh-titlebar-restore-icon { display: none; }
  .dsh-desktop-titlebar[data-maximized='true'] .dsh-titlebar-maximize-icon { display: none; }
  .dsh-desktop-titlebar[data-maximized='true'] .dsh-titlebar-restore-icon { display: grid; }
`

const TITLEBAR_SCRIPT = `
(() => {
  if (document.getElementById('dsh-desktop-titlebar') !== null) return
  const desktop = window.desktop
  if (desktop === undefined) return
  const svg = {
    min: '<svg viewBox="0 0 16 16"><path d="M2 7.5h12" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
    max: '<svg viewBox="0 0 16 16"><rect x="2.5" y="2.5" width="11" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    restore: '<svg viewBox="0 0 16 16"><rect x="2.5" y="4.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M5.5 4.5v-1a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>',
    close: '<svg viewBox="0 0 16 16"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>',
  }
  const bar = document.createElement('div')
  bar.id = 'dsh-desktop-titlebar'
  bar.className = 'dsh-desktop-titlebar'
  bar.innerHTML =
    '<span class="dsh-titlebar-label">DeepSeek Harness</span>' +
    '<div class="dsh-titlebar-controls">' +
      '<button class="dsh-titlebar-control pet-off" id="dsh-titlebar-pet" title="显示桌宠" aria-label="显示桌宠" aria-pressed="false">' +
        '<img class="dsh-titlebar-pet-icon" src="${PET_THUMBNAIL_DATA_URL}" alt="" draggable="false">' +
      '</button>' +
      '<button class="dsh-titlebar-control" id="dsh-titlebar-min" title="最小化" aria-label="最小化">' + svg.min + '</button>' +
      '<button class="dsh-titlebar-control" id="dsh-titlebar-max" title="最大化" aria-label="最大化">' +
        '<span class="dsh-titlebar-maximize-icon">' + svg.max + '</span>' +
        '<span class="dsh-titlebar-restore-icon">' + svg.restore + '</span>' +
      '</button>' +
      '<button class="dsh-titlebar-control close" id="dsh-titlebar-close" title="关闭" aria-label="关闭">' + svg.close + '</button>' +
    '</div>'
  document.body.appendChild(bar)
  const petButton = document.getElementById('dsh-titlebar-pet')
  const setPetState = (enabled) => {
    petButton.classList.toggle('pet-on', enabled)
    petButton.classList.toggle('pet-off', !enabled)
    petButton.title = enabled ? '隐藏桌宠' : '显示桌宠'
    petButton.setAttribute('aria-label', enabled ? '隐藏桌宠' : '显示桌宠')
    petButton.setAttribute('aria-pressed', enabled ? 'true' : 'false')
  }
  petButton.addEventListener('click', () => desktop.togglePet())
  if (typeof desktop.isPetEnabled === 'function') desktop.isPetEnabled().then(setPetState)
  if (typeof desktop.onPetEnabledChange === 'function') desktop.onPetEnabledChange(setPetState)
  document.getElementById('dsh-titlebar-min').addEventListener('click', () => desktop.minimize())
  document.getElementById('dsh-titlebar-max').addEventListener('click', () => desktop.toggleMaximize())
  document.getElementById('dsh-titlebar-close').addEventListener('click', () => desktop.close())
  const maxButton = document.getElementById('dsh-titlebar-max')
  const setMaximized = (maximized) => {
    bar.dataset.maximized = maximized ? 'true' : 'false'
    maxButton.title = maximized ? '还原' : '最大化'
    maxButton.setAttribute('aria-label', maximized ? '还原' : '最大化')
  }
  if (typeof desktop.isMaximized === 'function') desktop.isMaximized().then(setMaximized)
  if (typeof desktop.onMaximizeChange === 'function') desktop.onMaximizeChange(setMaximized)
})()
`

/** Inject the frosted desktop chrome into the Web UI after it mounts. */
function installDesktopChrome(win: BrowserWindow): void {
  win.webContents.on('dom-ready', () => {
    void win.webContents.insertCSS(TITLEBAR_CSS)
    void win.webContents.executeJavaScript(TITLEBAR_SCRIPT)
  })
}

/** Show a blocking error box, log it, and exit the shell without the quit path. */
function fatal(message: string, detail = ''): void {
  log('fatal:', message, detail === '' ? '' : `\n${detail}`)
  dialog.showErrorBox(
    'DeepSeek Harness 启动失败',
    detail === '' ? message : `${message}\n\n${detail}`,
  )
  app.exit(1)
}

/** The dsh engines require `^22.19.0 || >=24.0.0`; the Electron main runs on its bundled Node. */
function nodeVersionSupported(): boolean {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  return major >= 24 || major > 22 || (major === 22 && minor >= 19)
}

/** Lightweight frameless splash shown while the dsh web profile boots. */
function createSplashWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    height: 210,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.center()
  void win.loadFile(join(__dirname, '../assets/splash.html'))
  win.once('ready-to-show', () => win.show())
  return win
}

function createMainWindow(port: number): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    show: false,
    frame: false,
    thickFrame: false,
    transparent: true,
    backgroundColor: '#00000000',
    backgroundMaterial: 'acrylic',
    roundedCorners: true,
    autoHideMenuBar: true,
    icon: join(__dirname, '../assets/icon.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '../preload.cjs'),
    },
  })

  // Frameless window controls, wired from the injected title bar.
  ipcMain.on('window:minimize', () => win.minimize())
  ipcMain.on('window:toggle-maximize', () => {
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', () => win.close())
  ipcMain.handle('window:is-maximized', () => win.isMaximized())
  const sendMaximized = (): void => {
    if (!win.isDestroyed()) win.webContents.send('window:maximized-changed', win.isMaximized())
  }
  win.on('maximize', sendMaximized)
  win.on('unmaximize', sendMaximized)
  ipcMain.on('window:toggle-pet', () => togglePet(!isPetEnabled()))
  ipcMain.handle('window:pet-enabled', () => isPetEnabled())

  // The trust fence rejects any origin that is not loopback-same-origin, so
  // everything must stay on http://127.0.0.1:<port>. Open anything else in the
  // system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${port}`)) {
      event.preventDefault()
      if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    }
  })

  win.once('ready-to-show', () => {
    win.show()
  })
  win.on('close', (event) => {
    if (!isQuitting) {
      // Close to tray.
      event.preventDefault()
      win.hide()
    }
  })
  win.on('closed', () => {
    ipcMain.removeAllListeners('window:minimize')
    ipcMain.removeAllListeners('window:toggle-maximize')
    ipcMain.removeAllListeners('window:close')
    ipcMain.removeAllListeners('window:toggle-pet')
    ipcMain.removeHandler('window:is-maximized')
    ipcMain.removeHandler('window:pet-enabled')
    if (mainWindow === win) mainWindow = null
  })

  installDesktopChrome(win)
  void win.loadURL(`http://127.0.0.1:${port}`)
  return win
}

/** Create the pet window wired to the shell's quit/toggle paths. `host` must be live. */
function createPet(host: DshHost): void {
  pet = createPetWindow(host, {
    getMainWindow: () => mainWindow,
    onQuit: () => {
      isQuitting = true
      app.quit()
    },
    togglePet,
  })
}

/** Turn the desktop pet on/off: persist the choice and show/hide the window.
 * Disabling only hides it — recreating a transparent window is the fragile path
 * that made toggling back on fail. The hidden window keeps its subscriptions. */
function togglePet(enabled: boolean): void {
  setPetEnabled(enabled)
  mainWindow?.webContents.send('window:pet-enabled-changed', enabled)
  if (enabled) {
    if (pet === null && host !== null) createPet(host)
    else pet?.show()
  } else {
    pet?.hide()
  }
}

async function bootstrap(): Promise<void> {
  initLog()
  log('boot: node', process.versions.node, '| electron', process.versions.electron)
  if (!nodeVersionSupported()) {
    fatal(
      `当前运行环境的 Node 版本过低（v${process.versions.node}），需要 >= 22.19 或 >= 24。`,
    )
    return
  }

  const splash = createSplashWindow()
  try {
    host = await startDshWeb()
    log('boot: dsh web listening on port', host.port)
  } catch (err) {
    log('boot: startDshWeb failed', err instanceof Error ? err.stack ?? err.message : String(err))
    if (!splash.isDestroyed()) splash.destroy()
    fatal('无法启动内置服务', err instanceof Error ? err.message : String(err))
    return
  }

  mainWindow = createMainWindow(host.port)
  mainWindow.once('ready-to-show', () => {
    if (!splash.isDestroyed()) splash.destroy()
  })
  tray = createTray(() => mainWindow, () => {
    isQuitting = true
    app.quit()
  }, togglePet, isPetEnabled)
  if (isPetEnabled()) createPet(host)

  // Let the SPA show system notification banners; deny everything else.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'notifications')
  })
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow === null) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  // dsh's fail-loud installers can exit(1); surface a box first so the user
  // sees why the shell died. showErrorBox is synchronous, so it renders before
  // any exit path.
  process.on('uncaughtException', (err) => {
    fatal('发生未处理的错误', err instanceof Error ? err.stack ?? err.message : String(err))
  })
  process.on('unhandledRejection', (reason) => {
    fatal('发生未处理的 Promise 拒绝', reason instanceof Error ? reason.stack ?? reason.message : String(reason))
  })

  void app.whenReady().then(bootstrap)

  app.on('before-quit', (event) => {
    // Tear down the pet window and its IPC handlers first.
    pet?.destroy()
    pet = null
    // On the first real quit, dispose the embedded dsh tree, then re-enter
    // quit with hostDisposed set so the loop falls through.
    if (host === null || hostDisposed) return
    event.preventDefault()
    isQuitting = true
    hostDisposed = true
    void host.dispose().catch(() => {}).finally(() => {
      tray?.destroy()
      tray = null
      app.quit()
    })
  })
}
