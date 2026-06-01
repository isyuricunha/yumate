import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  Tray,
} from "electron";
import { AppDatabase } from "./database";
import { PetPackService } from "./petPackService";
import { AiService } from "./aiService";
import { TtsCanceledError, TtsService } from "./ttsService";
import { emptyWindowsContext, WindowsContextService } from "./windowsContextService";
import {
  type AppSnapshot,
  type BehaviorState,
  type HotkeyAction,
  type HotkeySetting,
  type ImportPetResult,
  type SaveSettingsPayload,
  type WindowsContext,
} from "../shared/types";
import { translate, type TranslationKey } from "../shared/i18n";

let petWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let database: AppDatabase;
let petPackService: PetPackService;
let aiService: AiService;
let ttsService: TtsService;
let windowsContextService: WindowsContextService;
let currentWindowsContext: WindowsContext = emptyWindowsContext();
let isQuitting = false;
let contextTimer: NodeJS.Timeout | null = null;
let movementTimer: NodeJS.Timeout | null = null;
let movementDirection: -1 | 1 = 1;
let panelsOpen = false;
let lastAutomaticContextKey: string | null = null;
let lastAutomaticCallAt = 0;
let automaticCallInFlight = false;
let automaticAiPrimed = false;
let pendingAutomaticContext: WindowsContext | null = null;
let pendingAutomaticContextKey: string | null = null;
let pendingAutomaticContextSince = 0;
let lastAutomaticDisabledLogAt = 0;

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const automaticAiCooldownMs = 45_000;
const automaticAiStableContextMs = 8_000;
const contextPollIntervalMs = 5_000;

app.setName("Yumate");

app.whenReady().then(async () => {
  const paths = getRuntimePaths();
  database = new AppDatabase(paths.dbPath, paths.sqlWasmPath, paths.petsDirectory);
  await database.initialize();

  petPackService = new PetPackService(database, paths.petsDirectory, paths.defaultPetsDirectory);
  const packs = await petPackService.initialize();
  const firstValidPack = packs.find((pack) => pack.valid) ?? packs[0];
  if (!firstValidPack) {
    throw new Error("No pet packs are installed.");
  }

  database.ensureDefaultInstance(firstValidPack.id);
  database.resetTransientRuntimeStates();
  applyStartupSetting(database.getGlobalSettings());
  windowsContextService = new WindowsContextService();
  aiService = new AiService(database, windowsContextService);
  ttsService = new TtsService(paths.userData);

  registerIpc();
  createPetWindow();
  createTray();
  registerHotkeys();
  startContextPolling();
  startMovementLoop();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
  if (contextTimer) {
    clearInterval(contextTimer);
  }
  if (movementTimer) {
    clearInterval(movementTimer);
  }
});

app.on("activate", () => {
  if (!petWindow) {
    createPetWindow();
  }
});

