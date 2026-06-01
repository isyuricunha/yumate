export type BehaviorState =
  | "idle"
  | "walking-left"
  | "walking-right"
  | "thinking"
  | "processing"
  | "reviewing"
  | "speaking"
  | "clicked"
  | "error";

export const behaviorStates: BehaviorState[] = [
  "idle",
  "walking-left",
  "walking-right",
  "thinking",
  "processing",
  "reviewing",
  "speaking",
  "clicked",
  "error",
];

export type EffortLevel = "low" | "medium" | "high";
export type LocaleCode = "en" | "pt-BR";

export interface PetAnimation {
  row: number;
  frames: number;
  fps: number;
  loop?: boolean;
  startFrame?: number;
  returnState?: BehaviorState;
}

export interface DesktopPetMetadata {
  schemaVersion: number;
  frameWidth: number;
  frameHeight: number;
  columns: number;
  rows: number;
  animations: Record<string, PetAnimation>;
  stateMap: Partial<Record<BehaviorState, string>>;
}

export interface TwoDPetMotion {
  bobPixels?: number;
  bobSeconds?: number;
  breatheScale?: number;
  swayDegrees?: number;
}

export interface TwoDPetMetadata {
  schemaVersion: number;
  imagePath?: string;
  width?: number;
  height?: number;
  idleMotion?: TwoDPetMotion;
  speakingMotion?: TwoDPetMotion;
  stateMotions?: Partial<Record<BehaviorState, TwoDPetMotion>>;
}

export interface PetJson {
  id: string;
  displayName: string;
  description: string;
  spritesheetPath: string;
  desktopPet?: DesktopPetMetadata;
  twoD?: TwoDPetMetadata;
}

export interface PetValidationIssue {
  code: string;
  message: string;
  path?: string;
}

export interface PetValidationResult {
  valid: boolean;
  issues: PetValidationIssue[];
  warnings: PetValidationIssue[];
}

export interface InstalledPetPack {
  id: string;
  displayName: string;
  description: string;
  directoryPath: string;
  petJsonPath: string;
  spritesheetPath: string;
  metadata: DesktopPetMetadata | null;
  twoD: TwoDPetMetadata | null;
  twoDImagePath: string | null;
  valid: boolean;
  validation: PetValidationResult;
  installedAt: string;
  updatedAt: string;
}

export interface AiProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  supportsReasoning: boolean;
  supportsEffort: boolean;
  defaultEffort: EffortLevel;
  temperature: number;
  streamEnabled: boolean;
  updatedAt: string;
}

export interface TtsSettings {
  id: string;
  voice: string;
  rate: string;
  pitch: string;
  volume: number;
  muted: boolean;
  updatedAt: string;
}

export interface PetInstance {
  id: string;
  petPackId: string;
  name: string;
  x: number;
  y: number;
  monitorId: string | null;
  scale: number;
  visible: boolean;
  persona: string;
  systemPrompt: string;
  voice: string | null;
  model: string | null;
  providerId: string | null;
  effort: EffortLevel;
  ttsEnabled: boolean;
  movementEnabled: boolean;
  currentState: BehaviorState;
  createdAt: string;
  updatedAt: string;
}

export type MessageRole = "system" | "user" | "assistant" | "tool";
export type MessageStatus = "pending" | "sent" | "error";

export interface ChatMessage {
  id: string;
  conversationId: string;
  role: MessageRole;
  content: string;
  createdAt: string;
  model: string | null;
  providerId: string | null;
  status: MessageStatus;
  error: string | null;
  spoken: boolean;
  metadata: Record<string, unknown>;
}

export interface Conversation {
  id: string;
  petInstanceId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export type HotkeyAction = "open-chat" | "toggle-pet" | "mute" | "stop-speech";

export interface HotkeySetting {
  action: HotkeyAction;
  accelerator: string;
  enabled: boolean;
}

export interface WindowsContext {
  enabled: boolean;
  activeWindowTitle: string | null;
  activeProcessName: string | null;
  activeProcessId: number | null;
  capturedAt: string | null;
  error: string | null;
}

export interface GlobalSettings {
  theme: "system" | "light" | "dark";
  locale: LocaleCode;
  startWithWindows: boolean;
  defaultProviderId: string;
  defaultModel: string;
  defaultEffort: EffortLevel;
  petsFolderPath: string;
  clickThroughEnabled: boolean;
  trayBehavior: "minimize-to-tray" | "quit";
  windowsContextEnabled: boolean;
  activeWindowTitleEnabled: boolean;
  chatHistoryEnabled: boolean;
  automaticAiCallsEnabled: boolean;
}

export interface AppSnapshot {
  settings: GlobalSettings;
  providers: AiProvider[];
  tts: TtsSettings;
  petPacks: InstalledPetPack[];
  instances: PetInstance[];
  activeInstance: PetInstance;
  activePetPack: InstalledPetPack;
  conversation: Conversation;
  messages: ChatMessage[];
  hotkeys: HotkeySetting[];
  windowsContext: WindowsContext;
}

export interface SaveSettingsPayload {
  provider: AiProvider;
  tts: TtsSettings;
  instance: Pick<
    PetInstance,
    | "id"
    | "name"
    | "scale"
    | "persona"
    | "systemPrompt"
    | "voice"
    | "model"
    | "providerId"
    | "effort"
    | "ttsEnabled"
    | "movementEnabled"
  >;
  global: GlobalSettings;
  hotkeys: HotkeySetting[];
}

export interface SendMessageResult {
  ok: boolean;
  assistantMessage?: ChatMessage;
  error?: string;
  silent?: boolean;
}

export interface TtsPlaybackRequest {
  id: string;
  text: string;
  audioUrl: string;
  voice: string;
  rate: string;
  pitch: string;
  volume: number;
}

export interface ImportPetResult {
  ok: boolean;
  pack?: InstalledPetPack;
  error?: string;
}

export interface RendererEventMap {
  "snapshot:changed": AppSnapshot;
  "state:changed": { instanceId: string; state: BehaviorState; bubble?: string };
  "bubble:show": { text: string; tone: "neutral" | "thinking" | "error"; timeoutMs?: number };
  "ui:toggle-chat": { open?: boolean };
  "ui:open-settings": Record<string, never>;
  "tts:play": TtsPlaybackRequest;
  "tts:stop": { id?: string };
}
