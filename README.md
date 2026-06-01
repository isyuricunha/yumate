# Yumate

Yumate is a Windows-first Electron desktop AI pet. It renders transparent animated pet packs, chats with OpenAI-compatible providers, speaks through EdgeTTS-capable speech flows, and persists settings, instances, pets, and history in SQLite.

## Development

```powershell
pnpm install
pnpm generate:assets
pnpm dev
```

TTS uses the Microsoft EdgeTTS service through the Python `edge_tts` module when speech is enabled:

```powershell
python -m pip install edge-tts
```

## Validation

```powershell
pnpm typecheck
pnpm build
```

## Pet Packs

Runtime pet packs live in the app data directory under `pets/<pet-id>/`. A pack requires `pet.json` and the spritesheet referenced by `spritesheetPath`. Extra QA files are ignored by the runtime.
