import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  extensionOf,
  imageMimeForFile,
  isHtmlFile,
  isMarkdownFile,
  isPdfFile,
  isRenderableFile,
  languageForFile,
} from "../src/lib/fileKinds.js";

describe("extensionOf", () => {
  it("lowercases the extension and ignores directory dots", () => {
    assert.equal(extensionOf("docs/Plan.MD"), "md");
    assert.equal(extensionOf("some.dir/file"), "");
  });

  it("treats dotfiles and extensionless names as extensionless", () => {
    assert.equal(extensionOf(".gitignore"), "");
    assert.equal(extensionOf("README"), "");
  });

  it("recognizes Dockerfile by name", () => {
    assert.equal(extensionOf("dockerfile"), "dockerfile");
    assert.equal(extensionOf("build/Dockerfile"), "dockerfile");
  });
});

describe("languageForFile", () => {
  it("maps known extensions and returns null for unknown ones", () => {
    assert.equal(languageForFile("app.tsx"), "tsx");
    assert.equal(languageForFile("notes.md"), "markdown");
    assert.equal(languageForFile("data.bin"), null);
  });
});

describe("rendered-preview classifiers", () => {
  it("flags markdown and html as renderable", () => {
    assert.equal(isMarkdownFile("a.markdown"), true);
    assert.equal(isHtmlFile("page.HTM"), true);
    assert.equal(isRenderableFile("a.md"), true);
    assert.equal(isRenderableFile("icons/Logo.SVG"), true);
    assert.equal(isRenderableFile("style.css"), false);
  });
});

describe("imageMimeForFile", () => {
  it("maps image extensions to their MIME types", () => {
    assert.equal(imageMimeForFile("logo.png"), "image/png");
    assert.equal(imageMimeForFile("photo.JPG"), "image/jpeg");
    assert.equal(imageMimeForFile("icon.svg"), "image/svg+xml");
  });

  it("returns null for non-images", () => {
    assert.equal(imageMimeForFile("archive.zip"), null);
    assert.equal(imageMimeForFile("doc.pdf"), null);
  });
});

describe("isPdfFile", () => {
  it("flags pdf files only", () => {
    assert.equal(isPdfFile("report.pdf"), true);
    assert.equal(isPdfFile("report.PDF"), true);
    assert.equal(isPdfFile("report.pdfx"), false);
  });
});
