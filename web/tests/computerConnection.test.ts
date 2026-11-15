import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

import { computerConnection, connectionNeedsNotice } from "../src/lib/computerConnection.js";

const online = { online: true, stale: false, status: "ready", lastSeenAt: "2026-11-15T00:00:00.000Z", dispatchable: true } as const;
const offline = { ...online, online: false, stale: true, dispatchable: false } as const;

describe("computer connection reading", () => {
  it("is plainly online when connected, listening, and healthy", () => {
    for (const transport of [undefined, null, { state: "healthy", causes: [] }, { state: "connecting" }]) {
      const reading = computerConnection(online, transport);
      assert.equal(reading.state, "online");
      assert.equal(connectionNeedsNotice(reading), false);
    }
  });

  it("says reconnecting while the computer is alive but not taking work", () => {
    const reading = computerConnection({ ...online, dispatchable: false });
    assert.deepEqual([reading.state, reading.issue, reading.tone], ["unsettled", "not_listening", "warn"]);
    // An older backend sends no `dispatchable`; absence is not "not listening".
    assert.equal(computerConnection({ ...online, dispatchable: undefined }).state, "online");
  });

  it("says unstable while the client is retrying its reports", () => {
    const retrying = computerConnection(online, { state: "retrying", causes: [], pending: 4 });
    assert.deepEqual([retrying.state, retrying.issue, retrying.pendingReports], ["unsettled", "communication", 4]);
    const sustained = computerConnection(online, { state: "retrying", causes: ["communication"] });
    assert.deepEqual([sustained.state, sustained.issue], ["unsettled", "communication"]);
  });

  it("names the one thing the owner can fix, most actionable first", () => {
    const reading = computerConnection(online, { state: "healthy", causes: ["communication", "execution", "quarantine", "storage"], quarantined: 2 });
    assert.deepEqual([reading.state, reading.issue, reading.quarantinedReports], ["attention", "storage", 2]);
    assert.equal(computerConnection(online, { state: "healthy", causes: ["execution", "quarantine"] }).issue, "quarantine");
  });

  it("drops an incident the client reports as recovered", () => {
    assert.equal(computerConnection(online, { state: "healthy", causes: ["communication"], recovered: true }).state, "online");
  });

  it("lets liveness outrank the client's last word", () => {
    // A dark computer cannot take back its last "healthy".
    assert.equal(computerConnection(offline, { state: "healthy", causes: [] }).state, "offline");
    // A stale flag wins over a record that still says online.
    assert.equal(computerConnection({ ...online, stale: true }).state, "offline");
    // Back online means the credential works again, whatever was recorded.
    assert.equal(computerConnection(online, { state: "revoked", causes: ["revoked"] }).state, "online");
  });

  it("tells a stop and a refused credential from a lost connection", () => {
    assert.equal(computerConnection({ ...offline, status: "stopped" }).state, "stopped");
    const revoked = computerConnection({ ...offline, status: "stopped" }, { state: "revoked", causes: ["revoked"] });
    assert.deepEqual([revoked.state, revoked.tone], ["revoked", "bad"]);
    // Absence is not failure: offline and stopped stay neutral.
    assert.equal(computerConnection(offline).tone, "neutral");
    assert.equal(computerConnection({ ...offline, status: "stopped" }).tone, "neutral");
  });

  it("stays quiet about a computer that has never connected", () => {
    const reading = computerConnection({ ...offline, lastSeenAt: undefined });
    assert.equal(reading.state, "pending");
    assert.equal(connectionNeedsNotice(reading), false);
  });

  it("ignores malformed report counts", () => {
    const reading = computerConnection(online, { state: "retrying", pending: -3, quarantined: Number.NaN });
    assert.deepEqual([reading.pendingReports, reading.quarantinedReports], [0, 0]);
  });
});

describe("computer connection copy", () => {
  it("has a title and body for every state and issue in every locale", async () => {
    const names = ["offline", "stopped", "revoked", "not_listening", "communication", "storage", "quarantine", "execution"];
    for (const locale of ["en", "zh-CN", "zh-TW"]) {
      const bundle = JSON.parse(await readFile(resolve(`web/src/i18n/locales/${locale}/translation.json`), "utf8"));
      for (const name of names) {
        for (const part of ["title", "body"]) {
          assert.equal(typeof bundle.computer[`connection_${name}_${part}`], "string", `${locale} ${name} ${part}`);
        }
      }
      assert.equal(typeof bundle.computer.connection_offline_managed_body, "string");
      assert.equal(typeof bundle.computer.connection_pending_reports_other, "string");
      assert.equal(typeof bundle.nodes.presence_unsettled, "string");
    }
  });
});
