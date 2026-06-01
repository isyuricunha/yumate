import { type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { Bot, Check, FolderPlus, Keyboard, Plus, RefreshCw, Settings2, Volume2, X } from "lucide-react";
import {
  type AiProvider,
  type AppSnapshot,
  type EffortLevel,
  type GlobalSettings,
  type PetInstance,
  type TtsSettings,
} from "../../shared/types";

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
    setNotice("Salvo.");
    window.setTimeout(() => setNotice(null), 1800);
  }

  async function importPet() {
    const result = await window.yumate.importPet();
    setNotice(result.ok ? "Pet importado." : result.error ?? "Importacao cancelada.");
  }

  async function createInstance() {
    await window.yumate.createInstance(snapshot.activeInstance.petPackId);
    setNotice("Instancia criada.");
  }

  async function refreshContext() {
    const context = await window.yumate.getWindowsContext();
    setNotice(context.error ?? "Contexto atualizado.");
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
          <strong>Configuracoes</strong>
          <span>{notice ?? snapshot.activePetPack.displayName}</span>
        </div>
        <button title="Close" type="button" onClick={onClose}>
          <X size={18} />
        </button>
      </header>

      <div className="tabs">
        <button className={tab === "ai" ? "active" : ""} title="AI" type="button" onClick={() => setTab("ai")}>
          <Bot size={17} />
        </button>
        <button className={tab === "tts" ? "active" : ""} title="TTS" type="button" onClick={() => setTab("tts")}>
          <Volume2 size={17} />
        </button>
        <button className={tab === "pet" ? "active" : ""} title="Pet" type="button" onClick={() => setTab("pet")}>
          <Settings2 size={17} />
        </button>
        <button className={tab === "privacy" ? "active" : ""} title="Privacy" type="button" onClick={() => setTab("privacy")}>
          <Check size={17} />
        </button>
        <button className={tab === "hotkeys" ? "active" : ""} title="Hotkeys" type="button" onClick={() => setTab("hotkeys")}>
          <Keyboard size={17} />
        </button>
      </div>

      <div className="settings-content">
        {tab === "ai" && (
          <fieldset>
            <label>
              <span>Provider</span>
              <input value={provider.name} onChange={(event) => setProvider({ ...provider, name: event.target.value })} />
            </label>
            <label>
              <span>Base URL</span>
              <input value={provider.baseUrl} onChange={(event) => setProvider({ ...provider, baseUrl: event.target.value })} />
            </label>
            <label>
              <span>API key</span>
              <input
                type="password"
                value={provider.apiKey}
                onChange={(event) => setProvider({ ...provider, apiKey: event.target.value })}
              />
            </label>
            <label>
              <span>Model</span>
              <input value={provider.model} onChange={(event) => setProvider({ ...provider, model: event.target.value })} />
            </label>
            <div className="grid-two">
              <label>
                <span>Effort</span>
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
                <span>Temperature</span>
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
              <span>Reasoning</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={provider.supportsEffort}
                onChange={(event) => setProvider({ ...provider, supportsEffort: event.target.checked })}
              />
              <span>Effort parameter</span>
            </label>
          </fieldset>
        )}

        {tab === "tts" && (
          <fieldset>
            <label>
              <span>Voice</span>
              <input value={tts.voice} onChange={(event) => setTts({ ...tts, voice: event.target.value })} />
            </label>
            <div className="grid-two">
              <label>
                <span>Rate</span>
                <input value={tts.rate} onChange={(event) => setTts({ ...tts, rate: event.target.value })} />
              </label>
              <label>
                <span>Pitch</span>
                <input value={tts.pitch} onChange={(event) => setTts({ ...tts, pitch: event.target.value })} />
              </label>
            </div>
            <label>
              <span>Volume</span>
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
              <span>Mute</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={instance.ttsEnabled}
                onChange={(event) => setInstance({ ...instance, ttsEnabled: event.target.checked })}
              />
              <span>TTS per instance</span>
            </label>
          </fieldset>
        )}

        {tab === "pet" && (
          <fieldset>
            <label>
              <span>Name</span>
              <input value={instance.name} onChange={(event) => setInstance({ ...instance, name: event.target.value })} />
            </label>
            <label>
              <span>Scale</span>
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
              <span>Persona</span>
              <textarea value={instance.persona} onChange={(event) => setInstance({ ...instance, persona: event.target.value })} rows={3} />
            </label>
            <label>
              <span>System prompt</span>
              <textarea
                value={instance.systemPrompt}
                onChange={(event) => setInstance({ ...instance, systemPrompt: event.target.value })}
                rows={5}
              />
            </label>
            <label>
              <span>Model override</span>
              <input
                placeholder={provider.model}
                value={instance.model ?? ""}
                onChange={(event) => setInstance({ ...instance, model: event.target.value.trim() || null })}
              />
            </label>
            <label>
              <span>Voice override</span>
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
              <span>Automatic movement</span>
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
              <span>Instance</span>
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
                  <small>{pack.valid ? "valid" : "invalid"}</small>
                </button>
              ))}
            </div>
            {validationIssues.length > 0 && <p className="inline-error">{validationIssues.join(" ")}</p>}
            <button className="wide-command" type="button" onClick={importPet}>
              <FolderPlus size={17} />
              <span>Import</span>
            </button>
          </fieldset>
        )}

        {tab === "privacy" && (
          <fieldset>
            <label className="check-row">
              <input
                type="checkbox"
                checked={global.startWithWindows}
                onChange={(event) => setGlobal({ ...global, startWithWindows: event.target.checked })}
              />
              <span>Start with Windows</span>
            </label>
            <label>
              <span>Tray behavior</span>
              <select
                value={global.trayBehavior}
                onChange={(event) =>
                  setGlobal({ ...global, trayBehavior: event.target.value as GlobalSettings["trayBehavior"] })
                }
              >
                <option value="minimize-to-tray">Minimize to tray</option>
                <option value="quit">Quit on close</option>
              </select>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={global.clickThroughEnabled}
                onChange={(event) => setGlobal({ ...global, clickThroughEnabled: event.target.checked })}
              />
              <span>Click-through</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={global.windowsContextEnabled}
                onChange={(event) => setGlobal({ ...global, windowsContextEnabled: event.target.checked })}
              />
              <span>Windows context</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={global.activeWindowTitleEnabled}
                onChange={(event) => setGlobal({ ...global, activeWindowTitleEnabled: event.target.checked })}
              />
              <span>Active window title</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={global.chatHistoryEnabled}
                onChange={(event) => setGlobal({ ...global, chatHistoryEnabled: event.target.checked })}
              />
              <span>Chat history</span>
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={global.automaticAiCallsEnabled}
                onChange={(event) => setGlobal({ ...global, automaticAiCallsEnabled: event.target.checked })}
              />
              <span>Automatic AI calls</span>
            </label>
            <div className="context-status">
              <span>{snapshot.windowsContext.enabled ? "Context enabled" : "Context disabled"}</span>
              <small>
                {snapshot.windowsContext.error ??
                  snapshot.windowsContext.activeProcessName ??
                  "No active window context captured."}
              </small>
            </div>
            <button className="wide-command" type="button" onClick={refreshContext}>
              <RefreshCw size={17} />
              <span>Refresh context</span>
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
          <span>{saving ? "Saving" : "Save"}</span>
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
