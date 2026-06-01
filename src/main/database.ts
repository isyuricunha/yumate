import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { safeStorage } from "electron";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";
import {
  type AiProvider,
  type AppSnapshot,
  type BehaviorState,
  type ChatMessage,
  type Conversation,
  type EffortLevel,
  type GlobalSettings,
  type HotkeyAction,
  type HotkeySetting,
  type InstalledPetPack,
  type PetInstance,
  type SaveSettingsPayload,
  type TtsSettings,
  type WindowsContext,
} from "../shared/types";
import { getDefaultPromptPreset, normalizeLocale } from "../shared/i18n";

type SqlValue = string | number | Uint8Array | null;

interface RawPetPackRow {
  id: string;
  display_name: string;
  description: string;
  directory_path: string;
  pet_json_path: string;
  spritesheet_path: string;
  metadata_json: string | null;
  valid: number;
  validation_json: string;
  installed_at: string;
  updated_at: string;
}

interface RawProviderRow {
  id: string;
  name: string;
  base_url: string;
  api_key: string;
  model: string;
  supports_reasoning: number;
  supports_effort: number;
  default_effort: EffortLevel;
  temperature: number;
  stream_enabled: number;
  updated_at: string;
}

interface RawTtsRow {
  id: string;
  voice: string;
  rate: string;
  pitch: string;
  volume: number;
  muted: number;
  updated_at: string;
}

interface RawInstanceRow {
  id: string;
  pet_pack_id: string;
  name: string;
  x: number;
  y: number;
  monitor_id: string | null;
  scale: number;
  visible: number;
  persona: string;
  system_prompt: string;
  voice: string | null;
  model: string | null;
  provider_id: string | null;
  effort: EffortLevel;
  tts_enabled: number;
  movement_enabled: number;
  current_state: BehaviorState;
  created_at: string;
  updated_at: string;
}

interface RawConversationRow {
  id: string;
  pet_instance_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface RawMessageRow {
  id: string;
  conversation_id: string;
  role: ChatMessage["role"];
  content: string;
  created_at: string;
  model: string | null;
  provider_id: string | null;
  status: ChatMessage["status"];
  error: string | null;
  spoken: number;
  metadata_json: string;
}

interface RawHotkeyRow {
  action: HotkeyAction;
  accelerator: string;
  enabled: number;
}

export class AppDatabase {
  private db: SqlJsDatabase | null = null;

  constructor(
    private readonly dbPath: string,
    private readonly wasmPath: string,
    private readonly petsFolderPath: string,
  ) {}

  async initialize(): Promise<void> {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    const SQL = await initSqlJs({ locateFile: () => this.wasmPath });
    const bytes = fs.existsSync(this.dbPath) ? fs.readFileSync(this.dbPath) : undefined;
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.exec("PRAGMA foreign_keys = ON");
    this.migrate();
    this.ensureDefaults();
    this.persist();
  }

  getSnapshot(windowsContext: WindowsContext = emptyWindowsContext()): AppSnapshot {
    const settings = this.getGlobalSettings();
    const providers = this.getProviders();
    const tts = this.getTtsSettings();
    const petPacks = this.getPetPacks();
    const instances = this.getInstances();
    const activeInstance = this.getActiveInstance();
    const activePetPack = petPacks.find((pack) => pack.id === activeInstance.petPackId);

    if (!activePetPack) {
      throw new Error(`Active pet pack "${activeInstance.petPackId}" was not found.`);
    }

    const conversation = this.ensureConversation(activeInstance.id);
    const messages = settings.chatHistoryEnabled ? this.getMessages(conversation.id) : [];

    return {
      settings,
      providers,
      tts,
      petPacks,
      instances,
      activeInstance,
      activePetPack,
      conversation,
      messages,
      hotkeys: this.getHotkeys(),
      windowsContext,
    };
  }

  getGlobalSettings(): GlobalSettings {
    const row = this.one<{ value_json: string }>("SELECT value_json FROM global_settings WHERE key = ?", ["global"]);
    if (!row) {
      throw new Error("Global settings are missing.");
    }
    return normalizeGlobalSettings(JSON.parse(row.value_json), this.petsFolderPath);
  }

