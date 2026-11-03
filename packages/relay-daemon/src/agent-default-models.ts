import type { AgentName } from "relay-core";

/** Read user-level defaults in the execution environment, emitting only a model id.
 * No catalog ordering or vendor fallback is treated as a configured default.
 * The same Node program runs on native Windows and inside POSIX discovery.
 */
export function defaultModelDiscoveryScript(agent: AgentName): string {
  const helpers = String.raw`
{
  const fs = await import('node:fs'), path = await import('node:path');
  const env = process.env;
  const home = env.HOME || (await import('node:os')).homedir();
  const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
  const json = text => { try { return JSON.parse(text); } catch { return {}; } };
  // Only string scalars in the requested TOML table; never match a nested model.
  const scalar = (text, key, table = '') => {
    let current = '';
    for (const line of text.split(/\r?\n/)) {
      const section = /^\s*\[([^\]]+)\]/.exec(line);
      if (section) { current = section[1].replace(/["']/g, ''); continue; }
      if (current !== table) continue;
      const match = /^\s*([\w_]+)\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/.exec(line);
      if (match && match[1] === key) return match[2] ?? match[3];
    }
  };
`;
  const sources: Record<AgentName, string> = {
    claude: String.raw`
      const dir = env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
      model = env.ANTHROPIC_MODEL || json(read(path.join(dir, 'settings.json'))).model;
`,
    codex: String.raw`
      const config = read(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'));
      const profile = scalar(config, 'profile');
      model = env.OPENAI_MODEL || (profile && scalar(config, 'model', 'profiles.' + profile)) || scalar(config, 'model');
`,
    pi: String.raw`
      const config = json(read(path.join(env.PI_CODING_AGENT_DIR || path.join(home, '.pi', 'agent'), 'settings.json')));
      if (config.defaultProvider && config.defaultModel) model = config.defaultProvider + '/' + config.defaultModel;
`,
    kimi: String.raw`
      const config = read(path.join(env.KIMI_CODE_HOME || path.join(home, '.kimi-code'), 'config.toml'));
      model = env.KIMI_MODEL || scalar(config, 'default_model');
`,
    opencode: String.raw`
      const dir = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'opencode');
      const configJson = text => json(text
        .replace(/("(?:\\.|[^"\\])*")|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (match, quoted) => quoted || ' ')
        .replace(/("(?:\\.|[^"\\])*")|,(?=\s*[}\]])/g, (match, quoted) => quoted || ''));
      const config = {
        ...configJson(read(path.join(dir, 'opencode.json'))),
        ...configJson(read(path.join(dir, 'opencode.jsonc'))),
        ...configJson(env.OPENCODE_CONFIG ? read(env.OPENCODE_CONFIG) : ''),
        ...json(env.OPENCODE_CONFIG_CONTENT || ''),
      };
      model = config.model;
`,
  };
  return helpers + "\nlet model;\n" + sources[agent] + String.raw`
  if (typeof model === 'string' && model.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]*$/.test(model)) {
    process.stdout.write('default-model\t' + Buffer.from(model).toString('base64') + '\n');
  }
}
`;
}
