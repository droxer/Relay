import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const readers = [
  { module: "round-result", fn: "readRoundResult", file: "round-result.json", expected: { value: { kind: "rejected", reason: "malformed" } } },
  { module: "next-steps", fn: "consumeNextSteps", file: "next-steps.json", expected: { value: [] } },
  { module: "project-setup", fn: "consumeProjectSetup", file: "project-setup.json", expected: {} },
];
for (const reader of readers) {
  for (const kind of ["fifo", "symlink", "directory-link"] as const) {
    test(`${reader.module} safely refuses a ${kind} control file`, { skip: kind === "fifo" && process.platform === "win32" }, (t) => {
      const root = mkdtempSync(join(tmpdir(), "relay-control-file-"));
      t.after(() => rmSync(root, { recursive: true, force: true }));
      const workspace = join(root, "workspace");
      const external = join(root, "external");
      mkdirSync(workspace); mkdirSync(external);
      const externalFile = join(external, reader.file);
      const content = JSON.stringify({ status: "done", nextSteps: ["private host contents"], name: "private host contents" });
      writeFileSync(externalFile, content);
      const control = join(workspace, ".relay");
      if (kind === "directory-link") symlinkSync(external, control, process.platform === "win32" ? "junction" : "dir");
      else {
        mkdirSync(control);
        if (kind === "fifo") execFileSync("mkfifo", [join(control, reader.file)]);
        else symlinkSync(externalFile, join(control, reader.file));
      }
      const module = new URL(`../src/${reader.module}.js`, import.meta.url).href;
      const script = `import { ${reader.fn} as read } from ${JSON.stringify(module)}; console.log(JSON.stringify({value:read(process.argv[1], ${JSON.stringify(`.relay/${reader.file}`)})}));`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, workspace], { encoding: "utf8", timeout: 1500 });
      assert.equal(result.error, undefined, "a control-file read must not block the daemon");
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), reader.expected);
      assert.equal(existsSync(externalFile), true);
      assert.equal(readFileSync(externalFile, "utf8"), content);
    });
  }
}

test("control-file reads enforce their byte cap and consume oversized regular files", async (t) => {
  const { consumeControlFile } = await import("../src/control-file.js");
  const root = mkdtempSync(join(tmpdir(), "relay-control-cap-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".relay"));
  const file = join(root, ".relay/report.json");
  writeFileSync(file, "12345");
  assert.deepEqual(consumeControlFile(root, ".relay/report.json", 4), { kind: "oversize" });
  assert.equal(existsSync(file), false);
  writeFileSync(file, "1234");
  assert.deepEqual(consumeControlFile(root, ".relay/report.json", 4), { kind: "read", text: "1234" });
  assert.deepEqual(consumeControlFile(root, ".relay/report.json", 4), { kind: "absent" });
  assert.deepEqual(consumeControlFile(root, "../report.json", 4), { kind: "unsafe" });
});