  setGlobalSettings(settings: GlobalSettings): void {
    this.run(
      "UPDATE global_settings SET value_json = ?, updated_at = ? WHERE key = ?",
      [JSON.stringify(settings), now(), "global"],
    );
  }

  getProviders(): AiProvider[] {
    return this.all<RawProviderRow>("SELECT * FROM ai_providers ORDER BY updated_at DESC").map(mapProvider);
  }

  getProvider(id?: string | null): AiProvider {
    const providerId = id ?? this.getGlobalSettings().defaultProviderId;
    const row = this.one<RawProviderRow>("SELECT * FROM ai_providers WHERE id = ?", [providerId]);
    if (!row) {
      throw new Error(`AI provider "${providerId}" was not found.`);
    }
    return mapProvider(row);
  }

  upsertProvider(provider: AiProvider): void {
    this.run(
      `INSERT INTO ai_providers (
        id, name, base_url, api_key, model, supports_reasoning, supports_effort,
        default_effort, temperature, stream_enabled, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        base_url = excluded.base_url,
        api_key = excluded.api_key,
        model = excluded.model,
        supports_reasoning = excluded.supports_reasoning,
        supports_effort = excluded.supports_effort,
        default_effort = excluded.default_effort,
        temperature = excluded.temperature,
        stream_enabled = excluded.stream_enabled,
        updated_at = excluded.updated_at`,
      [
        provider.id,
        provider.name,
        provider.baseUrl,
        protectSecret(provider.apiKey),
        provider.model,
        provider.supportsReasoning ? 1 : 0,
        provider.supportsEffort ? 1 : 0,
        provider.defaultEffort,
        provider.temperature,
        provider.streamEnabled ? 1 : 0,
        now(),
      ],
    );
  }

  getTtsSettings(): TtsSettings {
    const row = this.one<RawTtsRow>("SELECT * FROM tts_settings WHERE id = ?", ["global"]);
    if (!row) {
      throw new Error("TTS settings are missing.");
    }
    return mapTts(row);
  }

  updateTtsSettings(settings: TtsSettings): void {
    this.run(
      `UPDATE tts_settings SET voice = ?, rate = ?, pitch = ?, volume = ?, muted = ?, updated_at = ? WHERE id = ?`,
      [settings.voice, settings.rate, settings.pitch, settings.volume, settings.muted ? 1 : 0, now(), settings.id],
    );
  }

  getPetPacks(): InstalledPetPack[] {
    return this.all<RawPetPackRow>("SELECT * FROM pet_packs ORDER BY display_name COLLATE NOCASE").map(mapPetPack);
  }

  registerPetPack(pack: InstalledPetPack): void {
    this.run(
      `INSERT INTO pet_packs (
        id, display_name, description, directory_path, pet_json_path, spritesheet_path,
        metadata_json, valid, validation_json, installed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        display_name = excluded.display_name,
        description = excluded.description,
        directory_path = excluded.directory_path,
        pet_json_path = excluded.pet_json_path,
        spritesheet_path = excluded.spritesheet_path,
        metadata_json = excluded.metadata_json,
        valid = excluded.valid,
        validation_json = excluded.validation_json,
        updated_at = excluded.updated_at`,
      [
        pack.id,
        pack.displayName,
        pack.description,
        pack.directoryPath,
        pack.petJsonPath,
        pack.spritesheetPath,
        pack.metadata ? JSON.stringify(pack.metadata) : null,
        pack.valid ? 1 : 0,
        JSON.stringify(pack.validation),
        pack.installedAt,
        now(),
      ],
    );
  }

