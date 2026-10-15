import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type DaemonNodeTokenSource = "explicit" | "file" | "generated";

export interface DaemonNodeTokenResolution {
  token: string;
  source: DaemonNodeTokenSource;
  path?: string;
}

export interface EnsureDaemonNodeTokenInput {
  credentialDirectory: string;
  /** Previous releases persisted the credential under the mounted workspace. */
  legacyWorkspacePath?: string;
  userId: string;
  token?: string;
}

export function daemonNodeTokenPath(credentialDirectory: string, userId: string): string {
  return join(credentialDirectory, `${safeTokenFileName(userId)}.token`);
}

export function readDaemonNodeToken(credentialDirectory: string, userId: string): string | undefined {
  const path = daemonNodeTokenPath(credentialDirectory, userId);
  try {
    const token = readFileSync(path, "utf8").trim();
    return token || undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function writeDaemonNodeToken(credentialDirectory: string, userId: string, token: string): string {
  const path = daemonNodeTokenPath(credentialDirectory, userId);
  mkdirSync(credentialDirectory, { recursive: true, mode: 0o700 });
  chmodSync(credentialDirectory, 0o700);
  writeFileSync(path, `${token.trim()}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

export function newDaemonNodeToken(): string {
  return `tok_${randomBytes(24).toString("base64url")}`;
}

export function ensureDaemonNodeToken(input: EnsureDaemonNodeTokenInput): DaemonNodeTokenResolution {
  const explicit = input.token?.trim();
  if (explicit) {
    writeDaemonNodeToken(input.credentialDirectory, input.userId, explicit);
    removeLegacyToken(input);
    return { token: explicit, source: "explicit" };
  }

  const path = daemonNodeTokenPath(input.credentialDirectory, input.userId);
  const existing = readDaemonNodeToken(input.credentialDirectory, input.userId);
  if (existing) {
    return { token: existing, source: "file", path };
  }

  const legacy = readLegacyToken(input);
  if (legacy) {
    writeDaemonNodeToken(input.credentialDirectory, input.userId, legacy);
    removeLegacyToken(input);
    return { token: legacy, source: "file", path };
  }

  const generated = newDaemonNodeToken();
  writeDaemonNodeToken(input.credentialDirectory, input.userId, generated);
  return { token: generated, source: "generated", path };
}

function legacyTokenPath(input: EnsureDaemonNodeTokenInput): string | undefined {
  return input.legacyWorkspacePath
    ? join(input.legacyWorkspacePath, ".relay", "daemon-nodes", `${safeTokenFileName(input.userId)}.token`)
    : undefined;
}

function readLegacyToken(input: EnsureDaemonNodeTokenInput): string | undefined {
  const path = legacyTokenPath(input);
  if (!path) return undefined;
  try {
    return readFileSync(path, "utf8").trim() || undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function removeLegacyToken(input: EnsureDaemonNodeTokenInput): void {
  const path = legacyTokenPath(input);
  if (!path) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

function safeTokenFileName(value: string): string {
  const safe = value.trim().replace(/[^A-Za-z0-9._-]/g, "_");
  return safe || "local";
}
