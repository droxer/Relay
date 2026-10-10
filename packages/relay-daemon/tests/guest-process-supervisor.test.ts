import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { GUEST_PROCESS_SUPERVISOR } from "../src/guest-process-supervisor.js";

for (const cancel of [false, true]) {
  test(`guest supervisor removes TERM-ignoring descendants when ${cancel ? "cancelled" : "parent exits"}`, {skip: process.platform === "win32", timeout: 5000}, async () => {
    const childCode = 'process.on("SIGTERM",()=>{}); process.send("ready"); setInterval(()=>{},1000)';
    const parentCode = `const{spawn}=require("node:child_process");const c=spawn(process.execPath,["-e",${JSON.stringify(childCode)}],{stdio:["ignore","inherit","inherit","ipc"]}); c.on("message",()=>{process.stdout.write(String(c.pid)+"\\n");${cancel ? '' : 'process.exit(0);'}});setInterval(()=>{},1000);`;
    const supervisor = spawn(process.execPath, ["-e", GUEST_PROCESS_SUPERVISOR, process.execPath, "-e", parentCode], {env:{...process.env,RELAY_PROCESS_STOP_GRACE_MS:"20"}});
    let pid = 0;
    let stderr = "";
    supervisor.stderr.on("data", chunk => { stderr += chunk; });
    supervisor.stdout.on("data", chunk => { pid = Number(String(chunk).trim()); if (cancel) supervisor.kill("SIGTERM"); });
    try {
      const code = await new Promise<number | null>((resolve, reject) => { supervisor.once("error",reject); supervisor.once("close",resolve); });
      assert.ok(pid > 0, stderr);
      assert.equal(code, cancel ? 130 : 0, stderr);
      assert.throws(() => process.kill(pid,0), /ESRCH/);
    } finally {
      supervisor.kill("SIGKILL");
      if (pid) { try { process.kill(pid,"SIGKILL"); } catch {} }
    }
  });
}