  ensureDefaultInstance(petPackId: string): PetInstance {
    const existing = this.one<RawInstanceRow>("SELECT * FROM pet_instances ORDER BY created_at LIMIT 1");
    if (existing) {
      this.setUiState("activeInstanceId", existing.id);
      return mapInstance(existing);
    }

    const createdAt = now();
    const id = randomUUID();
    const prompts = getDefaultPromptPreset(this.getGlobalSettings().locale);
    this.run(
      `INSERT INTO pet_instances (
        id, pet_pack_id, name, x, y, monitor_id, scale, visible, persona, system_prompt,
        voice, model, provider_id, effort, tts_enabled, movement_enabled, current_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        petPackId,
        "Yumate",
        120,
        160,
        null,
        1,
        1,
        prompts.persona,
        prompts.systemPrompt,
        null,
        null,
        "default-openai-compatible",
        "medium",
        1,
        0,
        "idle",
        createdAt,
        createdAt,
      ],
    );

    this.setUiState("activeInstanceId", id);
    return this.getActiveInstance();
  }

  resetTransientRuntimeStates(): void {
    this.run(
      `UPDATE pet_instances
       SET current_state = 'idle', updated_at = ?
       WHERE current_state IN ('thinking', 'processing', 'reviewing', 'speaking', 'clicked', 'walking-left', 'walking-right', 'error')`,
      [now()],
    );
  }

  getInstances(): PetInstance[] {
    return this.all<RawInstanceRow>("SELECT * FROM pet_instances ORDER BY created_at").map(mapInstance);
  }

  getActiveInstance(): PetInstance {
    const activeId = this.getUiState<string>("activeInstanceId");
    const row = activeId
      ? this.one<RawInstanceRow>("SELECT * FROM pet_instances WHERE id = ?", [activeId])
      : this.one<RawInstanceRow>("SELECT * FROM pet_instances ORDER BY visible DESC, created_at LIMIT 1");
    if (!row) {
      throw new Error("No pet instance exists.");
    }
    return mapInstance(row);
  }

  createInstance(petPackId: string): AppSnapshot {
    const base = this.getActiveInstance();
    const createdAt = now();
    const id = randomUUID();
    this.run(
      `INSERT INTO pet_instances (
        id, pet_pack_id, name, x, y, monitor_id, scale, visible, persona, system_prompt,
        voice, model, provider_id, effort, tts_enabled, movement_enabled, current_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        petPackId,
        `${base.name} ${this.getInstances().length + 1}`,
        base.x + 36,
        base.y + 36,
        base.monitorId,
        base.scale,
        1,
        base.persona,
        base.systemPrompt,
        base.voice,
        base.model,
        base.providerId,
        base.effort,
        base.ttsEnabled ? 1 : 0,
        base.movementEnabled ? 1 : 0,
        "idle",
        createdAt,
        createdAt,
      ],
    );
    this.setUiState("activeInstanceId", id);
    return this.getSnapshot();
  }

  selectInstance(instanceId: string): AppSnapshot {
    const row = this.one<RawInstanceRow>("SELECT * FROM pet_instances WHERE id = ?", [instanceId]);
    if (!row) {
      throw new Error(`Pet instance "${instanceId}" was not found.`);
    }
    this.setUiState("activeInstanceId", instanceId);
    return this.getSnapshot();
  }

  updateInstancePosition(instanceId: string, x: number, y: number): void {
    this.run("UPDATE pet_instances SET x = ?, y = ?, updated_at = ? WHERE id = ?", [x, y, now(), instanceId]);
  }

  updateInstanceState(instanceId: string, state: BehaviorState): void {
    this.run("UPDATE pet_instances SET current_state = ?, updated_at = ? WHERE id = ?", [state, now(), instanceId]);
  }

  updateActivePetPack(instanceId: string, petPackId: string): AppSnapshot {
    this.run("UPDATE pet_instances SET pet_pack_id = ?, updated_at = ? WHERE id = ?", [petPackId, now(), instanceId]);
    return this.getSnapshot();
  }

  updateSettings(payload: SaveSettingsPayload): AppSnapshot {
    this.upsertProvider(payload.provider);
    this.updateTtsSettings(payload.tts);
    this.setGlobalSettings(payload.global);
    this.updateHotkeys(payload.hotkeys);
    this.run(
      `UPDATE pet_instances SET
        name = ?, scale = ?, persona = ?, system_prompt = ?, voice = ?, model = ?, provider_id = ?,
        effort = ?, tts_enabled = ?, movement_enabled = ?, updated_at = ?
      WHERE id = ?`,
      [
        payload.instance.name,
        payload.instance.scale,
        payload.instance.persona,
        payload.instance.systemPrompt,
        payload.instance.voice,
        payload.instance.model,
        payload.instance.providerId,
        payload.instance.effort,
        payload.instance.ttsEnabled ? 1 : 0,
        payload.instance.movementEnabled ? 1 : 0,
        now(),
        payload.instance.id,
      ],
    );
    return this.getSnapshot();
  }

