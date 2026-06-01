import { randomUUID } from "node:crypto";
import { type AppDatabase } from "./database";
import { type WindowsContextService } from "./windowsContextService";
import {
  type AiProvider,
  type ChatMessage,
  type LocaleCode,
  type PetInstance,
  type SendMessageResult,
  type WindowsContext,
} from "../shared/types";
import {
  formatAutomaticContextUserMessage as formatLocalizedAutomaticContextUserMessage,
  formatWindowsContextForPrompt,
  getDefaultPromptPreset,
  translate,
} from "../shared/i18n";

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
    delta?: {
      content?: unknown;
    };
  }>;
  output_text?: unknown;
  error?: {
    message?: string;
  };
}

export class AiService {
  private activeController: AbortController | null = null;

  constructor(
    private readonly database: AppDatabase,
    private readonly windowsContextService: WindowsContextService,
  ) {}

  cancel(): void {
    this.activeController?.abort();
    this.activeController = null;
  }

  async sendMessage(instance: PetInstance, content: string): Promise<SendMessageResult> {
    const conversation = this.database.ensureConversation(instance.id);
    const provider = this.database.getProvider(instance.providerId);
    const model = instance.model || provider.model;
    const settings = this.database.getGlobalSettings();
    const persistHistory = settings.chatHistoryEnabled;

    const userMessage = {
      conversationId: conversation.id,
      role: "user",
      content,
      model,
      providerId: provider.id,
      status: "sent",
      error: null,
      spoken: false,
      metadata: {},
    } satisfies Omit<ChatMessage, "id" | "createdAt">;

    if (persistHistory) {
      this.database.addMessage(userMessage);
    }

    try {
      const responseText = await this.requestChatCompletion(instance, provider, {
        userContent: content,
      });
      const assistantMessageInput = {
        conversationId: conversation.id,
        role: "assistant",
        content: responseText,
        model,
        providerId: provider.id,
        status: "sent",
        error: null,
        spoken: false,
        metadata: {},
      } satisfies Omit<ChatMessage, "id" | "createdAt">;
      const assistantMessage = persistHistory
        ? this.database.addMessage(assistantMessageInput)
        : createTransientMessage(assistantMessageInput);
      return { ok: true, assistantMessage };
    } catch (error) {
      const friendly = formatProviderError(error, settings.locale);
      const assistantMessage = {
        conversationId: conversation.id,
        role: "assistant",
        content: friendly,
        model,
        providerId: provider.id,
        status: "error",
        error: friendly,
        spoken: false,
        metadata: {},
      } satisfies Omit<ChatMessage, "id" | "createdAt">;
      if (persistHistory) {
        this.database.addMessage(assistantMessage);
      }
      return { ok: false, error: friendly };
    }
  }

  async sendAutomaticContext(instance: PetInstance, context: WindowsContext): Promise<SendMessageResult> {
    const conversation = this.database.ensureConversation(instance.id);
    const provider = this.database.getProvider(instance.providerId);
    const model = instance.model || provider.model;
    const settings = this.database.getGlobalSettings();
    const content = formatLocalizedAutomaticContextUserMessage(context, settings.locale);
    const persistHistory = settings.chatHistoryEnabled;

    const userMessage = {
      conversationId: conversation.id,
      role: "user",
      content,
      model,
      providerId: provider.id,
      status: "sent",
      error: null,
      spoken: false,
      metadata: {
        source: "automatic-context",
        context,
      },
    } satisfies Omit<ChatMessage, "id" | "createdAt">;

    if (persistHistory) {
      this.database.addMessage(userMessage);
    }

    try {
      const responseText = await this.requestChatCompletion(instance, provider, {
        userContent: content,
        context,
        effortOverride: "low",
        includeHistory: false,
        maxTokens: 120,
        timeoutMs: 30_000,
        systemAddendum: getDefaultPromptPreset(settings.locale).automaticSystemAddendum,
      });

      if (isSilentResponse(responseText)) {
        return { ok: true, silent: true };
      }

      const assistantMessageInput = {
        conversationId: conversation.id,
        role: "assistant",
        content: responseText,
        model,
        providerId: provider.id,
        status: "sent",
        error: null,
        spoken: false,
        metadata: {
          source: "automatic-context",
          context,
        },
      } satisfies Omit<ChatMessage, "id" | "createdAt">;
      const assistantMessage = persistHistory
        ? this.database.addMessage(assistantMessageInput)
        : createTransientMessage(assistantMessageInput);
      return { ok: true, assistantMessage };
    } catch (error) {
      const friendly = formatProviderError(error, settings.locale);
      const assistantMessage = {
        conversationId: conversation.id,
        role: "assistant",
        content: friendly,
        model,
        providerId: provider.id,
        status: "error",
        error: friendly,
        spoken: false,
        metadata: {
          source: "automatic-context",
          context,
        },
      } satisfies Omit<ChatMessage, "id" | "createdAt">;
      if (persistHistory) {
        this.database.addMessage(assistantMessage);
      }
      return { ok: false, error: friendly };
    }
  }

