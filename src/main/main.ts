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
import { TtsService } from "./ttsService";
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

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);

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

  petWindow = new BrowserWindow({
    width: 560,
    height: 640,
    x: Math.round(instance.x),
    y: Math.round(instance.y),
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
    refreshWindowsContext();
    registerHotkeys();
    const snapshot = database.getSnapshot(currentWindowsContext);
    emitSnapshot(snapshot);
    rebuildTray();
    return snapshot;
  });

  ipcMain.handle("chat:send", async (_event, content: string) => {
    const instance = database.getActiveInstance();
    setPetState("thinking", "Pensando...");
    setPetState("processing");
    const result = await aiService.sendMessage(instance, content);

    if (!result.ok || !result.assistantMessage) {
      setPetState("error", result.error ?? "Falha ao chamar IA.");
      emitSnapshot();
      return result;
    }

    emitSnapshot();
    setPetState("reviewing", result.assistantMessage.content);

    const tts = database.getTtsSettings();
    const currentInstance = database.getActiveInstance();
    if (currentInstance.ttsEnabled && !tts.muted) {
      try {
        setPetState("speaking", result.assistantMessage.content);
        const playback = await ttsService.synthesize(result.assistantMessage.content, {
          ...tts,
          voice: currentInstance.voice || tts.voice,
        });
        if (playback) {
          sendToRenderer("tts:play", playback);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Falha no EdgeTTS.";
        setPetState("error", message);
      }
    } else {
      showBubble(result.assistantMessage.content, "neutral", 12000);
      setPetState("idle");
    }

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
  });

  ipcMain.handle("window:setClickThrough", (_event, ignore: boolean) => {
    petWindow?.setIgnoreMouseEvents(ignore, { forward: true });
  });

  ipcMain.handle("window:moveBy", (_event, delta: { x: number; y: number }) => {
    if (!petWindow) {
      return;
    }
    const [x, y] = petWindow.getPosition();
    petWindow.setPosition(Math.round(x + delta.x), Math.round(y + delta.y), false);
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
      label: "Open chat",
      click: () => {
        petWindow?.show();
        sendToRenderer("ui:toggle-chat", { open: true });
      },
    },
    {
      label: tts.muted ? "Unmute" : "Mute",
      click: () => {
        database.updateTtsSettings({ ...tts, muted: !tts.muted });
        emitSnapshot();
        rebuildTray();
      },
    },
    {
      label: "Stop speech",
      click: () => {
        ttsService.stop();
        sendToRenderer("tts:stop", {});
        setPetState("idle");
      },
    },
    {
      label: petWindow?.isVisible() ? "Hide pet" : "Show pet",
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
      label: "Select active pet",
      submenu: petItems.length > 0 ? petItems : [{ label: "No pets installed", enabled: false }],
    },
    {
      label: "Select instance",
      submenu: instanceItems.length > 0 ? instanceItems : [{ label: "No instances", enabled: false }],
    },
    {
      label: "Create instance",
      click: () => {
        database.createInstance(snapshot.activeInstance.petPackId);
        moveWindowToActiveInstance();
        emitSnapshot();
        rebuildTray();
      },
    },
    {
      label: "Import pet",
      click: async () => {
        if (petWindow) {
          await petPackService.importWithDialog(petWindow);
          emitSnapshot();
          rebuildTray();
        }
      },
    },
    {
      label: "Settings",
      click: () => {
        petWindow?.show();
        sendToRenderer("ui:open-settings", {});
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
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
    showBubble(`Nao consegui registrar: ${failures.map((item) => item.accelerator).join(", ")}`, "error", 12000);
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

function startContextPolling(): void {
  void refreshWindowsContext();
  contextTimer = setInterval(() => {
    void refreshWindowsContext();
  }, 15000);
}

async function refreshWindowsContext(): Promise<void> {
  currentWindowsContext = await windowsContextService.capture(database.getGlobalSettings());
  emitSnapshot();
}

function startMovementLoop(): void {
  movementTimer = setInterval(() => {
    moveAutomatically();
  }, 4200);
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
  petWindow.setPosition(Math.round(instance.x), Math.round(instance.y), false);
}