  ensureConversation(instanceId: string): Conversation {
    const existing = this.one<RawConversationRow>(
      "SELECT * FROM conversations WHERE pet_instance_id = ? ORDER BY updated_at DESC LIMIT 1",
      [instanceId],
    );
    if (existing) {
      return mapConversation(existing);
    }

    const createdAt = now();
    const id = randomUUID();
    this.run(
      "INSERT INTO conversations (id, pet_instance_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      [id, instanceId, "Chat", createdAt, createdAt],
    );
    return this.ensureConversation(instanceId);
  }

  getMessages(conversationId: string, limit = 100): ChatMessage[] {
    return this.all<RawMessageRow>(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?`,
      [conversationId, limit],
    )
      .map(mapMessage)
      .reverse();
  }

  addMessage(input: Omit<ChatMessage, "id" | "createdAt"> & { id?: string; createdAt?: string }): ChatMessage {
    const message: ChatMessage = {
      id: input.id ?? randomUUID(),
      conversationId: input.conversationId,
      role: input.role,
      content: input.content,
      createdAt: input.createdAt ?? now(),
      model: input.model,
      providerId: input.providerId,
      status: input.status,
      error: input.error,
      spoken: input.spoken,
      metadata: input.metadata,
    };

    this.run(
      `INSERT INTO messages (
        id, conversation_id, role, content, created_at, model, provider_id, status, error, spoken, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        message.id,
        message.conversationId,
        message.role,
        message.content,
        message.createdAt,
        message.model,
        message.providerId,
        message.status,
        message.error,
        message.spoken ? 1 : 0,
        JSON.stringify(message.metadata),
      ],
    );

    this.run("UPDATE conversations SET updated_at = ? WHERE id = ?", [now(), message.conversationId]);
    return message;
  }

  clearHistory(instanceId: string): AppSnapshot {
    const conversation = this.ensureConversation(instanceId);
    this.run("DELETE FROM messages WHERE conversation_id = ?", [conversation.id]);
    return this.getSnapshot();
  }

  getHotkeys(): HotkeySetting[] {
    return this.all<RawHotkeyRow>("SELECT * FROM hotkeys ORDER BY action").map((row) => ({
      action: row.action,
      accelerator: row.accelerator,
      enabled: Boolean(row.enabled),
    }));
  }

  updateHotkeys(hotkeys: HotkeySetting[]): void {
    for (const hotkey of hotkeys) {
      this.run(
        `INSERT INTO hotkeys (action, accelerator, enabled) VALUES (?, ?, ?)
         ON CONFLICT(action) DO UPDATE SET
          accelerator = excluded.accelerator,
          enabled = excluded.enabled`,
        [hotkey.action, hotkey.accelerator, hotkey.enabled ? 1 : 0],
      );
    }
  }

  private ensureDefaults(): void {
    const defaultSettings = createDefaultGlobalSettings(this.petsFolderPath);

    this.exec(
      `INSERT OR IGNORE INTO global_settings (key, value_json, updated_at)
       VALUES ('global', '${escapeSql(JSON.stringify(defaultSettings))}', '${now()}')`,
    );

    this.exec(
      `INSERT OR IGNORE INTO ai_providers (
        id, name, base_url, api_key, model, supports_reasoning, supports_effort,
        default_effort, temperature, stream_enabled, updated_at
      ) VALUES (
        'default-openai-compatible', 'OpenAI Compatible', 'https://api.openai.com/v1', '',
        'gpt-4o-mini', 0, 0, 'medium', 0.7, 0, '${now()}'
      )`,
    );

    this.exec(
      `INSERT OR IGNORE INTO tts_settings (id, voice, rate, pitch, volume, muted, updated_at)
       VALUES ('global', 'pt-BR-FranciscaNeural', 'medium', 'default', 0.9, 0, '${now()}')`,
    );

    const hotkeys = [
      ["open-chat", "CommandOrControl+Alt+Y"],
      ["toggle-pet", "CommandOrControl+Alt+P"],
      ["mute", "CommandOrControl+Alt+M"],
      ["stop-speech", "CommandOrControl+Alt+S"],
    ];

    for (const [action, accelerator] of hotkeys) {
      this.exec(
        `INSERT OR IGNORE INTO hotkeys (action, accelerator, enabled)
         VALUES ('${action}', '${accelerator}', 1)`,
      );
    }
  }

