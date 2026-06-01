import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, FolderPlus, Keyboard, Plus, RefreshCw, Settings2, Volume2, X } from "lucide-react";
import {
  type AiProvider,
  type AppSnapshot,
  type EffortLevel,
  type GlobalSettings,
  type LocaleCode,
  type PetInstance,
  type TtsSettings,
} from "../../shared/types";
import { getDefaultPromptPreset, localeLabels, translate, type TranslationKey } from "../../shared/i18n";

interface SettingsPanelProps {
  snapshot: AppSnapshot;
  onClose: () => void;
}

type Tab = "ai" | "tts" | "pet" | "privacy" | "hotkeys";

export function SettingsPanel({ snapshot, onClose }: SettingsPanelProps) {
  const [tab, setTab] = useState<Tab>("ai");
  const [provider, setProvider] = useState<AiProvider>(snapshot.providers[0]);
  const [tts, setTts] = useState<TtsSettings>(snapshot.tts);
  const [instance, setInstance] = useState(snapshot.activeInstance);
  const [global, setGlobal] = useState<GlobalSettings>(snapshot.settings);
  const [hotkeys, setHotkeys] = useState(snapshot.hotkeys);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const locale = global.locale;
  const t = (key: TranslationKey) => translate(locale, key);

  const validationIssues = useMemo(
    () => snapshot.activePetPack.validation.issues.map((issue) => issue.message),
    [snapshot.activePetPack.validation.issues],
  );

  useEffect(() => {
    setProvider(snapshot.providers[0]);
    setTts(snapshot.tts);
    setInstance(snapshot.activeInstance);
    setGlobal(snapshot.settings);
    setHotkeys(snapshot.hotkeys);
  }, [snapshot]);

  async function save() {
    setSaving(true);
    await window.yumate.saveSettings({
      provider,
      tts,
      instance: toInstancePayload(instance),
      global,
      hotkeys,
    });
    setSaving(false);
    setNotice(t("settings.saved"));
    window.setTimeout(() => setNotice(null), 1800);
  }

  async function importPet() {
    const result = await window.yumate.importPet();
    setNotice(result.ok ? t("settings.petImported") : result.error ?? t("settings.importCanceled"));
  }

  async function createInstance() {
    await window.yumate.createInstance(snapshot.activeInstance.petPackId);
    setNotice(t("settings.instanceCreated"));
  }

  async function refreshContext() {
    const context = await window.yumate.getWindowsContext();
    setNotice(context.error ?? t("settings.contextRefreshed"));
  }

  function resetPromptForLocale() {
    const preset = getDefaultPromptPreset(locale);
    setInstance({
      ...instance,
      persona: preset.persona,
      systemPrompt: preset.systemPrompt,
    });
  }

  function startPanelDrag(event: PointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement | null)?.closest("button, input, textarea, select")) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { x: event.screenX, y: event.screenY };
  }

  function movePanel(event: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }

    const delta = { x: event.screenX - drag.x, y: event.screenY - drag.y };
    dragRef.current = { x: event.screenX, y: event.screenY };
    if (delta.x !== 0 || delta.y !== 0) {
      void window.yumate.moveWindowBy(delta);
    }
  }

  function endPanelDrag(event: PointerEvent<HTMLElement>) {
    if (!dragRef.current) {
      return;
    }

    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // Pointer capture may already be gone after cancellation.
    }
    void window.yumate.saveWindowPosition();
  }

  return (
    <section className="panel settings-panel" data-interactive="true">
      <header
        className="panel-header"
        onPointerCancel={endPanelDrag}
        onPointerDown={startPanelDrag}
        onPointerMove={movePanel}
        onPointerUp={endPanelDrag}
      >
        <div>
          <strong>{t("settings.title")}</strong>
          <span>{notice ?? snapshot.activePetPack.displayName}</span>
        </div>
        <button title={t("settings.close")} type="button" onClick={onClose}>
          <X size={18} />
        </button>
      </header>

      <div className="tabs">
        <button className={tab === "ai" ? "active" : ""} title={t("settings.ai")} type="button" onClick={() => setTab("ai")}>
          <Bot size={17} />
        </button>
        <button className={tab === "tts" ? "active" : ""} title={t("settings.tts")} type="button" onClick={() => setTab("tts")}>
          <Volume2 size={17} />
        </button>
        <button className={tab === "pet" ? "active" : ""} title={t("settings.pet")} type="button" onClick={() => setTab("pet")}>
          <Settings2 size={17} />
        </button>
        <button className={tab === "privacy" ? "active" : ""} title={t("settings.privacy")} type="button" onClick={() => setTab("privacy")}>
          <Check size={17} />
        </button>
        <button className={tab === "hotkeys" ? "active" : ""} title={t("settings.hotkeys")} type="button" onClick={() => setTab("hotkeys")}>
          <Keyboard size={17} />
        </button>
      </div>

      <div className="settings-content">
        {tab === "ai" && (
          <fieldset>
            <label>
              <span>{t("settings.provider")}</span>
              <input value={provider.name} onChange={(event) => setProvider({ ...provider, name: event.target.value })} />
            </label>
            <label>
              <span>{t("settings.baseUrl")}</span>
              <input value={provider.baseUrl} onChange={(event) => setProvider({ ...provider, baseUrl: event.target.value })} />
            </label>
            <label>
              <span>{t("settings.apiKey")}</span>
              <input
                type="password"
                value={provider.apiKey}
                onChange={(event) => setProvider({ ...provider, apiKey: event.target.value })}
              />
            </label>
            <label>
              <span>{t("settings.model")}</span>
              <input value={provider.model} onChange={(event) => setProvider({ ...provider, model: event.target.value })} />
            </label>
            <div className="grid-two">
              <label>
                <span>{t("settings.effort")}</span>
                <select
                  value={instance.effort}
                  onChange={(event) => setInstance({ ...instance, effort: event.target.value as EffortLevel })}
                >
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </label>
              <label>
                <span>{t("settings.temperature")}</span>
                <input
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={provider.temperature}
                  onChange={(event) => setProvider({ ...provider, temperature: Number(event.target.value) })}
                />
              </label>
            </div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={provider.supportsReasoning}
                onChange={(event) => setProvider({ ...provider, supportsReasoning: event.target.checked })}
              />
              <span>{t("settings.reasoning")}</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={provider.supportsEffort}
                onChange={(event) => setProvider({ ...provider, supportsEffort: event.target.checked })}
              />
              <span>{t("settings.effortParameter")}</span>
            </label>
          </fieldset>
        )}

        {tab === "tts" && (
          <fieldset>
            <label>
              <span>{t("settings.voice")}</span>
              <input value={tts.voice} onChange={(event) => setTts({ ...tts, voice: event.target.value })} />
            </label>
            <div className="grid-two">
              <label>
                <span>{t("settings.rate")}</span>
                <input value={tts.rate} onChange={(event) => setTts({ ...tts, rate: event.target.value })} />
              </label>
              <label>
                <span>{t("settings.pitch")}</span>
                <input value={tts.pitch} onChange={(event) => setTts({ ...tts, pitch: event.target.value })} />
              </label>
            </div>
            <label>
              <span>{t("settings.volume")}</span>
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={tts.volume}
                onChange={(event) => setTts({ ...tts, volume: Number(event.target.value) })}
              />
            </label>
            <label className="check-row">
              <input type="checkbox" checked={tts.muted} onChange={(event) => setTts({ ...tts, muted: event.target.checked })} />
              <span>{t("settings.mute")}</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={instance.ttsEnabled}
                onChange={(event) => setInstance({ ...instance, ttsEnabled: event.target.checked })}
              />
              <span>{t("settings.ttsPerInstance")}</span>
            </label>
          </fieldset>
        )}

        {tab === "pet" && (
          <fieldset>
            <label>
              <span>{t("settings.name")}</span>
              <input value={instance.name} onChange={(event) => setInstance({ ...instance, name: event.target.value })} />
            </label>
            <label>
              <span>{t("settings.scale")}</span>
              <input
                type="range"
                min="0.5"
                max="2"
                step="0.05"
                value={instance.scale}
                onChange={(event) => setInstance({ ...instance, scale: Number(event.target.value) })}
              />
            </label>
            <label>
              <span>{t("settings.persona")}</span>
              <textarea value={instance.persona} onChange={(event) => setInstance({ ...instance, persona: event.target.value })} rows={3} />
            </label>
            <label>
              <span>{t("settings.systemPrompt")}</span>
              <textarea
                value={instance.systemPrompt}
                onChange={(event) => setInstance({ ...instance, systemPrompt: event.target.value })}
                rows={5}
              />
            </label>
            <button className="wide-command" type="button" onClick={resetPromptForLocale}>
              <RefreshCw size={17} />
              <span>{t("settings.resetPrompt")}</span>
            </button>
            <label>
              <span>{t("settings.modelOverride")}</span>
              <input
                placeholder={provider.model}
                value={instance.model ?? ""}
                onChange={(event) => setInstance({ ...instance, model: event.target.value.trim() || null })}
              />
            </label>
            <label>
              <span>{t("settings.voiceOverride")}</span>
              <input
                placeholder={tts.voice}
                value={instance.voice ?? ""}
                onChange={(event) => setInstance({ ...instance, voice: event.target.value.trim() || null })}
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={instance.movementEnabled}
                onChange={(event) => setInstance({ ...instance, movementEnabled: event.target.checked })}
              />
              <span>{t("settings.automaticMovement")}</span>
            </label>
            <div className="pet-list">
              {snapshot.instances.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === snapshot.activeInstance.id ? "selected" : ""}
                  onClick={() => window.yumate.selectInstance(item.id)}
                >
                  <span>{item.name}</span>
                  <small>{item.petPackId}</small>
                </button>
              ))}
            </div>
            <button className="wide-command" type="button" onClick={createInstance}>
              <Plus size={17} />
              <span>{t("settings.instance")}</span>
            </button>
            <div className="pet-list">
              {snapshot.petPacks.map((pack) => (
                <button
                  key={pack.id}
                  type="button"
                  className={pack.id === snapshot.activeInstance.petPackId ? "selected" : ""}
                  disabled={!pack.valid}
                  onClick={() => window.yumate.selectPet(pack.id)}
                >
                  <span>{pack.displayName}</span>
                  <small>{pack.valid ? t("settings.valid") : t("settings.invalid")}</small>
                </button>
              ))}
            </div>
            {validationIssues.length > 0 && <p className="inline-error">{validationIssues.join(" ")}</p>}
            <button className="wide-command" type="button" onClick={importPet}>
              <FolderPlus size={17} />
              <span>{t("settings.import")}</span>
            </button>
          </fieldset>
        )}

        {tab === "privacy" && (
          <fieldset>
            <label>
              <span>{t("settings.language")}</span>
              <select
                value={global.locale}
                onChange={(event) => setGlobal({ ...global, locale: event.target.value as LocaleCode })}
              >
                {(Object.entries(localeLabels) as Array<[LocaleCode, string]>).map(([code, label]) => (
                  <option key={code} value={code}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={global.startWithWindows}
                onChange={(event) => setGlobal({ ...global, startWithWindows: event.target.checked })}
              />
              <span>{t("settings.startWithWindows")}</span>
            </label>
            <label>
              <span>{t("settings.trayBehavior")}</span>
              <select
                value={global.trayBehavior}
                onChange={(event) =>
                  setGlobal({ ...global, trayBehavior: event.target.value as GlobalSettings["trayBehavior"] })
                }
              >
                <option value="minimize-to-tray">{t("settings.minimizeToTray")}</option>
                <option value="quit">{t("settings.quitOnClose")}</option>
              </select>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={global.clickThroughEnabled}
                onChange={(event) => setGlobal({ ...global, clickThroughEnabled: event.target.checked })}
              />
              <span>{t("settings.clickThrough")}</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={global.windowsContextEnabled}
                onChange={(event) => setGlobal({ ...global, windowsContextEnabled: event.target.checked })}
              />
              <span>{t("settings.windowsContext")}</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={global.activeWindowTitleEnabled}
                onChange={(event) => setGlobal({ ...global, activeWindowTitleEnabled: event.target.checked })}
              />
              <span>{t("settings.activeWindowTitle")}</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={global.chatHistoryEnabled}
                onChange={(event) => setGlobal({ ...global, chatHistoryEnabled: event.target.checked })}
              />
              <span>{t("settings.chatHistory")}</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={global.automaticAiCallsEnabled}
                onChange={(event) => setGlobal({ ...global, automaticAiCallsEnabled: event.target.checked })}
              />
              <span>{t("settings.automaticAiCalls")}</span>
            </label>
            <div className="context-status">
              <span>{snapshot.windowsContext.enabled ? t("settings.contextEnabled") : t("settings.contextDisabled")}</span>
              <small>
                {snapshot.windowsContext.error ??
                  snapshot.windowsContext.activeProcessName ??
                  t("settings.noContext")}
              </small>
            </div>
            <button className="wide-command" type="button" onClick={refreshContext}>
              <RefreshCw size={17} />
              <span>{t("settings.refreshContext")}</span>
            </button>
          </fieldset>
        )}

        {tab === "hotkeys" && (
          <fieldset>
            {hotkeys.map((hotkey) => (
              <div className="hotkey-row" key={hotkey.action}>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={hotkey.enabled}
                    onChange={(event) =>
                      setHotkeys((items) =>
                        items.map((item) =>
                          item.action === hotkey.action ? { ...item, enabled: event.target.checked } : item,
                        ),
                      )
                    }
                  />
                  <span>{hotkey.action}</span>
                </label>
                <input
                  value={hotkey.accelerator}
                  onChange={(event) =>
                    setHotkeys((items) =>
                      items.map((item) =>
                        item.action === hotkey.action ? { ...item, accelerator: event.target.value } : item,
                      ),
                    )
                  }
                />
              </div>
            ))}
          </fieldset>
        )}
      </div>

      <footer className="panel-footer">
        <button type="button" disabled={saving} onClick={save}>
          <Check size={17} />
          <span>{saving ? t("settings.saving") : t("settings.save")}</span>
        </button>
      </footer>
    </section>
  );
}

function toInstancePayload(instance: PetInstance) {
  return {
    id: instance.id,
    name: instance.name,
    scale: instance.scale,
    persona: instance.persona,
    systemPrompt: instance.systemPrompt,
    voice: instance.voice,
    model: instance.model,
    providerId: instance.providerId,
    effort: instance.effort,
    ttsEnabled: instance.ttsEnabled,
    movementEnabled: instance.movementEnabled,
  };
}
