import {
  type AppSnapshot,
  type ChatMessage,
  type RendererEventMap,
} from "../shared/types";
import { type YumateApi } from "../preload/global";

export function installDevMock(): void {
  if (!import.meta.env.DEV || window.yumate) {
    return;
  }

  const listeners = new Map<keyof RendererEventMap, Set<(payload: never) => void>>();
  let snapshot = createSnapshot();

  const emit = <T extends keyof RendererEventMap>(channel: T, payload: RendererEventMap[T]) => {
    listeners.get(channel)?.forEach((callback) => callback(payload as never));
  };

  const api: YumateApi = {
    async getSnapshot() {
      return snapshot;
    },
    async saveSettings(payload) {
      snapshot = {
        ...snapshot,
        settings: payload.global,
        providers: [payload.provider],
        tts: payload.tts,
        activeInstance: {
          ...snapshot.activeInstance,
          ...payload.instance,
        },
      };
      emit("snapshot:changed", snapshot);
      return snapshot;
    },
    async sendMessage(content) {
      const userMessage = createMessage("user", content);
      const assistantMessage = createMessage("assistant", "Resposta local de desenvolvimento para validar o painel.");
      snapshot = {
        ...snapshot,
        messages: [...snapshot.messages, userMessage, assistantMessage],
      };
      emit("state:changed", { instanceId: snapshot.activeInstance.id, state: "thinking", bubble: "Pensando..." });
      window.setTimeout(() => emit("state:changed", { instanceId: snapshot.activeInstance.id, state: "speaking" }), 500);
      window.setTimeout(() => emit("state:changed", { instanceId: snapshot.activeInstance.id, state: "idle" }), 1800);
      emit("snapshot:changed", snapshot);
      emit("bubble:show", { text: assistantMessage.content, tone: "neutral", timeoutMs: 8000 });
      return { ok: true, assistantMessage };
    },
    async cancelChat() {
      emit("state:changed", { instanceId: snapshot.activeInstance.id, state: "idle" });
    },
    async clearHistory() {
      snapshot = { ...snapshot, messages: [] };
      emit("snapshot:changed", snapshot);
      return snapshot;
    },
    async importPet() {
      return { ok: false, error: "Import is available in Electron." };
    },
    async selectPet() {
      return snapshot;
    },
    async setPetState(state) {
      snapshot = {
        ...snapshot,
        activeInstance: { ...snapshot.activeInstance, currentState: state },
      };
      emit("state:changed", { instanceId: snapshot.activeInstance.id, state });
    },
    async setClickThrough() {},
    async moveWindowBy() {},
    async saveWindowPosition() {},
    async toggleVisibility() {},
    async stopTts() {
      emit("tts:stop", {});
    },
    async notifyTtsEnded() {
      emit("state:changed", { instanceId: snapshot.activeInstance.id, state: "idle" });
    },
    on(channel, callback) {
      const set = listeners.get(channel) ?? new Set();
      set.add(callback as (payload: never) => void);
      listeners.set(channel, set);
      return () => set.delete(callback as (payload: never) => void);
    },
  };

  window.yumate = api;
}

function createSnapshot(): AppSnapshot {
  const now = new Date().toISOString();
  return {
    settings: {
      theme: "system",
      startWithWindows: false,
      defaultProviderId: "default-openai-compatible",
      defaultModel: "gpt-4o-mini",
      defaultEffort: "medium",
      petsFolderPath: "dev",
      clickThroughEnabled: false,
      trayBehavior: "minimize-to-tray",
      windowsContextEnabled: false,
      activeWindowTitleEnabled: false,
      chatHistoryEnabled: true,
      automaticAiCallsEnabled: false,
    },
    providers: [
      {
        id: "default-openai-compatible",
        name: "OpenAI Compatible",
        baseUrl: "https://api.openai.com/v1",
        apiKey: "",
        model: "gpt-4o-mini",
        supportsReasoning: false,
        supportsEffort: false,
        defaultEffort: "medium",
        temperature: 0.7,
        streamEnabled: false,
        updatedAt: now,
      },
    ],
    tts: {
      id: "global",
      voice: "pt-BR-FranciscaNeural",
      rate: "medium",
      pitch: "default",
      volume: 0.9,
      muted: false,
      updatedAt: now,
    },
    petPacks: [devPack(now)],
    activeInstance: {
      id: "dev-instance",
      petPackId: "ainz",
      name: "Yumate",
      x: 120,
      y: 160,
      monitorId: null,
      scale: 1,
      visible: true,
      persona: "Companheiro visual em portugues brasileiro.",
      systemPrompt: "Responda em portugues brasileiro. Seja casual, conciso e util.",
      voice: null,
      model: null,
      providerId: "default-openai-compatible",
      effort: "medium",
      ttsEnabled: true,
      movementEnabled: false,
      currentState: "idle",
      createdAt: now,
      updatedAt: now,
    },
    activePetPack: devPack(now),
    conversation: {
      id: "dev-conversation",
      petInstanceId: "dev-instance",
      title: "Chat",
      createdAt: now,
      updatedAt: now,
    },
    messages: [],
  };
}

function devPack(now: string): AppSnapshot["activePetPack"] {
  return {
    id: "ainz",
    displayName: "Ainz",
    description: "Development pet pack.",
    directoryPath: "dev",
    petJsonPath: "/default-pets/ainz/pet.json",
    spritesheetPath: "/default-pets/ainz/spritesheet.webp",
    metadata: {
      schemaVersion: 1,
      frameWidth: 192,
      frameHeight: 208,
      columns: 8,
      rows: 9,
      animations: {
        idle: { row: 0, frames: 6, fps: 6, loop: true },
        "running-right": { row: 1, frames: 8, fps: 10, loop: true },
        "running-left": { row: 2, frames: 8, fps: 10, loop: true },
        waving: { row: 3, frames: 4, fps: 7, loop: true },
        jumping: { row: 4, frames: 5, fps: 9, loop: false, returnState: "idle" },
        failed: { row: 5, frames: 8, fps: 8, loop: true },
        waiting: { row: 6, frames: 6, fps: 5, loop: true },
        running: { row: 7, frames: 6, fps: 9, loop: true },
        review: { row: 8, frames: 6, fps: 6, loop: true },
      },
      stateMap: {
        idle: "idle",
        "walking-right": "running-right",
        "walking-left": "running-left",
        thinking: "waiting",
        processing: "running",
        reviewing: "review",
        speaking: "waving",
        clicked: "jumping",
        error: "failed",
      },
    },
    valid: true,
    validation: { valid: true, issues: [], warnings: [] },
    installedAt: now,
    updatedAt: now,
  };
}

function createMessage(role: "user" | "assistant", content: string): ChatMessage {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    conversationId: "dev-conversation",
    role,
    content,
    createdAt: now,
    model: "gpt-4o-mini",
    providerId: "default-openai-compatible",
    status: "sent",
    error: null,
    spoken: false,
    metadata: {},
  };
}