  private async requestChatCompletion(
    instance: PetInstance,
    provider: AiProvider,
    options: {
      userContent: string;
      systemAddendum?: string;
      context?: WindowsContext;
      effortOverride?: PetInstance["effort"];
      includeHistory?: boolean;
      maxTokens?: number;
      timeoutMs?: number;
    },
  ): Promise<string> {
    const baseUrl = provider.baseUrl.replace(/\/+$/, "");
    const settings = this.database.getGlobalSettings();
    if (!baseUrl) {
      throw new Error(translate(settings.locale, "error.configureBaseUrl"));
    }

    if (!provider.apiKey && !isLocalEndpoint(baseUrl)) {
      throw new Error(translate(settings.locale, "error.configureApiKey"));
    }

    const snapshot = this.database.getSnapshot();
    const windowsContext = options.context ?? (await this.windowsContextService.capture(snapshot.settings));
    const contextMessage = formatWindowsContextForPrompt(windowsContext, snapshot.settings.locale);
    const includeHistory = options.includeHistory !== false && snapshot.settings.chatHistoryEnabled;
    const recentMessages =
      !includeHistory
        ? []
        : snapshot.messages.slice(-16).map((message) => ({
            role: message.role === "assistant" || message.role === "user" ? message.role : "user",
            content: message.content,
          }));
    const lastMessage = snapshot.messages[snapshot.messages.length - 1];
    const shouldAppendUser =
      !includeHistory ||
      !lastMessage ||
      lastMessage.role !== "user" ||
      lastMessage.content !== options.userContent;

    const payload: Record<string, unknown> = {
      model: instance.model || provider.model,
      messages: [
        {
          role: "system",
          content: [instance.systemPrompt || instance.persona, contextMessage, options.systemAddendum]
            .filter(Boolean)
            .join("\n\n"),
        },
        ...recentMessages,
        ...(shouldAppendUser
          ? [
              {
                role: "user",
                content: options.userContent,
              },
            ]
          : []),
      ],
      temperature: provider.temperature,
      stream: false,
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
    };

    const effort = options.effortOverride || instance.effort || provider.defaultEffort;
    if (provider.supportsReasoning) {
      payload.reasoning = provider.supportsEffort ? { effort } : {};
    } else if (provider.supportsEffort) {
      payload.reasoning_effort = effort;
    }

    this.activeController = new AbortController();
    const timeoutMs = options.timeoutMs ?? 90_000;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      this.activeController?.abort();
    }, timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}`, "x-bf-vk": provider.apiKey } : {}),
        },
        body: JSON.stringify(payload),
        signal: this.activeController.signal,
      });
    } catch (error) {
      if (timedOut) {
        throw new Error(translate(settings.locale, "error.timeout", { seconds: Math.round(timeoutMs / 1000) }));
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      this.activeController = null;
    }

    const text = await response.text();
    let data: ChatCompletionResponse | null = null;
    try {
      data = text ? (JSON.parse(text) as ChatCompletionResponse) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const detail = data?.error?.message || text.slice(0, 500) || response.statusText;
      throw new Error(`API ${response.status}: ${detail}`);
    }

    const message = normalizeAssistantContent(data?.choices?.[0]?.message?.content ?? data?.output_text);
    if (!message) {
      throw new Error(translate(settings.locale, "error.emptyProviderMessage"));
    }

    return message.trim();
  }
}

function isLocalEndpoint(baseUrl: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?/i.test(baseUrl);
}

function formatProviderError(error: unknown, locale: LocaleCode): string {
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return translate(locale, "error.interrupted");
    }
    return error.message;
  }
  return translate(locale, "error.providerFallback");
}

function createTransientMessage(input: Omit<ChatMessage, "id" | "createdAt">): ChatMessage {
  return {
    ...input,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };
}

function normalizeAssistantContent(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    const text = value
      .map((part) => normalizeAssistantContent(part))
      .filter((part): part is string => Boolean(part))
      .join("");
    return text || null;
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return (
      normalizeAssistantContent(record.text) ??
      normalizeAssistantContent(record.content) ??
      normalizeAssistantContent(record.value)
    );
  }

  return null;
}

function isSilentResponse(text: string): boolean {
  return text.trim().toLowerCase().replace(/[.。!¡?¿"']/g, "") === "[silent]";
}
