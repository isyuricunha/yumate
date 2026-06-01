import {
  type AppSnapshot,
  type BehaviorState,
  type ImportPetResult,
  type RendererEventMap,
  type SaveSettingsPayload,
  type SendMessageResult,
  type WindowsContext,
} from "../shared/types";

export interface YumateApi {
  getSnapshot(): Promise<AppSnapshot>;
  getWindowsContext(): Promise<WindowsContext>;
  saveSettings(payload: SaveSettingsPayload): Promise<AppSnapshot>;
  sendMessage(content: string): Promise<SendMessageResult>;
  cancelChat(): Promise<void>;
  clearHistory(): Promise<AppSnapshot>;
  importPet(): Promise<ImportPetResult>;
  selectPet(petPackId: string): Promise<AppSnapshot>;
  createInstance(petPackId?: string): Promise<AppSnapshot>;
  selectInstance(instanceId: string): Promise<AppSnapshot>;
  setPetState(state: BehaviorState): Promise<void>;
  setPanelState(state: { chatOpen: boolean; settingsOpen: boolean }): Promise<void>;
  setClickThrough(ignore: boolean): Promise<void>;
  moveWindowBy(delta: { x: number; y: number }): Promise<void>;
  saveWindowPosition(): Promise<void>;
  toggleVisibility(): Promise<void>;
  stopTts(): Promise<void>;
  notifyTtsEnded(): Promise<void>;
  on<T extends keyof RendererEventMap>(
    channel: T,
    callback: (payload: RendererEventMap[T]) => void,
  ): () => void;
}

declare global {
  interface Window {
    yumate: YumateApi;
  }
}
