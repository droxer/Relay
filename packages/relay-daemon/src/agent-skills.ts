import { createHash, randomBytes } from "node:crypto";
import { runAsAgent, shellCommand, type AgentExecutor, type DaemonRunSkillBundle, type DaemonSkippedSkill, type SkillDelivery } from "relay-core";

export interface MaterializedSkills { skillPaths: string[]; env: Record<string, string>; slugs: string[]; skipped: DaemonSkippedSkill[]; }
export interface MaterializeSkillsOptions {
  bundle: DaemonRunSkillBundle | undefined; agentId: string; delivery: SkillDelivery;
  agentHome: string; cacheDir: string; execStream: AgentExecutor;
  fetchBlob(sha256: string): Promise<Buffer>; signal?: AbortSignal;
}

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const SAFE_PATH_PART = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,253}[A-Za-z0-9])?$/;
const SAFE_SLUG_PART = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 300;
const MAX_REVISION_BYTES = 4 * 1024 * 1024;
const TRANSFER_CHUNK_BYTES = 48 * 1024;

export async function materializeSkills(options: MaterializeSkillsOptions): Promise<MaterializedSkills> {
  if (options.bundle === undefined) return { skillPaths: [], env: {}, slugs: [], skipped: [] };
  const supplied = Array.isArray(options.bundle.skills) ? options.bundle.skills : [];
  const headerValid = validBundleHeader(options.bundle) && SAFE_ID.test(options.agentId);
  const skipped: DaemonSkippedSkill[] = headerValid ? [] : supplied.map((skill) => skippedSkill(skill, "invalid-bundle"));
  const candidates = headerValid ? supplied.filter((skill) => {
    const reason = validateSkill(skill);
    if (reason) skipped.push(skippedSkill(skill, reason));
    return !reason;
  }) : [];
  const manifests = candidates.filter((skill) => {
    if (manifestDigest(skill.files) === skill.manifestSha256) return true;
    skipped.push(skippedSkill(skill, "manifest-digest-mismatch"));
    return false;
  });
  const cache = await inspectCache(options, manifests);
  const transferId = `${process.pid}-${randomBytes(12).toString("hex")}`;
  const transferred = new Set<string>();
  const ready: typeof manifests = [];
  try {
    for (const skill of manifests) {
      let failed = false;
      for (const file of skill.files) {
        if (cache.validManifests.has(skill.manifestSha256) || cache.validBlobs.has(file.sha256) || transferred.has(file.sha256)) continue;
        try {
          const content = await options.fetchBlob(file.sha256);
          if (content.length !== file.bytes || content.length > MAX_FILE_BYTES || sha256(content) !== file.sha256) throw new Error("invalid blob");
          await transferBlob(options, transferId, file.sha256, content);
          transferred.add(file.sha256);
        } catch {
          skipped.push(skippedSkill(skill, "blob-fetch-failed"));
          failed = true;
          break;
        }
      }
      if (!failed) ready.push(skill);
    }
    const viewId = sha256(Buffer.from(JSON.stringify({ agentId: options.agentId, delivery: options.delivery, skills: ready.map((skill) => [skill.slug, skill.manifestSha256]) }))).slice(0, 32);
    const result = await executeJson(options, MATERIALIZER_SCRIPT, { agentHome: options.agentHome, cacheDir: options.cacheDir, delivery: options.delivery, transferId, viewId, skills: ready, cachedManifests: [...cache.validManifests] });
    if (result.exit_code !== 0) throw new Error(`skill materialization failed: ${(result.stderr || result.error_message || "unknown error").trim()}`);
    const parsed = JSON.parse(result.stdout.trim()) as { skillPaths: string[]; env: Record<string, string> };
    if (!Array.isArray(parsed.skillPaths) || !parsed.skillPaths.every((v) => typeof v === "string") || !parsed.env || typeof parsed.env !== "object") throw new Error("invalid materializer response");
    return { ...parsed, slugs: ready.map((skill) => skill.slug), skipped };
  } finally {
    await executeJson(options, CLEANUP_SCRIPT, { cacheDir: options.cacheDir, transferId }).catch(() => undefined);
  }
}

