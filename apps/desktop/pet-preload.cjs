// Desktop pet preload — the ONLY bridge into the pet page. Runs in the
// sandboxed, isolated pet renderer (separate from the WebUI preload, which
// stays empty). All data flows main → page via ipcRenderer; the pet page never
// touches /api. CJS is required for sandboxed preloads.
'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('pet', {
  // Subscribe to status updates. Returns an unsubscribe function.
  onState(callback) {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('pet:state', listener)
    return () => ipcRenderer.removeListener('pet:state', listener)
  },
  // Surface the main window.
  openMain() {
    ipcRenderer.send('pet:open-main')
  },
  // Surface the main window where the approval panel lives.
  handleApproval() {
    ipcRenderer.send('pet:handle-approval')
  },
  // Pointer-drag: the renderer only signals press/release. The main process
  // polls the OS cursor itself, so no screen coordinates cross the bridge.
  dragStart() {
    ipcRenderer.send('pet:drag-start')
  },
  dragEnd() {
    ipcRenderer.send('pet:drag-end')
  },
  // Pop the pet's context menu (right-click on the pet body).
  contextMenu() {
    ipcRenderer.send('pet:context-menu')
  },
})
