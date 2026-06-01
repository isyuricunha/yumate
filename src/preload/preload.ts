import { contextBridge, ipcRenderer } from "electron";
import {
  type AppSnapshot,
  type BehaviorState,
  type ImportPetResult,
  type RendererEventMap,
  type SaveSettingsPayload,
  type SendMessageResult,
} from "../shared/types";

const api = {
  getSnapshot: () => ipcRenderer.invoke("app:getSnapshot") as Promise<AppSnapshot>,
  saveSettings: (payload: SaveSettingsPayload) => ipcRenderer.invoke("settings:save", payload) as Promise<AppSnapshot>,
  sendMessage: (content: string) => ipcRenderer.invoke("chat:send", content) as Promise<SendMessageResult>,
  cancelChat: () => ipcRenderer.invoke("chat:cancel") as Promise<void>,
  clearHistory: () => ipcRenderer.invoke("history:clear") as Promise<AppSnapshot>,
  importPet: () => ipcRenderer.invoke("pet:import") as Promise<ImportPetResult>,
  selectPet: (petPackId: string) => ipcRenderer.invoke("pet:select", petPackId) as Promise<AppSnapshot>,
  setPetState: (state: BehaviorState) => ipcRenderer.invoke("pet:setState", state) as Promise<void>,
  setClickThrough: (ignore: boolean) => ipcRenderer.invoke("window:setClickThrough", ignore) as Promise<void>,
  moveWindowBy: (delta: { x: number; y: number }) => ipcRenderer.invoke("window:moveBy", delta) as Promise<void>,
  saveWindowPosition: () => ipcRenderer.invoke("window:savePosition") as Promise<void>,
  toggleVisibility: () => ipcRenderer.invoke("window:toggleVisibility") as Promise<void>,
  stopTts: () => ipcRenderer.invoke("tts:stop") as Promise<void>,
  notifyTtsEnded: () => ipcRenderer.invoke("tts:ended") as Promise<void>,
  on<T extends keyof RendererEventMap>(channel: T, callback: (payload: RendererEventMap[T]) => void) {
    const listener = (_event: Electron.IpcRendererEvent, payload: RendererEventMap[T]) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
};

contextBridge.exposeInMainWorld("yumate", api);
