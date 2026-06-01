import path from "node:path";

export function sanitizePetId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function assertSafeRelativePath(relativePath: string): string {
  const normalized = path.normalize(relativePath).replace(/\\/g, "/");

  if (!normalized || normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }

  if (path.isAbsolute(normalized)) {
    throw new Error(`Absolute paths are not allowed in pet packs: ${relativePath}`);
  }

  return normalized;
}

export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function resolveInside(parent: string, relativePath: string): string {
  const safe = assertSafeRelativePath(relativePath);
  const resolved = path.resolve(parent, safe);

  if (!isPathInside(parent, resolved) && path.resolve(parent) !== resolved) {
    throw new Error(`Resolved path escapes parent folder: ${relativePath}`);
  }

  return resolved;
}