  private migrate(): void {
    this.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
    const version = this.one<{ version: number }>("SELECT MAX(version) as version FROM schema_migrations")?.version ?? 0;

    if (version < 1) {
      this.exec(`
        BEGIN TRANSACTION;

        CREATE TABLE IF NOT EXISTS global_settings (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS ai_providers (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          base_url TEXT NOT NULL,
          api_key TEXT NOT NULL DEFAULT '',
          model TEXT NOT NULL,
          supports_reasoning INTEGER NOT NULL DEFAULT 0,
          supports_effort INTEGER NOT NULL DEFAULT 0,
          default_effort TEXT NOT NULL DEFAULT 'medium',
          temperature REAL NOT NULL DEFAULT 0.7,
          stream_enabled INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS tts_settings (
          id TEXT PRIMARY KEY,
          voice TEXT NOT NULL,
          rate TEXT NOT NULL,
          pitch TEXT NOT NULL,
          volume REAL NOT NULL DEFAULT 0.9,
          muted INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pet_packs (
          id TEXT PRIMARY KEY,
          display_name TEXT NOT NULL,
          description TEXT NOT NULL,
          directory_path TEXT NOT NULL,
          pet_json_path TEXT NOT NULL,
          spritesheet_path TEXT NOT NULL,
          metadata_json TEXT,
          valid INTEGER NOT NULL,
          validation_json TEXT NOT NULL,
          installed_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS pet_instances (
          id TEXT PRIMARY KEY,
          pet_pack_id TEXT NOT NULL,
          name TEXT NOT NULL,
          x REAL NOT NULL,
          y REAL NOT NULL,
          monitor_id TEXT,
          scale REAL NOT NULL DEFAULT 1,
          visible INTEGER NOT NULL DEFAULT 1,
          persona TEXT NOT NULL,
          system_prompt TEXT NOT NULL,
          voice TEXT,
          model TEXT,
          provider_id TEXT,
          effort TEXT NOT NULL DEFAULT 'medium',
          tts_enabled INTEGER NOT NULL DEFAULT 1,
          movement_enabled INTEGER NOT NULL DEFAULT 0,
          current_state TEXT NOT NULL DEFAULT 'idle',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (pet_pack_id) REFERENCES pet_packs(id)
        );

        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          pet_instance_id TEXT NOT NULL,
          title TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (pet_instance_id) REFERENCES pet_instances(id)
        );

        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT NOT NULL,
          model TEXT,
          provider_id TEXT,
          status TEXT NOT NULL,
          error TEXT,
          spoken INTEGER NOT NULL DEFAULT 0,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS hotkeys (
          action TEXT PRIMARY KEY,
          accelerator TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE IF NOT EXISTS ui_state (
          key TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO schema_migrations (version, applied_at) VALUES (1, '${now()}');
        COMMIT;
      `);
    }
  }

  private run(sql: string, params: SqlValue[] = []): void {
    const statement = this.database.prepare(sql);
    try {
      statement.run(params);
    } finally {
      statement.free();
    }
    this.persist();
  }

  private exec(sql: string): void {
    this.database.exec(sql);
  }

  private all<T>(sql: string, params: SqlValue[] = []): T[] {
    const statement = this.database.prepare(sql);
    const rows: T[] = [];
    try {
      statement.bind(params);
      while (statement.step()) {
        rows.push(statement.getAsObject() as T);
      }
    } finally {
      statement.free();
    }
    return rows;
  }

  private one<T>(sql: string, params: SqlValue[] = []): T | null {
    return this.all<T>(sql, params)[0] ?? null;
  }

  private getUiState<T>(key: string): T | null {
    const row = this.one<{ value_json: string }>("SELECT value_json FROM ui_state WHERE key = ?", [key]);
    return row ? (JSON.parse(row.value_json) as T) : null;
  }

