import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { dialog, type BrowserWindow } from "electron";
import { type AppDatabase } from "./database";
import { assertSafeRelativePath, resolveInside, sanitizePetId } from "./fileSafety";
import { validatePetJson } from "./petValidation";
import { type ImportPetResult, type InstalledPetPack, type PetJson } from "../shared/types";
import { translate } from "../shared/i18n";

interface PreparedPetDestination {
  id: string;
  displayName: string;
  destination: string;
}

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
    const locale = this.database.getGlobalSettings().locale;
    const result = await dialog.showOpenDialog(parent, {
      title: translate(locale, "petImport.title"),
      properties: ["openFile", "openDirectory"],
      filters: [
        { name: translate(locale, "petImport.filterPetPack"), extensions: ["zip", "json"] },
        { name: translate(locale, "petImport.filterAllFiles"), extensions: ["*"] },
      ],
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, error: translate(locale, "petImport.canceled") };
    }

    try {
      return await this.importFromPath(result.filePaths[0], parent);
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : translate(locale, "petImport.failed") };
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

    throw new Error(translate(this.database.getGlobalSettings().locale, "petImport.selectValid"));
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
      throw new Error(translate(this.database.getGlobalSettings().locale, "petImport.noPetJson"));
    }

    const sourceDirectory = path.dirname(petJsonPath);
    const raw = JSON.parse(fs.readFileSync(petJsonPath, "utf8")) as unknown;
    const { pet, validation } = validatePetJson(raw, sourceDirectory);
    if (!pet || !validation.valid) {
      throw new Error(formatValidationError(validation.issues));
    }

    const prepared = await this.prepareDestination(pet, parent);
    const { destination } = prepared;
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(destination, { recursive: true });

    writeInstalledPetJson(path.join(destination, "pet.json"), raw, prepared);
    for (const safeAssetPath of collectPetAssetPaths(pet)) {
      const sourceAsset = resolveInside(sourceDirectory, safeAssetPath);
      const destinationAsset = path.join(destination, safeAssetPath);
      fs.mkdirSync(path.dirname(destinationAsset), { recursive: true });
      fs.copyFileSync(sourceAsset, destinationAsset);
    }

    return this.registerPetDirectory(destination);
  }

  private async importFromZip(inputPath: string, parent?: BrowserWindow): Promise<InstalledPetPack> {
    const zip = new AdmZip(inputPath);
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
    const petEntry = entries.find((entry) => path.basename(entry.entryName).toLowerCase() === "pet.json");
    if (!petEntry) {
      throw new Error(translate(this.database.getGlobalSettings().locale, "petImport.zipNoPetJson"));
    }

    const raw = JSON.parse(petEntry.getData().toString("utf8")) as unknown;
    const { pet, validation } = validatePetJson(raw);
    if (!pet || !validation.valid) {
      throw new Error(formatValidationError(validation.issues));
    }

    const petJsonDirectory = path.posix.dirname(petEntry.entryName.replace(/\\/g, "/"));
    const prepared = await this.prepareDestination(pet, parent);
    const { destination } = prepared;
    fs.rmSync(destination, { recursive: true, force: true });
    writeInstalledPetJson(path.join(destination, "pet.json"), raw, prepared);

    const zipEntriesByName = new Map(entries.map((entry) => [entry.entryName.replace(/\\/g, "/"), entry]));
    for (const safeAssetPath of collectPetAssetPaths(pet)) {
      const entryName =
        petJsonDirectory === "."
          ? safeAssetPath
          : `${petJsonDirectory}/${safeAssetPath}`.replace(/\\/g, "/");
      const assetEntry = zipEntriesByName.get(entryName);
      if (!assetEntry) {
        throw new Error(`The zip archive does not contain ${safeAssetPath}.`);
      }

      const destinationAsset = path.join(destination, safeAssetPath);
      fs.mkdirSync(path.dirname(destinationAsset), { recursive: true });
      fs.writeFileSync(destinationAsset, assetEntry.getData());
    }

    return this.registerPetDirectory(destination);
  }

  private async prepareDestination(pet: PetJson, parent?: BrowserWindow): Promise<PreparedPetDestination> {
    const locale = this.database.getGlobalSettings().locale;
    const id = sanitizePetId(pet.id);
    const displayName = pet.displayName.trim();
    const destination = path.join(this.petsDirectory, id);
    const installedPacks = this.database.getPetPacks();
    const idCollision = installedPacks.find((pack) => pack.id === id);
    const nameCollision = installedPacks.find(
      (pack) => pack.displayName.localeCompare(displayName, undefined, { sensitivity: "accent" }) === 0,
    );
    const replacementPack = idCollision ?? nameCollision;

    if (!fs.existsSync(destination) && !replacementPack) {
      return { id, displayName, destination };
    }

    if (!parent) {
      throw new Error(translate(locale, "petImport.duplicateMessage", { name: displayName }));
    }

    const answer = await dialog.showMessageBox(parent, {
      type: "warning",
      buttons: [
        translate(locale, "petImport.cancel"),
        translate(locale, "petImport.replace"),
        translate(locale, "petImport.generateName"),
      ],
      defaultId: 2,
      cancelId: 0,
      title: translate(locale, "petImport.duplicateTitle"),
      message: translate(locale, "petImport.duplicateMessage", { name: displayName }),
      detail: translate(locale, "petImport.duplicateDetail"),
    });

    if (answer.response === 0) {
      throw new Error(translate(locale, "petImport.duplicateCanceled"));
    }

    if (answer.response === 1) {
      const replacementId = replacementPack?.id ?? id;
      return {
        id: replacementId,
        displayName,
        destination: path.join(this.petsDirectory, replacementId),
      };
    }

    const uniqueIdentity = this.createUniquePetIdentity(id, displayName);
    return {
      ...uniqueIdentity,
      destination: path.join(this.petsDirectory, uniqueIdentity.id),
    };
  }

  private createUniquePetIdentity(baseId: string, baseDisplayName: string): Pick<PreparedPetDestination, "id" | "displayName"> {
    const installedPacks = this.database.getPetPacks();
    const usedIds = new Set(installedPacks.map((pack) => pack.id));
    const usedNames = new Set(installedPacks.map((pack) => normalizeDisplayName(pack.displayName)));

    if (fs.existsSync(this.petsDirectory)) {
      for (const entry of fs.readdirSync(this.petsDirectory, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          usedIds.add(entry.name);
        }
      }
    }

    for (let index = 2; index < 1000; index += 1) {
      const id = sanitizePetId(`${baseId}-${index}`);
      const displayName = `${baseDisplayName} (${index})`;
      const idAvailable = !usedIds.has(id) && !fs.existsSync(path.join(this.petsDirectory, id));
      const displayNameAvailable = !usedNames.has(normalizeDisplayName(displayName));
      if (idAvailable && displayNameAvailable) {
        return { id, displayName };
      }
    }

    throw new Error(translate(this.database.getGlobalSettings().locale, "petImport.uniqueNameFailed", { name: baseDisplayName }));
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
      twoD: pet?.twoD ?? null,
      twoDImagePath: pet?.twoD ? path.join(directoryPath, pet.twoD.imagePath ?? pet.spritesheetPath) : null,
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

function writeInstalledPetJson(destinationPath: string, raw: unknown, prepared: PreparedPetDestination): void {
  const petJson = {
    ...(raw as Record<string, unknown>),
    id: prepared.id,
    displayName: prepared.displayName,
  };

  fs.writeFileSync(destinationPath, `${JSON.stringify(petJson, null, 2)}\n`);
}

function collectPetAssetPaths(pet: PetJson): string[] {
  const assets = new Set<string>();
  assets.add(assertSafeRelativePath(pet.spritesheetPath));
  if (pet.twoD?.imagePath) {
    assets.add(assertSafeRelativePath(pet.twoD.imagePath));
  }
  return [...assets];
}

function normalizeDisplayName(value: string): string {
  return value.trim().toLocaleLowerCase();
}
