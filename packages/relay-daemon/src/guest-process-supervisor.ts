/** Runs inside the existing Node-based guest. The SDK execution is the
 * supervisor, which exits only after its process group has stopped executing.
 * Detached sessions created by a workload require separate reconciliation.
 */
export const GUEST_PROCESS_SUPERVISOR = String.raw`
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [command, ...args] = process.argv.slice(1);
const configured = Number(process.env.RELAY_PROCESS_STOP_GRACE_MS);
const grace = Number.isFinite(configured) && configured > 0 ? Math.min(configured, 60000) : 5000;
const child = spawn(command, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.pipe(process.stdout, { end: false });
child.stderr.pipe(process.stderr, { end: false });
let cancelled = false;
let exited = false;
let code = 1;
let stoppedAt;
let finishing = false;
let warned = false;
const warn = message => process.stderr.write('[relay] ' + message + '\n');

function send(signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) {
    if (error.code !== 'ESRCH') warn('Process-group termination failed: ' + error.message);
  }
}

function alive() {
  if (!child.pid) return false;
  if (process.platform === 'linux') {
    // Dead children can remain as zombies under a guest init. They cannot
    // execute and must not prevent verified process-group cleanup.
    for (const name of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      let stat;
      try { stat = fs.readFileSync('/proc/' + name + '/stat', 'utf8'); }
      catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ESRCH') continue;
        throw error;
      }
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      if (Number(fields[2]) === child.pid && fields[0] !== 'Z' && fields[0] !== 'X') return true;
    }
    return false;
  }
  try { process.kill(-child.pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

function stop() {
  cancelled = true;
  if (stoppedAt === undefined) { stoppedAt = Date.now(); send('SIGTERM'); }
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
child.on('error', error => { warn('Agent spawn failed: ' + error.message); exited = true; code = 1; });
child.on('exit', status => { exited = true; code = status === null ? 1 : status; send('SIGKILL'); });
let closed = false;
child.on('close', () => { closed = true; });
const timer = setInterval(() => {
  if (finishing) return;
  if (stoppedAt !== undefined && Date.now() - stoppedAt >= grace) send('SIGKILL');
  if (!exited) return;
  try {
    if (alive()) { send('SIGKILL'); return; }
  } catch (error) {
    if (!warned) { warn('Cannot verify process-group exit; retaining execution: ' + error.message); warned = true; }
    return;
  }
  // A detached child can escape the group and keep these pipes open. Retain
  // that execution for reconciliation rather than fabricate complete cleanup.
  if (!closed) {
    if (!warned) { warn('Process group exited, but an inherited output writer remains; retaining execution for reconciliation.'); warned = true; }
    return;
  }
  finishing = true;
  clearInterval(timer);
  process.exitCode = cancelled ? 130 : code;
}, 20);
`;
