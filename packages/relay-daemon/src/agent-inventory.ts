import {
  AGENT_NAMES,
  isAgentName,
  shellQuote,
  type AgentName,
  type DaemonAgentInventory,
  type DaemonAgentMcpServer,
  type DaemonAgentSkill,
  type DaemonMcpTransport,
} from "relay-core";

// ── Agent inventory discovery ───────────────────────────────────────────────
// Enumerates what each agent CLI actually has installed inside the node — its
// SKILL.md skills and its configured MCP servers. The sweep runs through the
// daemon's execution environment, so it works identically in `boxlite` mode
// (inside the guest) and `none` mode (the daemon's own host home).
//
// Discovery is best-effort and never throws: a node that cannot be inspected
// simply reports no inventory rather than failing registration.

type ExecLike = (
  cmd: string,
  args?: string[],
  options?: { signal?: AbortSignal },
) => Promise<{ exit_code: number; stdout: string; stderr: string; error_message?: string }>;

interface AgentInventorySource {
  /** Home-relative directory holding `<skill>/SKILL.md` subdirectories. */
  readonly skillsDir?: string;
  /** Home-relative JSON files carrying an `mcpServers` map. */
  readonly mcpJson?: readonly string[];
  /** Home-relative Codex TOML files carrying `[mcp_servers.<name>]` tables. */
  readonly mcpToml?: readonly string[];
}

// Conservative, easily-extended per-agent source map. Each path follows the
// corresponding CLI's active home so installed skills and MCP servers surface.
export const AGENT_INVENTORY_SOURCES: Record<AgentName, AgentInventorySource> = {
  claude: { skillsDir: ".claude/skills", mcpJson: [".claude.json", ".mcp.json"] },
  codex: { skillsDir: ".codex/skills", mcpJson: [".codex/mcp.json"], mcpToml: [".codex/config.toml"] },
  pi: { skillsDir: ".pi/skills", mcpJson: [".pi/mcp.json"] },
  kimi: { skillsDir: ".kimi-code/skills", mcpJson: [".kimi-code/mcp.json"] },
};

const RECORD_SEPARATOR = "\t";
const DEFAULT_INVENTORY_TIMEOUT_MS = 10_000;

/**
 * Inspect the node and report each agent's installed skills and MCP servers.
 * Best-effort: returns an empty map (never throws) when the sweep fails.
 */
export async function discoverAgentInventory(
  execStream: ExecLike,
  signal?: AbortSignal,
  timeoutMs = DEFAULT_INVENTORY_TIMEOUT_MS,
): Promise<Partial<Record<AgentName, DaemonAgentInventory>>> {
  if (signal?.aborted) return {};
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const discoverySignal = signal
    ? AbortSignal.any([signal, timeoutSignal])
    : timeoutSignal;
  let result: Awaited<ReturnType<ExecLike>>;
  try {
    result = await execStream("bash", ["-c", buildInventoryScript()], { signal: discoverySignal });
  } catch {
    return {};
  }
  if (result.exit_code !== 0) return {};
  return parseInventoryOutput(result.stdout);
}

// Relative paths in AGENT_INVENTORY_SOURCES are trusted, safe constants; they
// are embedded directly so shell parameter expansion (e.g. ${f#$d/}) works.
const SAFE_REL_PATH = /^[A-Za-z0-9._/-]+$/;
const CONFIG_HOMES: Record<AgentName, string> = {
  claude: '${CLAUDE_CONFIG_DIR:-$home/.claude}',
  codex: '${CODEX_HOME:-$home/.codex}',
  pi: '${PI_CODING_AGENT_DIR:-$home/.pi}',
  kimi: '${KIMI_CODE_HOME:-$home/.kimi-code}',
};

