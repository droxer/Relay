import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

const [moduleUrl, home, slot] = process.argv.slice(2);
const originalRead = fs.readFileSync;
// Hold both processes after they read the old fingerprint, forcing overlapping
// regeneration instead of relying on the operating system's scheduling.
fs.readFileSync = function (path, ...args) {
  const result = originalRead.call(this, path, ...args);
  if (path === `${home}/.relay/machine-id.host`) {
    fs.writeFileSync(`${home}/ready-${slot}`, "");
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(`${home}/ready-1`) || !fs.existsSync(`${home}/ready-2`)) {
      if (Date.now() > deadline) throw new Error("Concurrent-start barrier timed out");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  return result;
};
syncBuiltinESMExports();
const { ensureMachineId } = await import(moduleUrl);
console.log(JSON.stringify(ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-new" })));
