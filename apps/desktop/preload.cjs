// DeepSeek Harness desktop shell preload — bridges the frameless window
// controls (minimize / maximize / close) from the injected title bar into the
// main process. The Web UI itself still talks to dsh over same-origin HTTP.
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('desktop', {
  minimize() {
    ipcRenderer.send('window:minimize')
  },
  toggleMaximize() {
    ipcRenderer.send('window:toggle-maximize')
  },
  close() {
    ipcRenderer.send('window:close')
  },
  isMaximized() {
    return ipcRenderer.invoke('window:is-maximized')
  },
  onMaximizeChange(callback) {
    const listener = (_event, maximized) => callback(maximized)
    ipcRenderer.on('window:maximized-changed', listener)
    return () => ipcRenderer.removeListener('window:maximized-changed', listener)
  },
  togglePet() {
    ipcRenderer.send('window:toggle-pet')
  },
  isPetEnabled() {
    return ipcRenderer.invoke('window:pet-enabled')
  },
  onPetEnabledChange(callback) {
    const listener = (_event, enabled) => callback(enabled)
    ipcRenderer.on('window:pet-enabled-changed', listener)
    return () => ipcRenderer.removeListener('window:pet-enabled-changed', listener)
  },
  getPetStyle() {
    return ipcRenderer.invoke('window:pet-style')
  },
  onPetStyleChange(callback) {
    const listener = (_event, style) => callback(style)
    ipcRenderer.on('window:pet-style-changed', listener)
    return () => ipcRenderer.removeListener('window:pet-style-changed', listener)
  },
})
