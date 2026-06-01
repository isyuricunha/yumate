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

Sprite packs can add `desktopPet` metadata for controlled frame animation. Simple VTuber-style 2D packs can add `twoD` metadata and point `imagePath` at a transparent PNG/WebP avatar:

```json
{
  "id": "my-2d-pet",
  "displayName": "My 2D Pet",
  "description": "Single-image 2D pet with idle motion.",
  "spritesheetPath": "avatar.webp",
  "twoD": {
    "schemaVersion": 1,
    "imagePath": "avatar.webp",
    "idleMotion": { "bobPixels": 6, "bobSeconds": 2.8, "breatheScale": 0.025, "swayDegrees": 1.2 },
    "speakingMotion": { "bobPixels": 5, "bobSeconds": 1.2, "breatheScale": 0.04, "swayDegrees": 0.8 }
  }
}
```
