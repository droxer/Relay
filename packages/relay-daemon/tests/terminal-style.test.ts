import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { colorEnabled, terminalStyle } from "../src/terminal-style.js";

const ESC = "\x1b[";

describe("terminal style", () => {
  it("colors only a terminal, and honors NO_COLOR, FORCE_COLOR, and dumb terminals", () => {
    assert.equal(colorEnabled({ isTTY: true }, {}), true);
    assert.equal(colorEnabled({ isTTY: false }, {}), false);
    assert.equal(colorEnabled({ isTTY: true }, { NO_COLOR: "1" }), false);
    assert.equal(colorEnabled({ isTTY: true }, { TERM: "dumb" }), false);
    assert.equal(colorEnabled({ isTTY: false }, { FORCE_COLOR: "1" }), true);
    assert.equal(colorEnabled({ isTTY: true }, { FORCE_COLOR: "0" }), false);
  });

  it("leaves text exactly as it was when color is off: no escape codes, no marks", () => {
    const style = terminalStyle(false, "darwin", {});
    for (const format of [style.success, style.step, style.warn, style.error, style.heading, style.command, style.link, style.muted, style.notice]) {
      assert.equal(format("Heads up\n  run this"), "Heads up\n  run this");
    }
  });

  it("speaks the web palette: blue for live, orange for what needs you, crimson for failure", () => {
    const style = terminalStyle(true, "linux", {});
    assert.match(style.warn("Sign in"), /^\x1b\[1m\x1b\[38;5;208m! Sign in/);
    assert.match(style.step("Polling"), /^\x1b\[38;5;75m›/);
    assert.equal(style.link("x"), `${ESC}38;5;75m${ESC}4mx${ESC}0m`);
  });

  it("colors the headline and highlights a notice's commands without touching their text", () => {
    const style = terminalStyle(true, "linux", {});
    assert.equal(style.success("Done"), `${ESC}1m${ESC}38;5;75m✓${ESC}0m ${ESC}1mDone${ESC}0m`);
    assert.match(style.error("Failed\ndetail"), /^\x1b\[1m\x1b\[38;5;204m✗ Failed\x1b\[0m\ndetail$/);
    const notice = style.notice("Not on PATH.\n  echo 'x' >> ~/.zshrc\nThen open a new terminal.");
    assert.equal(notice.replace(/\x1b\[[0-9;]*m/g, ""), "! Not on PATH.\n  echo 'x' >> ~/.zshrc\nThen open a new terminal.");
    assert.match(notice, /^\x1b\[1m\x1b\[38;5;208m! Not on PATH\./);
    assert.match(notice, /\n  \x1b\[38;5;75mecho 'x' >> ~\/\.zshrc\x1b\[0m\n/);
    assert.equal(style.verdict("OK", true), `${ESC}1m${ESC}38;5;75mOK${ESC}0m`);
    assert.equal(style.verdict("FAIL", false), `${ESC}1m${ESC}38;5;204mFAIL${ESC}0m`);
    assert.equal(terminalStyle(false).verdict("FAIL", false), "FAIL");
  });

  it("uses ASCII marks in a legacy Windows console", () => {
    const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");
    assert.equal(plain(terminalStyle(true, "win32", {}).success("Done")), "+ Done");
    assert.equal(plain(terminalStyle(true, "win32", { WT_SESSION: "1" }).success("Done")), "✓ Done");
  });
});
