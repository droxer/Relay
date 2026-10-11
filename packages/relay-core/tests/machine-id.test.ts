import { describe, it, mock } from "node:test";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMachineId, hostFingerprintPath, machineIdPath, readMachineId } from "../src/machine-id.js";

function withTempHome(fn: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), "relay-machine-"));
  try {
    fn(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe("ensureMachineId", () => {
  it("prefers an explicit value without persisting", () => {
    withTempHome((home) => {
      const resolution = ensureMachineId("mch_explicit", home);
      assert.equal(resolution.machineId, "mch_explicit");
      assert.equal(resolution.source, "explicit");
      assert.equal(readMachineId(home), undefined);
    });
  });

  it("generates and persists an id on first resolve", () => {
    withTempHome((home) => {
      const resolution = ensureMachineId(undefined, home);
      assert.equal(resolution.source, "generated");
      assert.match(resolution.machineId, /^mch_/);
      assert.equal(readFileSync(machineIdPath(home), "utf8").trim(), resolution.machineId);
    });
  });

  it("returns the same id across relaunches from the same host", () => {
    withTempHome((home) => {
      const first = ensureMachineId(undefined, home);
      const second = ensureMachineId(undefined, home);
      assert.equal(second.source, "file");
      assert.equal(second.machineId, first.machineId);
    });
  });

  it("treats blank explicit values as unset", () => {
    withTempHome((home) => {
      const resolution = ensureMachineId("   ", home);
      assert.equal(resolution.source, "generated");
      assert.match(resolution.machineId, /^mch_/);
    });
  });

  it("keeps the id when the host fingerprint is unchanged", () => {
    withTempHome((home) => {
      const host = () => "fp-a";
      const first = ensureMachineId(undefined, home, { readHostFingerprint: host });
      const second = ensureMachineId(undefined, home, { readHostFingerprint: host });
      assert.equal(second.source, "file");
      assert.equal(second.machineId, first.machineId);
    });
  });

  it("mints a new id when the home directory was cloned onto another host", () => {
    withTempHome((home) => {
      const original = ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-a" });
      const clone = ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-b" });
      assert.equal(clone.source, "regenerated");
      assert.notEqual(clone.machineId, original.machineId);
      assert.equal(readMachineId(home), clone.machineId);
      const again = ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-b" });
      assert.equal(again.machineId, clone.machineId);
    });
  });

  it("adopts a legacy id without a recorded fingerprint instead of replacing it", () => {
    withTempHome((home) => {
      mkdirSync(join(home, ".relay"), { recursive: true });
      writeFileSync(machineIdPath(home), "mch_legacy\n");
      const resolution = ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-a" });
      assert.equal(resolution.machineId, "mch_legacy");
      assert.equal(resolution.source, "file");
      assert.notEqual(readFileSync(hostFingerprintPath(home), "utf8").trim(), "");
      const moved = ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-b" });
      assert.notEqual(moved.machineId, "mch_legacy");
    });
  });

  it("keeps the id when the host fingerprint cannot be read", () => {
    withTempHome((home) => {
      const first = ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-a" });
      const unreadable = ensureMachineId(undefined, home, { readHostFingerprint: () => undefined });
      assert.equal(unreadable.machineId, first.machineId);
    });
  });

  it("falls back to the host fingerprint, not the hostname, when home is unwritable", () => {
    withTempHome((home) => {
      writeFileSync(join(home, ".relay"), "not a directory");
      const a = ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-a" });
      const b = ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-b" });
      assert.equal(a.source, "fallback");
      assert.match(a.machineId, /^host_/);
      assert.notEqual(a.machineId, b.machineId);
    });
  });

  for (const operation of ["readFileSync", "writeFileSync"] as const) {
    it(`preserves a legacy id when fingerprint ${operation} fails`, () => {
      withTempHome((home) => {
        mkdirSync(join(home, ".relay"), { recursive: true });
        writeFileSync(machineIdPath(home), "mch_legacy\n");
        const original = fs[operation];
        const fault = mock.method(fs, operation, (...args: unknown[]) => {
          if (String(args[0]).startsWith(hostFingerprintPath(home))) {
            throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
          }
          return Reflect.apply(original, fs, args);
        });
        syncBuiltinESMExports();
        try {
          const resolution = ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-a" });
          assert.equal(resolution.machineId, "mch_legacy");
          assert.equal(resolution.source, "file");
        } finally {
          fault.mock.restore();
          syncBuiltinESMExports();
        }
        assert.equal(ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-a" }).machineId, "mch_legacy");
      });
    });
  }

  for (const previousHost of [undefined, "fp-old"]) {
    it(`keeps a ${previousHost ? "regenerated" : "new"} id when saving its fingerprint fails`, () => {
      withTempHome((home) => {
        if (previousHost) ensureMachineId(undefined, home, { readHostFingerprint: () => previousHost });
        const original = fs.writeFileSync;
        const fault = mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
          if (String(args[0]).startsWith(hostFingerprintPath(home))) {
            throw Object.assign(new Error("Permission denied"), { code: "EACCES" });
          }
          return Reflect.apply(original, fs, args);
        });
        syncBuiltinESMExports();
        let identity: string;
        try {
          const resolution = ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-new" });
          identity = resolution.machineId;
          assert.equal(resolution.source, previousHost ? "regenerated" : "generated");
          assert.equal(readMachineId(home), identity);
          assert.equal(ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-new" }).machineId, identity);
        } finally {
          fault.mock.restore();
          syncBuiltinESMExports();
        }
        assert.equal(ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-new" }).machineId, identity);
      });
    });
  }

  it("adopts the replacement when another daemon regenerates between its file reads", () => {
    withTempHome((home) => {
      const original = ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-old" });
      const read = fs.readFileSync;
      let replacement: string | undefined;
      let interleaved = false;
      const fault = mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
        const value = Reflect.apply(read, fs, args);
        if (args[0] === machineIdPath(home) && !interleaved) {
          interleaved = true;
          replacement = ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-new" }).machineId;
        }
        return value;
      });
      syncBuiltinESMExports();
      try {
        const resolution = ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-new" });
        assert.notEqual(replacement, original.machineId);
        assert.equal(resolution.machineId, replacement);
        assert.equal(readMachineId(home), replacement);
      } finally {
        fault.mock.restore();
        syncBuiltinESMExports();
      }
    });
  });

  it("concurrent cloned-host starts adopt one persisted id", async () => {
    const home = mkdtempSync(join(tmpdir(), "relay-machine-race-"));
    try {
      const original = ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-old" });
      const moduleUrl = new URL("../src/machine-id.js", import.meta.url).href;
      const workerUrl = new URL("./fixtures/machine-id-worker.mjs", import.meta.url);
      // Fixtures are source assets, so locate them from the repository root when compiled.
      const workerPath = workerUrl.pathname.includes("/dist/")
        ? new URL("../../../../packages/relay-core/tests/fixtures/machine-id-worker.mjs", import.meta.url)
        : workerUrl;
      const run = (slot: string) => new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(workerPath), moduleUrl, home, slot]);
        let output = "";
        let errors = "";
        child.stdout.on("data", (data) => { output += data; });
        child.stderr.on("data", (data) => { errors += data; });
        child.on("error", reject);
        child.on("exit", (code) => code === 0 ? resolve(JSON.parse(output).machineId) : reject(new Error(errors)));
      });
      const ids = await Promise.all([run("1"), run("2")]);
      assert.equal(ids[0], ids[1]);
      assert.notEqual(ids[0], original.machineId);
      assert.equal(readMachineId(home), ids[0]);
      assert.equal(ensureMachineId(undefined, home, { readHostFingerprint: () => "fp-new" }).machineId, ids[0]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