function buildInventoryScript(): string {
  const lines = ["set -u", "sep=$(printf '\\t')", 'home="${HOME:-/home/agent}"'];
  for (const agent of AGENT_NAMES) {
    const source = AGENT_INVENTORY_SOURCES[agent];
    lines.push(`config_home="${CONFIG_HOMES[agent]}"`);
    if (source.skillsDir && SAFE_REL_PATH.test(source.skillsDir)) {
      lines.push(
        `d="$config_home/skills"`,
        `if [ -d "$d" ]; then`,
        `  find "$d" -maxdepth 4 -type f -name SKILL.md 2>/dev/null | while IFS= read -r f; do`,
        `    rel="\${f#$d/}"`,
        `    payload=$(base64 < "$f" | tr -d '\\n')`,
        `    printf 'SKILL%s%s%s%s%s%s\\n' "$sep" ${shellQuote(agent)} "$sep" "$rel" "$sep" "$payload"`,
        `  done`,
        `fi`,
      );
    }
    for (const rel of [...(source.mcpJson ?? []), ...(source.mcpToml ?? [])]) {
      if (!SAFE_REL_PATH.test(rel)) continue;
      // Claude's default global files live beside ~/.claude, while custom
      // homes hold them inside CLAUDE_CONFIG_DIR.
      const configPath = agent === "claude"
        ? `\${CLAUDE_CONFIG_DIR:-$home}/${rel}`
        : `$config_home/${rel.split("/").pop()}`;
      lines.push(
        `m="${configPath}"`,
        `if [ -f "$m" ]; then`,
        `  payload=$(base64 < "$m" | tr -d '\\n')`,
        `  printf 'MCP%s%s%s%s%s%s\\n' "$sep" ${shellQuote(agent)} "$sep" ${shellQuote(rel)} "$sep" "$payload"`,
        `fi`,
      );
    }
  }
  return lines.join("\n");
}

/** Parse the tab-delimited sweep output into a per-agent inventory map. */
export function parseInventoryOutput(stdout: string): Partial<Record<AgentName, DaemonAgentInventory>> {
  const inventory: Partial<Record<AgentName, DaemonAgentInventory>> = {};
  const ensure = (agent: AgentName): DaemonAgentInventory =>
    (inventory[agent] ??= { skills: [], mcpServers: [] });

  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const [kind, agent, id, payload] = line.split(RECORD_SEPARATOR);
    if (!isAgentName(agent) || !id || !payload) continue;
    let content: string;
    try {
      content = Buffer.from(payload, "base64").toString("utf8");
    } catch {
      continue;
    }
    if (kind === "SKILL") {
      const skill = parseSkill(id, content);
      if (skill) ensure(agent).skills.push(skill);
    } else if (kind === "MCP") {
      for (const server of parseMcpServers(id, content)) ensure(agent).mcpServers.push(server);
    }
  }

  for (const agent of AGENT_NAMES) {
    const entry = inventory[agent];
    if (entry) {
      entry.skills = dedupeSkills(entry.skills);
      entry.mcpServers = dedupeMcpServers(entry.mcpServers);
    }
  }
  return inventory;
}

/** Derive a skill from its `SKILL.md` relative path and YAML frontmatter. */
function parseSkill(relPath: string, content: string): DaemonAgentSkill | undefined {
  const segments = relPath.split("/").filter(Boolean);
  // Drop the trailing "SKILL.md"; what remains is [<namespace>?, <name>].
  const dirSegments = segments.slice(0, -1);
  if (dirSegments.length === 0) return undefined;
  const frontmatter = parseFrontmatter(content);
  const name = frontmatter.name?.trim() || dirSegments[dirSegments.length - 1];
  if (!name) return undefined;
  const namespace = dirSegments.length > 1 ? dirSegments[0] : undefined;
  const description = frontmatter.description?.trim();
  return {
    name,
    ...(namespace ? { namespace } : {}),
    ...(description ? { description } : {}),
  };
}