function getRuntimePaths() {
  const userData = app.getPath("userData");
  const appPath = app.getAppPath();
  const resourcesPath = process.resourcesPath;
  const petsDirectory = path.join(userData, "pets");

  return {
    userData,
    petsDirectory,
    dbPath: path.join(userData, "yumate.sqlite"),
    sqlWasmPath: app.isPackaged
      ? path.join(resourcesPath, "sql-wasm.wasm")
      : path.join(appPath, "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    defaultPetsDirectory: app.isPackaged
      ? path.join(resourcesPath, "default-pets")
      : path.join(appPath, "resources", "default-pets"),
    iconPath: app.isPackaged
      ? path.join(resourcesPath, "icons", "yumate.png")
      : path.join(appPath, "resources", "icons", "yumate.png"),
  };
}

function createPetWindow(): void {
  const snapshot = database.getSnapshot();
  const instance = snapshot.activeInstance;
  const preload = path.join(__dirname, "..", "preload", "preload.js");
  const windowSize = { width: 560, height: 640 };
  const initialPosition = clampWindowPosition(
    Math.round(instance.x),
    Math.round(instance.y),
    windowSize.width,
    windowSize.height,
  );

  petWindow = new BrowserWindow({
    width: windowSize.width,
    height: windowSize.height,
    x: initialPosition.x,
    y: initialPosition.y,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: false,
    hasShadow: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  petWindow.setAlwaysOnTop(true, "screen-saver");

  if (isDev && process.env.VITE_DEV_SERVER_URL) {
    petWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    petWindow.webContents.openDevTools({ mode: "detach" });
  } else {
    petWindow.loadURL(pathToFileURL(path.join(__dirname, "..", "..", "renderer", "index.html")).toString());
  }

  petWindow.once("ready-to-show", () => {
    ensurePetWindowVisible();
    petWindow?.show();
    emitSnapshot();
  });

  petWindow.on("moved", () => persistWindowPosition());
  petWindow.on("closed", () => {
    petWindow = null;
  });

  petWindow.on("close", (event) => {
    if (!isQuitting && database.getGlobalSettings().trayBehavior === "minimize-to-tray") {
      event.preventDefault();
      petWindow?.hide();
    }
  });
}

function registerIpc(): void {
  ipcMain.handle("app:getSnapshot", () => database.getSnapshot(currentWindowsContext));
  ipcMain.handle("app:getWindowsContext", async () => {
    currentWindowsContext = await windowsContextService.capture(database.getGlobalSettings());
    emitSnapshot();
    return currentWindowsContext;
  });

  ipcMain.handle("settings:save", (_event, payload: SaveSettingsPayload) => {
    database.updateSettings(payload);
    applyStartupSetting(payload.global);
    refreshWindowsContext();
    registerHotkeys();
    const snapshot = database.getSnapshot(currentWindowsContext);
    emitSnapshot(snapshot);
    rebuildTray();
    return snapshot;
  });

  ipcMain.handle("chat:send", async (_event, content: string) => {
    const instance = database.getActiveInstance();
    setPetState("thinking", t("bubble.thinking"));
    setPetState("processing");
    const result = await aiService.sendMessage(instance, content);

    if (!result.ok || !result.assistantMessage) {
      if (isInterrupted(result.error)) {
        setPetState("idle");
      } else {
        setRecoverableErrorState(result.error ?? t("bubble.aiFailure"));
      }
      emitSnapshot();
      return result;
    }

    emitSnapshot();
    await presentAssistantMessage(result.assistantMessage, "chat");
    emitSnapshot();
    return result;
  });

  ipcMain.handle("chat:cancel", () => {
    aiService.cancel();
    setPetState("idle");
  });

  ipcMain.handle("history:clear", () => {
    const snapshot = database.clearHistory(database.getActiveInstance().id);
    emitSnapshot(snapshot);
    return snapshot;
  });

  ipcMain.handle("pet:import", async (): Promise<ImportPetResult> => {
    if (!petWindow) {
      return { ok: false, error: "Pet window is not available." };
    }
    const result = await petPackService.importWithDialog(petWindow);
    if (result.ok) {
      emitSnapshot();
      rebuildTray();
    }
    return result;
  });

  ipcMain.handle("pet:select", (_event, petPackId: string) => {
    const snapshot = database.updateActivePetPack(database.getActiveInstance().id, petPackId);
    emitSnapshot(snapshot);
    rebuildTray();
    return snapshot;
  });

  ipcMain.handle("instance:create", (_event, petPackId?: string) => {
    const snapshot = database.createInstance(petPackId ?? database.getActiveInstance().petPackId);
    moveWindowToActiveInstance();
    emitSnapshot(snapshot);
    rebuildTray();
    return snapshot;
  });

  ipcMain.handle("instance:select", (_event, instanceId: string) => {
    const snapshot = database.selectInstance(instanceId);
    moveWindowToActiveInstance();
    emitSnapshot(snapshot);
    rebuildTray();
    return snapshot;
  });

  ipcMain.handle("pet:setState", (_event, state: BehaviorState) => {
    setPetState(state);
  });

  ipcMain.handle("ui:setPanelState", (_event, state: { chatOpen: boolean; settingsOpen: boolean }) => {
    panelsOpen = state.chatOpen || state.settingsOpen;
    if (panelsOpen) {
      petWindow?.setIgnoreMouseEvents(false);
      ensurePetWindowVisible();
    }
  });

  ipcMain.handle("window:setClickThrough", (_event, ignore: boolean) => {
    petWindow?.setIgnoreMouseEvents(ignore, { forward: true });
  });

  ipcMain.handle("window:moveBy", (_event, delta: { x: number; y: number }) => {
    if (!petWindow) {
      return;
    }
    const [x, y] = petWindow.getPosition();
    const [width, height] = petWindow.getSize();
    const next = clampWindowPosition(Math.round(x + delta.x), Math.round(y + delta.y), width, height);
    petWindow.setPosition(next.x, next.y, false);
  });

  ipcMain.handle("window:savePosition", () => {
    persistWindowPosition();
  });

  ipcMain.handle("window:toggleVisibility", () => {
    if (!petWindow) {
      return;
    }
    if (petWindow.isVisible()) {
      petWindow.hide();
    } else {
      petWindow.show();
    }
  });

  ipcMain.handle("tts:stop", () => {
    ttsService.stop();
    sendToRenderer("tts:stop", {});
    setPetState("idle");
  });

  ipcMain.handle("tts:ended", () => {
    setPetState("idle");
  });
}

function createTray(): void {
  const iconPath = getRuntimePaths().iconPath;
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Yumate");
  rebuildTray();
}

function rebuildTray(): void {
  if (!tray) {
    return;
  }

  const snapshot = database.getSnapshot();
  const tts = snapshot.tts;
  const petItems = snapshot.petPacks.map((pack) => ({
    label: pack.displayName,
    type: "radio" as const,
    checked: pack.id === snapshot.activeInstance.petPackId,
    enabled: pack.valid,
    click: () => {
      database.updateActivePetPack(snapshot.activeInstance.id, pack.id);
      emitSnapshot();
      rebuildTray();
    },
  }));
  const instanceItems = snapshot.instances.map((instance) => ({
    label: instance.name,
    type: "radio" as const,
    checked: instance.id === snapshot.activeInstance.id,
    click: () => {
      database.selectInstance(instance.id);
      moveWindowToActiveInstance();
      emitSnapshot();
      rebuildTray();
    },
  }));

  const menu = Menu.buildFromTemplate([
    {
      label: t("tray.openChat"),
      click: () => {
        petWindow?.show();
        sendToRenderer("ui:toggle-chat", { open: true });
      },
    },
    {
      label: tts.muted ? t("app.unmute") : t("app.mute"),
      click: () => {
        database.updateTtsSettings({ ...tts, muted: !tts.muted });
        emitSnapshot();
        rebuildTray();
      },
    },
    {
      label: t("tray.stopSpeech"),
      click: () => {
        ttsService.stop();
        sendToRenderer("tts:stop", {});
        setPetState("idle");
      },
    },
    {
      label: snapshot.activeInstance.movementEnabled ? t("tray.pausePet") : t("tray.resumePet"),
      click: () => {
        setActiveInstanceMovementEnabled(!snapshot.activeInstance.movementEnabled);
      },
    },
    {
      label: petWindow?.isVisible() ? t("tray.hidePet") : t("tray.showPet"),
      click: () => {
        if (petWindow?.isVisible()) {
          petWindow.hide();
        } else {
          petWindow?.show();
        }
        rebuildTray();
      },
    },
    { type: "separator" },
    {
      label: t("tray.selectActivePet"),
      submenu: petItems.length > 0 ? petItems : [{ label: t("tray.noPets"), enabled: false }],
    },
    {
      label: t("tray.selectInstance"),
      submenu: instanceItems.length > 0 ? instanceItems : [{ label: t("tray.noInstances"), enabled: false }],
    },
    {
      label: t("tray.createInstance"),
      click: () => {
        database.createInstance(snapshot.activeInstance.petPackId);
        moveWindowToActiveInstance();
        emitSnapshot();
        rebuildTray();
      },
    },
    {
      label: t("tray.importPet"),
      click: async () => {
        if (petWindow) {
          await petPackService.importWithDialog(petWindow);
          emitSnapshot();
          rebuildTray();
        }
      },
    },
    {
      label: t("app.settings"),
      click: () => {
        petWindow?.show();
        sendToRenderer("ui:open-settings", {});
      },
    },
    { type: "separator" },
    {
      label: t("tray.quit"),
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
}

function applyStartupSetting(settings: ReturnType<AppDatabase["getGlobalSettings"]>): void {
  if (isDev || process.platform !== "win32") {
    return;
  }

  app.setLoginItemSettings({
    openAtLogin: settings.startWithWindows,
    path: process.execPath,
  });
}

function registerHotkeys(): void {
  globalShortcut.unregisterAll();

  const handlers: Record<HotkeyAction, () => void> = {
    "open-chat": () => {
      petWindow?.show();
      sendToRenderer("ui:toggle-chat", { open: true });
    },
    "toggle-pet": () => {
      if (petWindow?.isVisible()) {
        petWindow.hide();
      } else {
        petWindow?.show();
      }
    },
    mute: () => {
      const tts = database.getTtsSettings();
      database.updateTtsSettings({ ...tts, muted: !tts.muted });
      emitSnapshot();
      rebuildTray();
    },
    "stop-speech": () => {
      ttsService.stop();
      sendToRenderer("tts:stop", {});
      setPetState("idle");
    },
  };

  const failures: HotkeySetting[] = [];
  for (const hotkey of database.getHotkeys()) {
    if (!hotkey.enabled || !hotkey.accelerator.trim()) {
      continue;
    }
    const registered = globalShortcut.register(hotkey.accelerator, handlers[hotkey.action]);
    if (!registered) {
      failures.push(hotkey);
    }
  }

  if (failures.length > 0) {
    showBubble(`${t("bubble.hotkeyFailure")} ${failures.map((item) => item.accelerator).join(", ")}`, "error", 12000);
  }
}

function setPetState(state: BehaviorState, bubble?: string): void {
  const instance = database.getActiveInstance();
  database.updateInstanceState(instance.id, state);
  sendToRenderer("state:changed", { instanceId: instance.id, state, bubble });
  if (bubble) {
    showBubble(bubble, state === "error" ? "error" : state === "thinking" ? "thinking" : "neutral");
  }
}

function setRecoverableErrorState(message: string): void {
  const instanceId = database.getActiveInstance().id;
  setPetState("error", message);
  setTimeout(() => {
    const instance = database.getActiveInstance();
    if (instance.id === instanceId && instance.currentState === "error") {
      setPetState("idle");
      emitSnapshot();
    }
  }, 8000);
}

function showBubble(text: string, tone: "neutral" | "thinking" | "error", timeoutMs = 8000): void {
  sendToRenderer("bubble:show", { text, tone, timeoutMs });
}

function emitSnapshot(snapshot: AppSnapshot = database.getSnapshot(currentWindowsContext)): void {
  sendToRenderer("snapshot:changed", snapshot);
}

function sendToRenderer<T extends keyof import("../shared/types").RendererEventMap>(
  channel: T,
  payload: import("../shared/types").RendererEventMap[T],
): void {
  petWindow?.webContents.send(channel, payload);
}

function persistWindowPosition(): void {
  if (!petWindow || !database) {
    return;
  }
  const [x, y] = petWindow.getPosition();
  database.updateInstancePosition(database.getActiveInstance().id, x, y);
}

function ensurePetWindowVisible(): void {
  if (!petWindow) {
    return;
  }

  const [x, y] = petWindow.getPosition();
  const [width, height] = petWindow.getSize();
  const next = clampWindowPosition(x, y, width, height);
  if (next.x !== x || next.y !== y) {
    petWindow.setPosition(next.x, next.y, false);
    persistWindowPosition();
  }
}

function clampWindowPosition(x: number, y: number, width: number, height: number): { x: number; y: number } {
  const display = screen.getDisplayNearestPoint({
    x: Math.round(x + width / 2),
    y: Math.round(y + height / 2),
  });
  const bounds = display.workArea;
  const maxX = bounds.x + bounds.width - width;
  const maxY = bounds.y + bounds.height - height;

  return {
    x: clampNumber(x, bounds.x, Math.max(bounds.x, maxX)),
    y: clampNumber(y, bounds.y, Math.max(bounds.y, maxY)),
  };
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function startContextPolling(): void {
  void refreshWindowsContext();
  contextTimer = setInterval(() => {
    void refreshWindowsContext();
  }, contextPollIntervalMs);
}

async function refreshWindowsContext(): Promise<void> {
  currentWindowsContext = await windowsContextService.capture(database.getGlobalSettings());
  emitSnapshot();
  void maybeRunAutomaticAi(currentWindowsContext);
}

async function maybeRunAutomaticAi(nextContext: WindowsContext): Promise<void> {
  const settings = database.getGlobalSettings();
  const nowMs = Date.now();

  if (!settings.windowsContextEnabled || !settings.automaticAiCallsEnabled) {
    clearPendingAutomaticContext();
    logAutomaticDisabled(settings, nowMs);
    return;
  }

  if (nextContext.error) {
    clearPendingAutomaticContext();
    logRuntime("auto-ai", "skip=context-error", { error: nextContext.error });
    return;
  }

  if (!nextContext.enabled || !nextContext.activeProcessName) {
    clearPendingAutomaticContext();
    logRuntime("auto-ai", "skip=no-context", contextLogPayload(nextContext));
    return;
  }

  if (isOwnAppContext(nextContext)) {
    clearPendingAutomaticContext();
    return;
  }

  if (isTransientContext(nextContext)) {
    clearPendingAutomaticContext();
    logRuntime("auto-ai", "skip=transient-context", contextLogPayload(nextContext));
    return;
  }

  if (panelsOpen) {
    clearPendingAutomaticContext();
    logRuntime("auto-ai", "skip=panel-open", contextLogPayload(nextContext));
    return;
  }

  if (!petWindow?.isVisible()) {
    clearPendingAutomaticContext();
    logRuntime("auto-ai", "skip=pet-hidden", contextLogPayload(nextContext));
    return;
  }

  if (automaticCallInFlight) {
    logRuntime("auto-ai", "skip=in-flight", contextLogPayload(nextContext));
    return;
  }

  const instance = database.getActiveInstance();
  if (isAiBlockingState(instance.currentState)) {
    logRuntime("auto-ai", "skip=busy-state", { state: instance.currentState, ...contextLogPayload(nextContext) });
    return;
  }

  const nextKey = contextKey(nextContext);

  if (!automaticAiPrimed) {
    automaticAiPrimed = true;
    lastAutomaticContextKey = nextKey;
    clearPendingAutomaticContext();
    logRuntime("auto-ai", "context=primed", contextLogPayload(nextContext));
    return;
  }

  if (nextKey === lastAutomaticContextKey) {
    clearPendingAutomaticContext();
    return;
  }

  if (nextKey !== pendingAutomaticContextKey) {
    pendingAutomaticContext = nextContext;
    pendingAutomaticContextKey = nextKey;
    pendingAutomaticContextSince = nowMs;
    logRuntime("auto-ai", "context=observed", contextLogPayload(nextContext));
    return;
  }

  pendingAutomaticContext = nextContext;
  const stableForMs = nowMs - pendingAutomaticContextSince;
  if (stableForMs < automaticAiStableContextMs) {
    logRuntime("auto-ai", "wait=stable-context", {
      remainingMs: automaticAiStableContextMs - stableForMs,
      ...contextLogPayload(nextContext),
    });
    return;
  }

  if (nowMs - lastAutomaticCallAt < automaticAiCooldownMs) {
    logRuntime("auto-ai", "skip=cooldown", {
      remainingMs: automaticAiCooldownMs - (nowMs - lastAutomaticCallAt),
      ...contextLogPayload(nextContext),
    });
    return;
  }

  const stableContext = pendingAutomaticContext ?? nextContext;
  automaticCallInFlight = true;
  lastAutomaticCallAt = nowMs;
  lastAutomaticContextKey = nextKey;
  clearPendingAutomaticContext();

  try {
    logRuntime("auto-ai", "call=start", contextLogPayload(stableContext));
    setPetState("thinking", t("bubble.contextChanged"));
    setPetState("processing");
    const result = await aiService.sendAutomaticContext(instance, stableContext);

    if (!result.ok) {
      logRuntime("auto-ai", "call=error", { error: result.error, ...contextLogPayload(stableContext) });
      if (isInterrupted(result.error)) {
        setPetState("idle");
      } else {
        setRecoverableErrorState(result.error ?? t("bubble.aiFailure"));
      }
      emitSnapshot();
      return;
    }

    if (result.silent || !result.assistantMessage) {
      logRuntime("auto-ai", "call=silent", contextLogPayload(stableContext));
      setPetState("idle");
      emitSnapshot();
      return;
    }

    logRuntime("auto-ai", "call=assistant", {
      response: result.assistantMessage.content,
      ...contextLogPayload(stableContext),
    });
    await presentAssistantMessage(result.assistantMessage, "auto-ai");
    emitSnapshot();
  } finally {
    automaticCallInFlight = false;
  }
}

async function presentAssistantMessage(
  assistantMessage: NonNullable<Awaited<ReturnType<AiService["sendMessage"]>>["assistantMessage"]>,
  source: "chat" | "auto-ai",
): Promise<void> {
  setPetState("reviewing", assistantMessage.content);

  const tts = database.getTtsSettings();
  const currentInstance = database.getActiveInstance();
  if (currentInstance.ttsEnabled && !tts.muted) {
    try {
      setPetState("speaking", assistantMessage.content);
      const playback = await ttsService.synthesize(assistantMessage.content, {
        ...tts,
        voice: currentInstance.voice || tts.voice,
      });
      if (playback) {
        sendToRenderer("tts:play", playback);
      }
    } catch (error) {
      if (error instanceof TtsCanceledError) {
        setPetState("idle");
        return;
      }
      const message = error instanceof Error ? error.message : "Falha no EdgeTTS.";
      logRuntime(source, "tts=error", { error: message });
      setRecoverableErrorState(message);
    }
  } else {
    showBubble(assistantMessage.content, "neutral", source === "auto-ai" ? 10000 : 12000);
    setPetState("idle");
  }
}

function startMovementLoop(): void {
  movementTimer = setInterval(() => {
    moveAutomatically();
  }, 4200);
}

function setActiveInstanceMovementEnabled(enabled: boolean): void {
  const snapshot = database.getSnapshot(currentWindowsContext);
  database.updateSettings({
    provider: snapshot.providers[0],
    tts: snapshot.tts,
    global: snapshot.settings,
    hotkeys: snapshot.hotkeys,
    instance: {
      id: snapshot.activeInstance.id,
      name: snapshot.activeInstance.name,
      scale: snapshot.activeInstance.scale,
      persona: snapshot.activeInstance.persona,
      systemPrompt: snapshot.activeInstance.systemPrompt,
      voice: snapshot.activeInstance.voice,
      model: snapshot.activeInstance.model,
      providerId: snapshot.activeInstance.providerId,
      effort: snapshot.activeInstance.effort,
      ttsEnabled: snapshot.activeInstance.ttsEnabled,
      movementEnabled: enabled,
    },
  });
  if (!enabled && isAiBlockingState(snapshot.activeInstance.currentState) === false) {
    setPetState("idle");
  }
  emitSnapshot();
  rebuildTray();
}

function moveAutomatically(): void {
  if (!petWindow || panelsOpen || !petWindow.isVisible()) {
    return;
  }

  const instance = database.getActiveInstance();
  if (!instance.movementEnabled || instance.currentState !== "idle") {
    return;
  }

  const [x, y] = petWindow.getPosition();
  const [width, height] = petWindow.getSize();
  const display = screen.getDisplayNearestPoint({ x, y });
  const bounds = display.workArea;
  const step = Math.round(48 * instance.scale);
  let nextX = x + step * movementDirection;

  if (nextX < bounds.x) {
    nextX = bounds.x;
    movementDirection = 1;
  }

  if (nextX + width > bounds.x + bounds.width) {
    nextX = bounds.x + bounds.width - width;
    movementDirection = -1;
  }

  setPetState(movementDirection === 1 ? "walking-right" : "walking-left");
  petWindow.setPosition(nextX, y, true);
  persistWindowPosition();
  setTimeout(() => {
    if (database.getActiveInstance().currentState === "walking-left" || database.getActiveInstance().currentState === "walking-right") {
      setPetState("idle");
    }
  }, 850);
}

function moveWindowToActiveInstance(): void {
  if (!petWindow) {
    return;
  }
  const instance = database.getActiveInstance();
  const [width, height] = petWindow.getSize();
  const next = clampWindowPosition(Math.round(instance.x), Math.round(instance.y), width, height);
  petWindow.setPosition(next.x, next.y, false);
  persistWindowPosition();
}

function contextKey(context: WindowsContext): string {
  return [
    context.activeProcessName?.toLowerCase().trim() ?? "",
    context.activeWindowTitle?.toLowerCase().trim() ?? "",
  ].join("|");
}

function clearPendingAutomaticContext(): void {
  pendingAutomaticContext = null;
  pendingAutomaticContextKey = null;
  pendingAutomaticContextSince = 0;
}

function isOwnAppContext(context: WindowsContext): boolean {
  const processName = context.activeProcessName?.toLowerCase() ?? "";
  const title = context.activeWindowTitle?.toLowerCase() ?? "";
  return processName === "yumate" || (processName === "electron" && title.includes("yumate"));
}

function isTransientContext(context: WindowsContext): boolean {
  const processName = context.activeProcessName?.toLowerCase() ?? "";
  const title = context.activeWindowTitle?.toLowerCase() ?? "";

  return title === "task switching" || (processName === "explorer" && title.includes("task switching"));
}

function isAiBlockingState(state: BehaviorState): boolean {
  return state === "thinking" || state === "processing" || state === "reviewing" || state === "speaking";
}

function isInterrupted(error: string | undefined): boolean {
  return (
    error === t("error.interrupted") ||
    error === translate("en", "error.interrupted") ||
    error === translate("pt-BR", "error.interrupted")
  );
}

function contextLogPayload(context: WindowsContext): Record<string, unknown> {
  return {
    process: context.activeProcessName,
    title: context.activeWindowTitle,
    capturedAt: context.capturedAt,
  };
}

function logAutomaticDisabled(settings: ReturnType<AppDatabase["getGlobalSettings"]>, nowMs: number): void {
  if (nowMs - lastAutomaticDisabledLogAt < 60_000) {
    return;
  }

  lastAutomaticDisabledLogAt = nowMs;
  logRuntime("auto-ai", "disabled", {
    windowsContextEnabled: settings.windowsContextEnabled,
    automaticAiCallsEnabled: settings.automaticAiCallsEnabled,
  });
}

function logRuntime(scope: string, event: string, payload: Record<string, unknown> = {}): void {
  console.info(`[yumate:${scope}] ${event} ${JSON.stringify(payload)}`);
}

function t(key: TranslationKey, replacements: Record<string, string | number> = {}): string {
  return translate(database.getGlobalSettings().locale, key, replacements);
}
