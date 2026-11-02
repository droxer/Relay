/** Node implementations of host discovery; output matches the existing guest record parsers. */
import type { AgentName } from 'relay-core';

const FILE_HELPERS = String.raw`
const fs = await import('node:fs'), path = await import('node:path');
const home = process.env.HOME || (await import('node:os')).homedir();
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const json = text => { try { return JSON.parse(text); } catch { return {}; } };
const emit = (source, text) => { if (text) process.stdout.write(source + '\t' + Buffer.from(text).toString('base64') + '\n'); };
`;

export function nativeModelDiscoveryScript(agent: AgentName): string {
  return FILE_HELPERS + `const agent = ${JSON.stringify(agent)};\n` + String.raw`
const cli = async args => {
  try { const r = await relayRun([agent, ...args], { capture: true, allowFailure: true }); return r.code === 0 ? r.stdout + r.stderr : ''; }
  catch { return ''; }
};
const api = async (url, headers) => {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (response.ok) {
      const body = await response.json();
      // Never emit provider metadata or credentials, only model ids.
      if (Array.isArray(body.data)) emit('api', JSON.stringify({data: body.data.map(m => ({id:m.id}))}));
    }
  } catch { /* Discovery keeps local CLI sources when the provider is unreachable. */ }
};
switch (agent) {
  case 'claude': {
    const config = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    emit('help', await cli(['--help']));
    emit('settings', read(path.join(config, 'settings.json')));
    const account = json(read(path.join(process.env.CLAUDE_CONFIG_DIR || home, '.claude.json')));
    if (Array.isArray(account.additionalModelOptionsCache)) emit('account', '"additionalModelOptionsCache":' + JSON.stringify(account.additionalModelOptionsCache));
    const base = (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
    const headers = {'anthropic-version':'2023-06-01'};
    if (process.env.ANTHROPIC_API_KEY) headers['x-api-key'] = process.env.ANTHROPIC_API_KEY;
    else if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
      headers.authorization = 'Bearer ' + process.env.CLAUDE_CODE_OAUTH_TOKEN;
      headers['anthropic-beta'] = 'oauth-2025-04-20';
    } else if (process.env.ANTHROPIC_AUTH_TOKEN) headers.authorization = 'Bearer ' + process.env.ANTHROPIC_AUTH_TOKEN;
    else if (base === 'https://api.anthropic.com' || base === 'https://api.anthropic.com/v1') {
      const token = json(read(path.join(config, '.credentials.json'))).claudeAiOauth?.accessToken;
      if (token) { headers.authorization = 'Bearer ' + token; headers['anthropic-beta'] = 'oauth-2025-04-20'; }
    }
    if (headers.authorization || headers['x-api-key']) await api(base.replace(/\/v1$/, '') + '/v1/models?limit=1000', headers);
    break;
  }
  case 'codex': {
    const catalog = json(await cli(['debug', 'models']) || read(path.join(process.env.CODEX_HOME || path.join(home,'.codex'), 'models_cache.json')));
    const models = Array.isArray(catalog) ? catalog : catalog.models;
    if (Array.isArray(models)) emit('catalog', models.flatMap(m => ['slug','visibility','priority'].filter(k => m[k] !== undefined).map(k => JSON.stringify(k) + ':' + JSON.stringify(m[k]))).join('\n'));
    const base = (process.env.OPENAI_BASE_URL || '').replace(/\/$/, '');
    const key = process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY;
    if (base && base !== 'https://api.openai.com' && base !== 'https://api.openai.com/v1' && key) await api(base + '/models', {authorization:'Bearer '+key});
    break;
  }
  case 'pi': emit('list', await cli(['--list-models'])); break;
  case 'kimi': {
    const provider = json(await cli(['provider','list','--json']));
    // The CLI's JSON includes credentials; emit its models object alone.
    if (provider.models && typeof provider.models === 'object') emit('models', '"models":' + JSON.stringify(provider.models) + '}');
    const listed = await cli(['provider','list']);
    emit('default', listed.split(/\r?\n/).filter(line => /^Default model:/.test(line)).join('\n'));
    if (!provider.models) emit('config', read(path.join(process.env.KIMI_CODE_HOME || path.join(home,'.kimi-code'), 'config.toml')));
    break;
  }
  case 'opencode': emit('list', await cli(['models'])); break;
}
`;
}

interface InventorySource { skillsDir?: string; mcpJson?: readonly string[]; mcpToml?: readonly string[] }
export function nativeInventoryScript(sources: Record<AgentName, InventorySource>): string {
  return FILE_HELPERS + `const sources = ${JSON.stringify(sources)};\n` + String.raw`
const configHomes = {
  claude: process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'),
  codex: process.env.CODEX_HOME || path.join(home, '.codex'),
  pi: process.env.PI_CODING_AGENT_DIR || path.join(home, '.pi'),
  kimi: process.env.KIMI_CODE_HOME || path.join(home, '.kimi-code'),
};
for (const [agent, source] of Object.entries(sources)) {
  const config = configHomes[agent];
  if (!config) continue;
  const record = (kind, id, text) => emit(kind + '\t' + agent + '\t' + id, text);
  if (source.skillsDir) {
    const root = path.join(config, 'skills');
    const walk = (directory, depth) => {
      if (depth > 4) return;
      let entries; try { entries = fs.readdirSync(directory, {withFileTypes:true}); } catch { return; }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file, depth + 1);
        else if (entry.isFile() && entry.name === 'SKILL.md') record('SKILL', path.relative(root,file).split(path.sep).join('/'), read(file));
      }
    };
    walk(root, 1);
  }
  for (const relative of [...(source.mcpJson || []), ...(source.mcpToml || [])]) {
    const file = agent === 'claude' ? path.join(process.env.CLAUDE_CONFIG_DIR || home, relative) : path.join(config, path.basename(relative));
    record('MCP', relative, read(file));
  }
}
`;
}