function skippedSkill(skill: { skillId?: string; slug?: string }, reason: string): DaemonSkippedSkill {
  return { skillId: skill.skillId || "unknown", ...(skill.slug ? { slug: skill.slug } : {}), reason };
}

async function inspectCache(options: MaterializeSkillsOptions, skills: DaemonRunSkillBundle["skills"]): Promise<{ validManifests: Set<string>; validBlobs: Set<string> }> {
  try {
    const result = await executeJson(options, INSPECT_SCRIPT, { cacheDir: options.cacheDir, skills });
    if (result.exit_code !== 0) throw new Error();
    const parsed = JSON.parse(result.stdout) as { validManifests?: string[]; validBlobs?: string[] };
    return { validManifests: new Set(parsed.validManifests ?? []), validBlobs: new Set(parsed.validBlobs ?? []) };
  } catch { return { validManifests: new Set(), validBlobs: new Set() }; }
}

async function transferBlob(options: MaterializeSkillsOptions, transferId: string, digest: string, content: Buffer): Promise<void> {
  const chunks = Math.max(1, Math.ceil(content.length / TRANSFER_CHUNK_BYTES));
  for (let index = 0; index < chunks; index += 1) {
    const chunk = content.subarray(index * TRANSFER_CHUNK_BYTES, Math.min((index + 1) * TRANSFER_CHUNK_BYTES, content.length));
    const result = await executeJson(options, TRANSFER_SCRIPT, { cacheDir: options.cacheDir, transferId, digest, index, data: chunk.toString("base64") });
    if (result.exit_code !== 0) throw new Error("blob transfer failed");
  }
}

async function executeJson(options: MaterializeSkillsOptions, script: string, value: unknown) {
  const inputId = `${process.pid}-${randomBytes(12).toString("hex")}`;
  const content = Buffer.from(JSON.stringify(value));
  const chunks = Math.max(1, Math.ceil(content.length / TRANSFER_CHUNK_BYTES));
  for (let index = 0; index < chunks; index += 1) {
    const data = content.subarray(index * TRANSFER_CHUNK_BYTES, Math.min((index + 1) * TRANSFER_CHUNK_BYTES, content.length)).toString("base64");
    const bootstrap = Buffer.from(JSON.stringify({ cacheDir: options.cacheDir, inputId, index, data })).toString("base64");
    const staged = await executeArgv(options, INPUT_SCRIPT, bootstrap);
    if (staged.exit_code !== 0) return staged;
  }
  const descriptor = Buffer.from(JSON.stringify({ cacheDir: options.cacheDir, inputId })).toString("base64");
  return executeArgv(options, script, descriptor);
}

function executeArgv(options: MaterializeSkillsOptions, script: string, payload: string) {
  const argv = ["node", "-e", script, payload];
  return options.agentHome === "/home/agent"
    ? options.execStream("bash", ["-c", runAsAgent(shellCommand(argv))], { signal: options.signal })
    : options.execStream(argv[0]!, argv.slice(1), { signal: options.signal });
}

