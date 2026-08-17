/**
 * System tray for the desktop shell: show/focus the main window, and the only
 * explicit "退出" path (which quits rather than hiding to tray).
 */

import { Tray, Menu, nativeImage, type BrowserWindow } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PET_STYLE_OPTIONS, type PetStyle } from './pet.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** Handle owning the tray instance so the caller can destroy it on quit. */
export interface TrayHandle {
  destroy(): void
}

/**
 * Create the tray. Clicking the icon shows the window; the context menu has
 * "显示主窗口", a "桌宠" enable/disable switch, a pet-style selector, and "退出".
 * `onQuit` must request a real quit (not hide). The pet switch calls
 * `togglePet` with the target state and keeps its checkbox in sync with
 * `getPetEnabled`.
 */
export function createTray(
  getWindow: () => BrowserWindow | null,
  onQuit: () => void,
  togglePet: (enabled: boolean) => void,
  getPetEnabled: () => boolean,
  getPetStyle: () => PetStyle,
  selectPetStyle: (style: PetStyle) => void,
): TrayHandle {
  const icon = nativeImage.createFromPath(join(__dirname, '../assets/icon.png'))
  const tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('DeepSeek Harness')
  const show = (): void => {
    const win = getWindow()
    if (win === null) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
  const refreshMenu = (): void => {
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: show },
      {
        type: 'checkbox',
        label: '桌宠',
        checked: getPetEnabled(),
        click: () => {
          togglePet(!getPetEnabled())
          refreshMenu()
        },
      },
      {
        label: '宠物风格',
        submenu: PET_STYLE_OPTIONS.map(({ id, label }) => ({
          type: 'radio' as const,
          label,
          checked: getPetStyle() === id,
          click: () => {
            selectPetStyle(id)
            refreshMenu()
          },
        })),
      },
      { type: 'separator' },
      { label: '退出', click: onQuit },
    ]))
  }
  refreshMenu()
  tray.on('click', show)
  return {
    destroy() {
      tray.destroy()
    },
  }
}