/** Minimal YAML frontmatter reader for the keys we surface (name, description). */
function parseFrontmatter(content: string): { name?: string; description?: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
  const result: { name?: string; description?: string } = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const kv = /^(name|description)\s*:\s*(.*)$/.exec(raw);
    if (!kv) continue;
    const key = kv[1] as "name" | "description";
    if (result[key] === undefined) result[key] = stripQuotes(kv[2].trim());
  }
  return result;
}

function stripQuotes(value: string): string {
  if (value.length >= 2 && ((value[0] === '"' && value.endsWith('"')) || (value[0] === "'" && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

/** Read the `mcpServers` map from a CLI config file. */
function parseMcpServers(path: string, content: string): DaemonAgentMcpServer[] {
  if (path.endsWith(".toml")) return parseTomlMcpServers(content);
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const map = (parsed as { mcpServers?: unknown })?.mcpServers;
  if (!map || typeof map !== "object") return [];
  const servers: DaemonAgentMcpServer[] = [];
  for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
    if (!name || typeof raw !== "object" || raw === null) continue;
    const entry = raw as { command?: unknown; url?: unknown; type?: unknown; transport?: unknown };
    const transport = resolveTransport(entry);
    const command =
      typeof entry.command === "string"
        ? entry.command
        : typeof entry.url === "string"
          ? redactMcpUrl(entry.url)
          : undefined;
    servers.push({ name, transport, ...(command ? { command } : {}) });
  }
  return servers;
}

function parseTomlMcpServers(content: string): DaemonAgentMcpServer[] {
  const servers: DaemonAgentMcpServer[] = [];
  let current: { name: string; values: Record<string, string> } | undefined;
  const flush = (): void => {
    if (!current) return;
    const entry = current;
    current = undefined;
    const url = entry.values.url;
    const command = entry.values.command ?? (url ? redactMcpUrl(url) : undefined);
    servers.push({
      name: entry.name,
      transport: url ? "http" : "stdio",
      ...(command ? { command } : {}),
    });
  };
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    const section = /^\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]$/.exec(line);
    if (section) {
      flush();
      current = { name: section[1] ?? section[2], values: {} };
      continue;
    }
    // Any other table ends the current server. Without this, a `command`/`url`
    // key in an unrelated later section would be attributed to the last MCP
    // server seen.
    if (line.startsWith("[")) {
      flush();
      current = undefined;
      continue;
    }
    if (!current || !line || line.startsWith("#")) continue;
    const field = /^(command|url)\s*=\s*(?:"((?:\\.|[^"])*)"|'([^']*)')/.exec(line);
    if (field) {
      current.values[field[1]] = field[2] !== undefined
        ? field[2].replace(/\\"/g, '"')
        : field[3];
    }
  }
  flush();
  return servers;
}

function redactMcpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, url.pathname === "/" ? "/" : "");
  } catch {
    return undefined;
  }
}

function resolveTransport(entry: { url?: unknown; type?: unknown; transport?: unknown }): DaemonMcpTransport {
  const declared = typeof entry.type === "string" ? entry.type : typeof entry.transport === "string" ? entry.transport : undefined;
  if (declared === "sse") return "sse";
  if (declared === "http" || declared === "streamable-http") return "http";
  if (typeof entry.url === "string" && entry.url) return "http";
  return "stdio";
}

function dedupeSkills(skills: DaemonAgentSkill[]): DaemonAgentSkill[] {
  const seen = new Set<string>();
  const result: DaemonAgentSkill[] = [];
  for (const skill of skills) {
    const key = `${skill.namespace ?? ""}/${skill.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(skill);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

function dedupeMcpServers(servers: DaemonAgentMcpServer[]): DaemonAgentMcpServer[] {
  const seen = new Set<string>();
  const result: DaemonAgentMcpServer[] = [];
  for (const server of servers) {
    if (seen.has(server.name)) continue;
    seen.add(server.name);
    result.push(server);
  }
  return result.sort((a, b) => a.name.localeCompare(b.name));
}
