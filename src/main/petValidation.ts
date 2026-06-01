import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  behaviorStates,
  type BehaviorState,
  type DesktopPetMetadata,
  type PetJson,
  type PetValidationIssue,
  type PetValidationResult,
} from "../shared/types";
import { assertSafeRelativePath, sanitizePetId } from "./fileSafety";

const behaviorStateSet = new Set<BehaviorState>(behaviorStates);

const animationSchema = z.object({
  row: z.number().int().min(0),
  frames: z.number().int().positive(),
  fps: z.number().positive(),
  loop: z.boolean().optional(),
  startFrame: z.number().int().min(0).optional(),
  returnState: z.enum(behaviorStates as [BehaviorState, ...BehaviorState[]]).optional(),
});

const desktopPetSchema = z.object({
  schemaVersion: z.number().int().positive(),
  frameWidth: z.number().int().positive(),
  frameHeight: z.number().int().positive(),
  columns: z.number().int().positive(),
  rows: z.number().int().positive(),
  animations: z.record(animationSchema),
  stateMap: z.record(z.string()).default({}),
});

const petJsonSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().default(""),
  spritesheetPath: z.string().min(1),
  desktopPet: desktopPetSchema.optional(),
});

export function parsePetJson(raw: unknown): PetJson {
  const parsed = petJsonSchema.parse(raw);
  return {
    ...parsed,
    id: sanitizePetId(parsed.id),
    desktopPet: parsed.desktopPet as DesktopPetMetadata | undefined,
  };
}

export function validatePetJson(raw: unknown, baseDirectory?: string): { pet: PetJson | null; validation: PetValidationResult } {
  const issues: PetValidationIssue[] = [];
  const warnings: PetValidationIssue[] = [];
  let pet: PetJson | null = null;

  try {
    pet = parsePetJson(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid pet.json";
    issues.push({ code: "invalid-pet-json", message });
    return { pet: null, validation: { valid: false, issues, warnings } };
  }

  if (!pet.id) {
    issues.push({ code: "missing-id", message: "pet.json must include a non-empty id.", path: "id" });
  }

  if (!pet.displayName) {
    issues.push({
      code: "missing-display-name",
      message: "pet.json must include a displayName.",
      path: "displayName",
    });
  }

  try {
    assertSafeRelativePath(pet.spritesheetPath);
  } catch (error) {
    issues.push({
      code: "unsafe-spritesheet-path",
      message: error instanceof Error ? error.message : "spritesheetPath is unsafe.",
      path: "spritesheetPath",
    });
  }

  if (baseDirectory && issues.length === 0) {
    const spritesheetPath = path.resolve(baseDirectory, pet.spritesheetPath);
    if (!fs.existsSync(spritesheetPath)) {
      issues.push({
        code: "spritesheet-not-found",
        message: `Spritesheet was not found at ${pet.spritesheetPath}.`,
        path: "spritesheetPath",
      });
    }
  }

  if (!pet.desktopPet) {
    warnings.push({
      code: "desktop-pet-metadata-missing",
      message: "desktopPet metadata is missing. The pet is Codex/Open Pet compatible but needs controlled fallbacks.",
      path: "desktopPet",
    });
  } else {
    validateDesktopPetMetadata(pet.desktopPet, issues);
  }

  return {
    pet,
    validation: {
      valid: issues.length === 0,
      issues,
      warnings,
    },
  };
}

export function validateDesktopPetMetadata(metadata: DesktopPetMetadata, issues: PetValidationIssue[]): void {
  const animationNames = new Set(Object.keys(metadata.animations));

  for (const [name, animation] of Object.entries(metadata.animations)) {
    if (animation.row >= metadata.rows) {
      issues.push({
        code: "animation-row-out-of-range",
        message: `Animation "${name}" uses row ${animation.row}, but rows is ${metadata.rows}.`,
        path: `desktopPet.animations.${name}.row`,
      });
    }

    const startFrame = animation.startFrame ?? 0;
    if (startFrame + animation.frames > metadata.columns) {
      issues.push({
        code: "animation-frame-count-out-of-range",
        message: `Animation "${name}" exceeds the spritesheet columns.`,
        path: `desktopPet.animations.${name}.frames`,
      });
    }
  }

  for (const [state, animationName] of Object.entries(metadata.stateMap)) {
    if (!behaviorStateSet.has(state as BehaviorState)) {
      issues.push({
        code: "unknown-behavior-state",
        message: `State "${state}" is not supported by the app.`,
        path: `desktopPet.stateMap.${state}`,
      });
    }

    if (!animationNames.has(animationName)) {
      issues.push({
        code: "missing-state-animation",
        message: `State "${state}" points to missing animation "${animationName}".`,
        path: `desktopPet.stateMap.${state}`,
      });
    }
  }

  if (!metadata.animations.idle) {
    issues.push({
      code: "idle-animation-missing",
      message: "desktopPet.animations must include an idle animation.",
      path: "desktopPet.animations.idle",
    });
  }
}

export function resolveAnimationName(metadata: DesktopPetMetadata | null, state: BehaviorState): string {
  if (!metadata) {
    return "idle";
  }

  const mapped = metadata.stateMap[state];
  if (mapped && metadata.animations[mapped]) {
    return mapped;
  }

  if ((state === "walking-left" || state === "walking-right") && metadata.animations.running) {
    return "running";
  }

  if (metadata.animations.idle) {
    return "idle";
  }

  return Object.keys(metadata.animations)[0] ?? "idle";
}
