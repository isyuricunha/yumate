import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { dialog, type BrowserWindow } from "electron";
import { type AppDatabase } from "./database";
import { assertSafeRelativePath, resolveInside, sanitizePetId } from "./fileSafety";
import { validatePetJson } from "./petValidation";
import { type ImportPetResult, type InstalledPetPack, type PetJson } from "../shared/types";

export class PetPackService {
  constructor(
    private readonly database: AppDatabase,
    private readonly petsDirectory: string,
    private readonly defaultPetsDirectory: string,
  ) {}

  async initialize(): Promise<InstalledPetPack[]> {
    fs.mkdirSync(this.petsDirectory, { recursive: true });
    await this.installBundledPets();
    return this.scanAndRegisterPets();
  }

  async importWithDialog(parent: BrowserWindow): Promise<ImportPetResult> {
    const result = await dialog.showOpenDialog(parent, {
      title: "Import pet",
      properties: ["openFile", "openDirectory"],
      filters: [
        { name: "Pet pack", extensions: ["zip", "json"] },
        { name: "All files", extensions: ["*"] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: "Import canceled." };
    }

    try {
      return await this.importFromPath(result.filePaths[0], parent);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Pet import failed." };
    }
  }

  async importFromPath(inputPath: string, parent?: BrowserWindow): Promise<ImportPetResult> {
    const stat = fs.statSync(inputPath);

    if (stat.isDirectory()) {
      const pack = await this.importFromDirectory(inputPath, parent);
      return { ok: true, pack };
    }

    if (path.extname(inputPath).toLowerCase() === ".zip") {
      const pack = await this.importFromZip(inputPath, parent);
      return { ok: true, pack };
    }

    if (path.basename(inputPath).toLowerCase() === "pet.json") {
      const pack = await this.importFromDirectory(path.dirname(inputPath), parent);
      return { ok: true, pack };
    }

    throw new Error("Select a pet folder, a pet.json file, or a .zip archive.");
  }

  scanAndRegisterPets(): InstalledPetPack[] {
    const packs: InstalledPetPack[] = [];
    const entries = fs.existsSync(this.petsDirectory)
      ? fs.readdirSync(this.petsDirectory, { withFileTypes: true })
      : [];

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const directoryPath = path.join(this.petsDirectory, entry.name);
      const petJsonPath = path.join(directoryPath, "pet.json");
      if (!fs.existsSync(petJsonPath)) {
        continue;
      }

      packs.push(this.registerPetDirectory(directoryPath));
    }

    return packs;
  }

  private async installBundledPets(): Promise<void> {
    if (!fs.existsSync(this.defaultPetsDirectory)) {
      return;
    }

    const entries = fs.readdirSync(this.defaultPetsDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      const source = path.join(this.defaultPetsDirectory, entry.name);
      const petJsonPath = path.join(source, "pet.json");
      if (!fs.existsSync(petJsonPath)) {
        continue;
      }

      const raw = JSON.parse(fs.readFileSync(petJsonPath, "utf8")) as PetJson;
      const id = sanitizePetId(raw.id || entry.name);
      const destination = path.join(this.petsDirectory, id);

      if (!fs.existsSync(destination)) {
        fs.cpSync(source, destination, { recursive: true });
      }
    }
  }

  private async importFromDirectory(inputDirectory: string, parent?: BrowserWindow): Promise<InstalledPetPack> {
    const petJsonPath = findPetJson(inputDirectory);
    if (!petJsonPath) {
      throw new Error("No pet.json was found in the selected folder.");
    }

    const sourceDirectory = path.dirname(petJsonPath);
    const raw = JSON.parse(fs.readFileSync(petJsonPath, "utf8")) as unknown;
    const { pet, validation } = validatePetJson(raw, sourceDirectory);
    if (!pet || !validation.valid) {
      throw new Error(formatValidationError(validation.issues));
    }

    const destination = await this.prepareDestination(pet.id, parent);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });

    const safeSpritesheetPath = assertSafeRelativePath(pet.spritesheetPath);
    const sourceSpritesheet = resolveInside(sourceDirectory, safeSpritesheetPath);
    const destinationSpritesheet = path.join(destination, safeSpritesheetPath);
    fs.mkdirSync(path.dirname(destinationSpritesheet), { recursive: true });
    fs.copyFileSync(petJsonPath, path.join(destination, "pet.json"));
    fs.copyFileSync(sourceSpritesheet, destinationSpritesheet);

