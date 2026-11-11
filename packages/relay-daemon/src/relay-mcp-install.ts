/** Scoped, idempotent runtime configuration. Unowned entries are never overwritten. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, realpathSync, statSync, rmSync, lstatSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { parse, modify, applyEdits, type ParseError } from 'jsonc-parser';

type Runtime = 'codex' | 'claude' | 'kimi' | 'opencode' | 'pi';
export class McpInstallError extends Error {
  constructor(readonly code: string, message: string, readonly blocked = true) { super(message); }
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function json(text: string, path: string): any {
  const errors: ParseError[] = []; const value = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) throw new McpInstallError('mcp_invalid_configuration', `Invalid configuration in ${path}; repair the JSON/JSONC before retrying. The file was not changed.`);
  return value;
}
function conflict(path: string, serverName: string): never {
  throw new McpInstallError('mcp_configuration_conflict', `Relay MCP conflict: user owned or modified entry ${serverName} in ${path}; review this entry and the ownership record in installed-servers.json under ~/.relay/mcp before retrying. User changes were preserved.`);
}
export function privateWrite(path: string, text: string): void {
  const target = existsSync(path) ? realpathSync(path) : path;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  writeFileSync(temporary, text, { mode: existsSync(target) ? statSync(target).mode & 0o777 : 0o600, flag: 'wx' });
  renameSync(temporary, target);
}
type InstallOptions = { home: string; runtimes: readonly string[]; configFile: string; serverName: string; env?: NodeJS.ProcessEnv };
export function installRelayMcp(options: InstallOptions): string[] {
  try { return lockedInstall(options); }
  catch (error) {
    if (error instanceof McpInstallError) throw error;
    // Never forward parser exceptions or raw configuration values into saved
    // status, doctor output, or installer logs.
    const errno = (error as NodeJS.ErrnoException | undefined)?.code;
    const code = typeof errno === 'string' && /^E[A-Z]+$/.test(errno) ? errno : 'unknown';
    throw new McpInstallError('mcp_installation_failed', `Relay MCP installation failed (${code}); check runtime configuration paths and filesystem permissions. Setup will retry.`, false);
  }
}
function lockedInstall(options: InstallOptions): string[] {
  const root = join(options.home, '.relay', 'mcp');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const lock = join(root, 'install.lock');
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const stat = lstatSync(lock);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new McpInstallError('mcp_unsafe_installation_lock', `Unsafe Relay MCP installation lock at ${lock}; inspect it before retrying.`);
    let stale = false;
    try {
      const owner = JSON.parse(readFileSync(join(lock,'owner.json'),'utf8')) as {pid?:number};
      if (Number.isInteger(owner.pid) && owner.pid! > 0) {
        try { process.kill(owner.pid!,0); }
        catch (error) { stale = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      }
    } catch { stale = Date.now() - stat.mtimeMs > 120_000; }
    if (!stale) throw new McpInstallError('mcp_installation_busy', `Another Relay MCP installer is active at ${lock}; setup will retry after it finishes.`, false);
    rmSync(lock,{recursive:true}); mkdirSync(lock,{mode:0o700});
  }
  writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:process.pid}),{mode:0o600,flag:'wx'});
  try { return install(options); } finally { rmSync(lock, { recursive: true }); }
}
function install(options: InstallOptions): string[] {
  const { home, configFile, serverName } = options;
  if (!/^[a-z0-9-]+$/.test(serverName)) throw new Error('Invalid Relay MCP server name.');
  const env = options.env ?? {};
  const server = fileURLToPath(new URL('./relay-mcp.js', import.meta.url));
  const args = [server, '--config', configFile];
  const manifestPath = join(home, '.relay', 'mcp', 'installed-servers.json');
  const manifest: Record<string, string> = existsSync(manifestPath) ? json(readFileSync(manifestPath, 'utf8'), manifestPath) : {};
  const installed: string[] = [];
  for (const runtime of options.runtimes as Runtime[]) {
    let path: string; let keys: string[]; let entry: unknown;
    if (runtime === 'codex') {
      path = join(env.CODEX_HOME ?? join(home, '.codex'), 'config.toml');
      const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
      let config: any;
      try { config = parseToml(text); }
      catch { throw new McpInstallError('mcp_invalid_configuration', `Invalid configuration in ${path}; repair the TOML before retrying. The file was not changed.`); }
      const current = config.mcp_servers?.[serverName];
      const begin = `# BEGIN RELAY MCP ${serverName}`; const end = `# END RELAY MCP ${serverName}`;
      const marker = text.indexOf(begin); const endIndex = text.indexOf(end, marker);
      const key = `${path}:${serverName}`;
      if ((current || marker >= 0) && (!manifest[key] || !current || digest(current) !== manifest[key] || marker < 0 || endIndex < 0)) conflict(path, serverName);
      const block = `${begin}\n[mcp_servers.${serverName}]\ncommand = ${JSON.stringify(process.execPath)}\nargs = ${JSON.stringify(args)}\nenv_vars = ["RELAY_MCP_RUN_CONTEXT"]\n${end}\n`;
      const next = marker >= 0 ? text.slice(0, marker) + block + text.slice(endIndex + end.length).replace(/^\r?\n/, '') : text + (text.endsWith('\n') || !text ? '' : '\n') + block;
      const updated = parseToml(next) as any;
      privateWrite(path, next); manifest[key] = digest(updated.mcp_servers[serverName]);
    } else {
      if (runtime === 'claude') { path = join(home, '.claude.json'); keys = ['mcpServers', serverName]; entry = { type: 'stdio', command: process.execPath, args, env: {RELAY_MCP_RUN_CONTEXT:'${RELAY_MCP_RUN_CONTEXT:-}'} }; }
      else if (runtime === 'kimi') { path = join(env.KIMI_CODE_HOME ?? join(home, '.kimi-code'), 'mcp.json'); keys = ['mcpServers', serverName]; entry = { command: process.execPath, args }; }
      else if (runtime === 'opencode') {
        const root = join(env.XDG_CONFIG_HOME ?? join(home, '.config'), 'opencode');
        path = existsSync(join(root, 'opencode.jsonc')) ? join(root, 'opencode.jsonc') : join(root, 'opencode.json');
        keys = ['mcp', serverName]; entry = { type: 'local', command: [process.execPath, ...args], enabled: true };
      } else if (runtime === 'pi') {
        path = join(env.PI_CODING_AGENT_DIR ?? join(home, '.pi', 'agent'), 'extensions', `${serverName}.mjs`);
        const source = piExtension(process.execPath, args, serverName);
        const key = `${path}:${serverName}`;
        if (existsSync(path) && (!manifest[key] || digest(readFileSync(path, 'utf8')) !== manifest[key])) conflict(path, serverName);
        privateWrite(path, source); manifest[key] = digest(source); privateWrite(manifestPath, JSON.stringify(manifest, null, 2)); installed.push(runtime); continue;
      } else continue;
      const text = existsSync(path) ? readFileSync(path, 'utf8') : '{}\n'; const config = json(text, path);
      const current = config[keys[0]!]?.[keys[1]!]; const key = `${path}:${serverName}`;
      if (current !== undefined && (!manifest[key] || digest(current) !== manifest[key])) conflict(path, serverName);
      privateWrite(path, applyEdits(text, modify(text, keys, entry, { formattingOptions: { insertSpaces: true, tabSize: 2 } })));
      manifest[key] = digest(entry);
    }
    privateWrite(manifestPath, JSON.stringify(manifest, null, 2)); installed.push(runtime);
  }
  return installed;
}

// Pi has no native MCP client. Its extension registers tools obtained from this
// actual stdio server, and sends tools/call over the same MCP connection.
function piExtension(command: string, args: string[], serverName: string): string {
  return `import {spawn} from 'node:child_process';\nimport {createInterface} from 'node:readline';\nexport default function(pi) {
 let child; let sequence=0; const pending=new Map();
 const call=(method,params={})=>new Promise((resolve,reject)=>{const id=++sequence; const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Relay MCP timed out'));},65000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\\n');});
 const fail=()=>{for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Relay MCP stopped'));}pending.clear();child=undefined;};
 const schema=(value)=>{if(!value||typeof value!=='object')return value;if(Array.isArray(value))return value.map(schema);let source=value;if(value.enum)source={anyOf:value.enum.map(v=>({const:v,type:v===null?'null':typeof v}))};else if(Array.isArray(value.type))source={...value,type:undefined,anyOf:value.type.map(type=>({type}))};const out=Object.fromEntries(Object.entries(source).map(([k,v])=>[k,schema(v)]));out[Symbol.for('TypeBox.Kind')]=Object.hasOwn(out,'const')?'Literal':out.anyOf?'Union':({object:'Object',array:'Array',string:'String',integer:'Integer',number:'Number',boolean:'Boolean',null:'Null'})[out.type]||'Any';return out;};
 pi.on('session_start',async()=>{if(child)return;child=spawn(${JSON.stringify(command)},${JSON.stringify(args)},{stdio:['pipe','pipe','ignore'],windowsHide:true});child.on('error',fail);child.on('exit',fail);createInterface({input:child.stdout}).on('line',line=>{try{const r=JSON.parse(line);const p=pending.get(r.id);if(p){pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(new Error('Relay MCP request failed')):p.resolve(r.result);}}catch{}});
 try{await call('initialize',{protocolVersion:'2025-11-25',capabilities:{},clientInfo:{name:'relay-pi',version:'1'}});child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\\n');const result=await call('tools/list');for(const tool of result.tools){pi.registerTool({name:tool.name+'_${serverName.replace(/-/g, '_')}',label:tool.name,description:tool.description,parameters:schema(tool.inputSchema),execute:async(_id,params)=>{const result=await call('tools/call',{name:tool.name,arguments:params});return {content:result.content,details:{isError:result.isError||false}};}});}}catch{child?.kill();}});
 pi.on('session_shutdown',()=>{child?.kill();});
}\n`;
}