function validBundleHeader(bundle: DaemonRunSkillBundle): boolean { return bundle.contract?.name === "relay.agent.skills" && bundle.contract.version === 1 && Array.isArray(bundle.skills); }
function validateSkill(skill: DaemonRunSkillBundle["skills"][number]): string | undefined {
  if (!SAFE_ID.test(skill.skillId) || !SAFE_ID.test(skill.revisionId) || !SHA256.test(skill.manifestSha256) || !validSlug(skill.slug)) return "invalid-bundle";
  if (!Array.isArray(skill.files) || skill.files.length === 0 || skill.files.length > MAX_FILES) return "invalid-bundle";
  let total = 0; const seen = new Set<string>();
  for (const file of skill.files) {
    if (!validRelativePath(file.path) || !SHA256.test(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > MAX_FILE_BYTES) return "invalid-bundle";
    total += file.bytes;
    if (total > MAX_REVISION_BYTES || seen.has(file.path) || [...seen].some((path) => path.startsWith(`${file.path}/`) || file.path.startsWith(`${path}/`))) return "invalid-bundle";
    seen.add(file.path);
  }
  if (!seen.has("SKILL.md")) return "invalid-bundle";
  return undefined;
}
function validRelativePath(value: string): boolean { return typeof value === "string" && value.length <= 512 && !value.includes("\\") && value.split("/").every((part) => SAFE_PATH_PART.test(part) && part !== "." && part !== ".."); }
function validSlug(value: string): boolean { return typeof value === "string" && value.length <= 512 && !value.includes("\\") && value.split("/").every((part) => SAFE_SLUG_PART.test(part)); }
function manifestDigest(files: DaemonRunSkillBundle["skills"][number]["files"]): string { const digest = createHash("sha256"); for (const file of files) digest.update(file.path).update("\0").update(file.sha256).update("\n"); return digest.digest("hex"); }
function sha256(content: Buffer): string { return createHash("sha256").update(content).digest("hex"); }

const INPUT_SCRIPT = String.raw`
const fs=require('node:fs'),p=require('node:path');const x=JSON.parse(Buffer.from(process.argv[1],'base64').toString());
if(!/^[A-Za-z0-9-]+$/.test(x.inputId)||!Number.isSafeInteger(x.index)||x.index<0)throw Error('invalid input');
if(fs.existsSync(x.cacheDir)&&!fs.lstatSync(x.cacheDir).isDirectory())throw Error('unsafe cache');fs.mkdirSync(x.cacheDir,{recursive:true,mode:0o700});
const inputs=p.resolve(x.cacheDir,'.inputs');if(fs.existsSync(inputs)&&!fs.lstatSync(inputs).isDirectory())throw Error('unsafe inputs');fs.mkdirSync(inputs,{recursive:true});const out=p.resolve(inputs,x.inputId);if(!out.startsWith(inputs+p.sep))throw Error('escape');fs.writeFileSync(out,Buffer.from(x.data,'base64'),{flag:x.index===0?'w':'a',mode:0o600});`;

const COMMON = String.raw`
const fs=require('node:fs'),p=require('node:path'),c=require('node:crypto');const d=JSON.parse(Buffer.from(process.argv[1],'base64').toString());
if(!/^[A-Za-z0-9-]+$/.test(d.inputId))throw Error('invalid input');const inputs=p.resolve(d.cacheDir,'.inputs');if(!fs.lstatSync(inputs).isDirectory())throw Error('unsafe inputs');const input=p.resolve(inputs,d.inputId);if(!input.startsWith(inputs+p.sep)||!fs.lstatSync(input).isFile())throw Error('unsafe input');const x=JSON.parse(fs.readFileSync(input));fs.rmSync(input,{force:true});
const inside=(root,...parts)=>{const r=p.resolve(root),v=p.resolve(root,...parts);if(v!==r&&!v.startsWith(r+p.sep))throw Error('escape');return v};
const safeDir=(f)=>{if(fs.existsSync(f)){if(!fs.lstatSync(f).isDirectory())throw Error('unsafe cache directory')}else fs.mkdirSync(f,{recursive:true})};safeDir(x.cacheDir);
const hashFile=(f)=>{const h=c.createHash('sha256');h.update(fs.readFileSync(f));return h.digest('hex')};const regular=(f)=>{try{return fs.lstatSync(f).isFile()}catch{return false}};`;

const INSPECT_SCRIPT = COMMON + String.raw`
const store=inside(x.cacheDir,'.store'),blobs=inside(x.cacheDir,'.blobs');safeDir(store);safeDir(blobs);let vm=[],vb=[];
for(const s of x.skills){let ok=true;const dir=inside(store,s.manifestSha256);try{if(!fs.lstatSync(dir).isDirectory())ok=false}catch{ok=false}
for(const f of s.files){const blob=inside(blobs,f.sha256);if(regular(blob)&&fs.statSync(blob).size===f.bytes&&hashFile(blob)===f.sha256)vb.push(f.sha256);const q=inside(dir,...f.path.split('/'));if(!regular(q)||fs.statSync(q).size!==f.bytes||hashFile(q)!==f.sha256)ok=false}
if(ok){const names=[];const walk=(d,b='')=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const n=b?b+'/'+e.name:e.name;if(e.isSymbolicLink())ok=false;else if(e.isDirectory())walk(p.join(d,e.name),n);else if(e.isFile())names.push(n);else ok=false}};walk(dir);if(names.length!==s.files.length||names.some(n=>!s.files.some(f=>f.path===n)))ok=false}if(ok)vm.push(s.manifestSha256)}
process.stdout.write(JSON.stringify({validManifests:[...new Set(vm)],validBlobs:[...new Set(vb)]}));`;

const TRANSFER_SCRIPT = COMMON + String.raw`
if(!/^[a-f0-9]{64}$/.test(x.digest)||!/^[A-Za-z0-9-]+$/.test(x.transferId)||!Number.isSafeInteger(x.index)||x.index<0)throw Error('invalid transfer');
const transfers=inside(x.cacheDir,'.transfers');safeDir(transfers);const dir=inside(transfers,x.transferId);safeDir(dir);fs.writeFileSync(inside(dir,x.digest),Buffer.from(x.data,'base64'),{flag:x.index===0?'w':'a',mode:0o600});`;

const MATERIALIZER_SCRIPT = COMMON + String.raw`
const store=inside(x.cacheDir,'.store'),cas=inside(x.cacheDir,'.blobs'),transfers=inside(x.cacheDir,'.transfers'),trans=inside(transfers,x.transferId);safeDir(store);safeDir(cas);safeDir(transfers);safeDir(trans);
const validRevision=(dir,s)=>{try{if(!fs.lstatSync(dir).isDirectory())return false;const names=[];let ok=true;const walk=(d,b='')=>{for(const e of fs.readdirSync(d,{withFileTypes:true})){const n=b?b+'/'+e.name:e.name,q=p.join(d,e.name);if(e.isSymbolicLink())ok=false;else if(e.isDirectory())walk(q,n);else if(e.isFile())names.push(n);else ok=false}};walk(dir);return ok&&names.length===s.files.length&&s.files.every(f=>{const q=inside(dir,...f.path.split('/'));return regular(q)&&fs.statSync(q).size===f.bytes&&hashFile(q)===f.sha256})&&names.every(n=>s.files.some(f=>f.path===n))}catch{return false}};
const withLock=(lock,fn)=>{const start=Date.now();for(;;){try{fs.mkdirSync(lock);break}catch(e){if(e.code!=='EEXIST'||Date.now()-start>5000)throw e;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10)}}try{return fn()}finally{fs.rmSync(lock,{recursive:true,force:true})}};
for(const s of x.skills){if((x.cachedManifests||[]).includes(s.manifestSha256))continue;for(const f of s.files){const dst=inside(cas,f.sha256),valid=()=>regular(dst)&&fs.statSync(dst).size===f.bytes&&hashFile(dst)===f.sha256;if(!valid())withLock(inside(cas,'.lock-'+f.sha256),()=>{if(valid())return;fs.rmSync(dst,{force:true,recursive:true});const src=inside(trans,f.sha256);if(!regular(src)||fs.statSync(src).size!==f.bytes||hashFile(src)!==f.sha256)throw Error('invalid staged blob');fs.renameSync(src,dst)})}
const dst=inside(store,s.manifestSha256);if(!validRevision(dst,s))withLock(inside(store,'.lock-'+s.manifestSha256),()=>{if(validRevision(dst,s))return;fs.rmSync(dst,{recursive:true,force:true});const tmp=inside(store,'.tmp-'+process.pid+'-'+c.randomBytes(8).toString('hex'));fs.mkdirSync(tmp,{recursive:true});try{for(const f of s.files){const out=inside(tmp,...f.path.split('/'));fs.mkdirSync(p.dirname(out),{recursive:true});fs.copyFileSync(inside(cas,f.sha256),out)}fs.renameSync(tmp,dst)}finally{fs.rmSync(tmp,{recursive:true,force:true})}})}
const views=inside(x.cacheDir,'views');safeDir(views);const view=inside(views,x.viewId),tmp=inside(views,'.tmp-'+x.viewId+'-'+process.pid+'-'+c.randomBytes(8).toString('hex'));fs.mkdirSync(tmp,{recursive:true});let paths=[],env={};
if(x.delivery.kind==='config-dir'){const cfg=inside(tmp,x.delivery.subdir);fs.mkdirSync(cfg,{recursive:true});const nodeCfg=inside(x.agentHome,x.delivery.subdir);if(fs.existsSync(nodeCfg)){for(const n of fs.readdirSync(nodeCfg)){if(n===x.delivery.skillsSubpath)continue;fs.symlinkSync(inside(nodeCfg,n),inside(cfg,n))}}const skills=inside(cfg,x.delivery.skillsSubpath);fs.mkdirSync(skills,{recursive:true});for(const s of x.skills){const to=inside(skills,...s.slug.split('/'));fs.mkdirSync(p.dirname(to),{recursive:true});fs.symlinkSync(inside(store,s.manifestSha256),to,'dir')}}else if(x.delivery.kind==='skills-dir-flag'){const root=inside(tmp,'skills');fs.mkdirSync(root,{recursive:true});for(const s of x.skills){const to=inside(root,...s.slug.split('/'));fs.mkdirSync(p.dirname(to),{recursive:true});fs.symlinkSync(inside(store,s.manifestSha256),to,'dir')}}
fs.writeFileSync(inside(tmp,'.relay-view'),x.viewId,{mode:0o600});try{fs.renameSync(tmp,view)}catch(e){if(!fs.existsSync(view))throw e;fs.rmSync(tmp,{recursive:true,force:true});if(!regular(inside(view,'.relay-view'))||fs.readFileSync(inside(view,'.relay-view'),'utf8')!==x.viewId)throw Error('unsafe existing view');const root=x.delivery.kind==='config-dir'?inside(view,x.delivery.subdir,x.delivery.skillsSubpath):inside(view,'skills');if(x.delivery.kind!=='skill-path-flag'){const found=[];const walk=(d,b='')=>{for(const n of fs.readdirSync(d)){const q=inside(d,n),rel=b?b+'/'+n:n,st=fs.lstatSync(q);if(st.isSymbolicLink())found.push([rel,fs.readlinkSync(q)]);else if(st.isDirectory())walk(q,rel);else throw Error('unsafe existing view')}};walk(root);if(found.length!==x.skills.length||found.some(([slug,target])=>!x.skills.some(s=>s.slug===slug&&p.resolve(p.dirname(inside(root,...slug.split('/'))),target)===inside(store,s.manifestSha256))))throw Error('unsafe existing view')}}
if(x.delivery.kind==='config-dir')env[x.delivery.envVar]=inside(view,x.delivery.subdir);else if(x.delivery.kind==='skills-dir-flag'){const root=inside(view,'skills');paths=x.skills.length?[...new Set(x.skills.map(s=>p.dirname(inside(root,...s.slug.split('/')))))]:[root]}else paths=x.skills.map(s=>inside(store,s.manifestSha256));process.stdout.write(JSON.stringify({skillPaths:paths,env}));`;

const CLEANUP_SCRIPT = COMMON + String.raw`const transfers=inside(x.cacheDir,'.transfers');safeDir(transfers);fs.rmSync(inside(transfers,x.transferId),{recursive:true,force:true});`;
