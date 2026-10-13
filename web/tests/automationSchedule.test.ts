import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SCHEDULE_PRESETS, presetOf, repeatForPreset, scheduleError } from "../src/lib/automationSchedule.ts";

describe("automationSchedule", () => {
  it("round-trips every preset", () => {
    for (const preset of SCHEDULE_PRESETS) assert.equal(presetOf(repeatForPreset(preset)), preset);
  });
  it("keeps the time when switching day → weekday", () => {
    assert.deepEqual(repeatForPreset("weekday", { every: "day", at: "07:45" }), { every: "weekday", at: "07:45" });
  });
  it("flags each bad field", () => {
    assert.equal(scheduleError({ timezone: null, repeat: { every: "day", at: "25:00" } }), "automation.errors.time");
    assert.equal(scheduleError({ timezone: null, repeat: { every: "week", at: "09:00", days: [] } }), "automation.errors.days");
    assert.equal(scheduleError({ timezone: null, repeat: { every: "month", at: "09:00", day: 0 } }), "automation.errors.month_day");
    assert.equal(scheduleError({ timezone: null, repeat: { once: "soon" } }), "automation.errors.once");
    assert.equal(scheduleError({ timezone: null, repeat: { every: "hour", minute: Number.NaN } }), "automation.errors.minute");
    assert.equal(scheduleError({ timezone: null, repeat: { every: "hour", minute: 0 } }), null);
    assert.equal(scheduleError({ timezone: null, repeat: { every: "month", at: "09:00", day: Number.NaN } }), "automation.errors.month_day");
    assert.equal(scheduleError({ timezone: null, repeat: { cron: "* *" } }), "automation.errors.cron");
    assert.equal(scheduleError({ timezone: "UTC", repeat: { every: "weekday", at: "09:00" } }), null);
  });
});