  private setUiState(key: string, value: unknown): void {
    this.run(
      `INSERT INTO ui_state (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), now()],
    );
  }

  private persist(): void {
    const data = this.database.export();
    fs.writeFileSync(this.dbPath, data);
  }

  private get database(): SqlJsDatabase {
    if (!this.db) {
      throw new Error("Database has not been initialized.");
    }
    return this.db;
  }
}

function mapProvider(row: RawProviderRow): AiProvider {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    apiKey: unprotectSecret(row.api_key),
    model: row.model,
    supportsReasoning: Boolean(row.supports_reasoning),
    supportsEffort: Boolean(row.supports_effort),
    defaultEffort: row.default_effort,
    temperature: row.temperature,
    streamEnabled: Boolean(row.stream_enabled),
    updatedAt: row.updated_at,
  };
}

function mapTts(row: RawTtsRow): TtsSettings {
  return {
    id: row.id,
    voice: row.voice,
    rate: row.rate,
    pitch: row.pitch,
    volume: row.volume,
    muted: Boolean(row.muted),
    updatedAt: row.updated_at,
  };
}

function mapPetPack(row: RawPetPackRow): InstalledPetPack {
  return {
    id: row.id,
    displayName: row.display_name,
    description: row.description,
    directoryPath: row.directory_path,
    petJsonPath: row.pet_json_path,
    spritesheetPath: row.spritesheet_path,
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : null,
    valid: Boolean(row.valid),
    validation: JSON.parse(row.validation_json),
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

function mapInstance(row: RawInstanceRow): PetInstance {
  return {
    id: row.id,
    petPackId: row.pet_pack_id,
    name: row.name,
    x: row.x,
    y: row.y,
    monitorId: row.monitor_id,
    scale: row.scale,
    visible: Boolean(row.visible),
    persona: row.persona,
    systemPrompt: row.system_prompt,
    voice: row.voice,
    model: row.model,
    providerId: row.provider_id,
    effort: row.effort,
    ttsEnabled: Boolean(row.tts_enabled),
    movementEnabled: Boolean(row.movement_enabled),
    currentState: row.current_state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversation(row: RawConversationRow): Conversation {
  return {
    id: row.id,
    petInstanceId: row.pet_instance_id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessage(row: RawMessageRow): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    model: row.model,
    providerId: row.provider_id,
    status: row.status,
    error: row.error,
    spoken: Boolean(row.spoken),
    metadata: JSON.parse(row.metadata_json || "{}"),
  };
}

function createDefaultGlobalSettings(petsFolderPath: string): GlobalSettings {
  return {
    theme: "system",
    locale: "pt-BR",
    startWithWindows: false,
    defaultProviderId: "default-openai-compatible",
    defaultModel: "gpt-4o-mini",
    defaultEffort: "medium",
    petsFolderPath,
    clickThroughEnabled: true,
    trayBehavior: "minimize-to-tray",
    windowsContextEnabled: false,
    activeWindowTitleEnabled: false,
    chatHistoryEnabled: true,
    automaticAiCallsEnabled: false,
  };
}

function normalizeGlobalSettings(value: unknown, petsFolderPath: string): GlobalSettings {
  const defaults = createDefaultGlobalSettings(petsFolderPath);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaults;
  }

  const partial = value as Partial<GlobalSettings>;
  return {
    ...defaults,
    ...partial,
    locale: normalizeLocale(partial.locale),
    theme: partial.theme === "light" || partial.theme === "dark" || partial.theme === "system" ? partial.theme : defaults.theme,
    trayBehavior:
      partial.trayBehavior === "quit" || partial.trayBehavior === "minimize-to-tray"
        ? partial.trayBehavior
        : defaults.trayBehavior,
  };
}

function now(): string {
  return new Date().toISOString();
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

function emptyWindowsContext(): WindowsContext {
  return {
    enabled: false,
    activeWindowTitle: null,
    activeProcessName: null,
    activeProcessId: null,
    capturedAt: null,
    error: null,
  };
}

function protectSecret(value: string): string {
  if (!value || !safeStorage.isEncryptionAvailable()) {
    return value;
  }

  return `safe:v1:${safeStorage.encryptString(value).toString("base64")}`;
}

function unprotectSecret(value: string): string {
  if (!value.startsWith("safe:v1:")) {
    return value;
  }

  if (!safeStorage.isEncryptionAvailable()) {
    return "";
  }

  try {
    return safeStorage.decryptString(Buffer.from(value.slice("safe:v1:".length), "base64"));
  } catch {
    return "";
  }
}