    return this.registerPetDirectory(destination);
  }

  private async importFromZip(inputPath: string, parent?: BrowserWindow): Promise<InstalledPetPack> {
    const zip = new AdmZip(inputPath);
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
    const petEntry = entries.find((entry) => path.basename(entry.entryName).toLowerCase() === "pet.json");
    if (!petEntry) {
      throw new Error("The zip archive does not contain a pet.json file.");
    }

    const raw = JSON.parse(petEntry.getData().toString("utf8")) as unknown;
    const { pet, validation } = validatePetJson(raw);
    if (!pet || !validation.valid) {
      throw new Error(formatValidationError(validation.issues));
    }

    const petJsonDirectory = path.posix.dirname(petEntry.entryName.replace(/\\/g, "/"));
    const safeSpritesheetPath = assertSafeRelativePath(pet.spritesheetPath);
    const spritesheetEntryName =
      petJsonDirectory === "."
        ? safeSpritesheetPath
        : `${petJsonDirectory}/${safeSpritesheetPath}`.replace(/\\/g, "/");
    const spritesheetEntry = entries.find((entry) => entry.entryName.replace(/\\/g, "/") === spritesheetEntryName);

    if (!spritesheetEntry) {
      throw new Error(`The zip archive does not contain ${pet.spritesheetPath}.`);
    }

    const destination = await this.prepareDestination(pet.id, parent);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(path.join(destination, safeSpritesheetPath)), { recursive: true });
    fs.writeFileSync(path.join(destination, "pet.json"), petEntry.getData());
    fs.writeFileSync(path.join(destination, safeSpritesheetPath), spritesheetEntry.getData());

    return this.registerPetDirectory(destination);
  }

  private async prepareDestination(petId: string, parent?: BrowserWindow): Promise<string> {
    const id = sanitizePetId(petId);
    const destination = path.join(this.petsDirectory, id);

    if (!fs.existsSync(destination)) {
      return destination;
    }

    if (!parent) {
      throw new Error(`Pet "${id}" already exists.`);
    }

    const answer = await dialog.showMessageBox(parent, {
      type: "warning",
      buttons: ["Cancel", "Overwrite"],
      defaultId: 0,
      cancelId: 0,
      title: "Pet already installed",
      message: `The pet "${id}" is already installed.`,
      detail: "Yumate never overwrites pet packs silently.",
    });

    if (answer.response !== 1) {
      throw new Error("Import canceled because the pet already exists.");
    }

    return destination;
  }

  private registerPetDirectory(directoryPath: string): InstalledPetPack {
    const petJsonPath = path.join(directoryPath, "pet.json");
    const raw = JSON.parse(fs.readFileSync(petJsonPath, "utf8")) as unknown;
    const { pet, validation } = validatePetJson(raw, directoryPath);

    const id = pet?.id ?? sanitizePetId(path.basename(directoryPath));
    const spritesheetPath = pet ? path.join(directoryPath, pet.spritesheetPath) : path.join(directoryPath, "spritesheet.webp");
    const timestamp = new Date().toISOString();
    const pack: InstalledPetPack = {
      id,
      displayName: pet?.displayName ?? id,
      description: pet?.description ?? "",
      directoryPath,
      petJsonPath,
      spritesheetPath,
      metadata: pet?.desktopPet ?? null,
      valid: validation.valid,
      validation,
      installedAt: timestamp,
      updatedAt: timestamp,
    };

    this.database.registerPetPack(pack);
    return pack;
  }
}

function findPetJson(directory: string): string | null {
  const direct = path.join(directory, "pet.json");
  if (fs.existsSync(direct)) {
    return direct;
  }

  const queue = [directory];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(fullPath);
      } else if (entry.name.toLowerCase() === "pet.json") {
        return fullPath;
      }
    }
  }

  return null;
}

function formatValidationError(issues: { message: string }[]): string {
  return issues.length > 0 ? issues.map((issue) => issue.message).join(" ") : "Invalid pet pack.";
}
