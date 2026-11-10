# SVG file preview

Journeys derived from the request: open a generated SVG as an image and switch
between its preview and source, including files reported as plain text, XML,
unknown binary content, or with no MIME type.

## Evidence

- RED: `npm run test:react -w web -- interaction-tests/artifactSvgPreview.test.tsx`
  ran seven new tests; all seven failed because SVG lacked a render mode and
  files reported as text displayed source instead of an image.
- GREEN: `npm run test:react -w web -- interaction-tests/artifactSvgPreview.test.tsx interaction-tests/workspaceImagePreview.test.tsx interaction-tests/artifactsDrawer.test.tsx`
  passed all 20 tests, including eight new SVG cases.
- `npx tsc -p packages/tsconfig.json` and `npx tsc --noEmit -p web/tsconfig.json`
  passed. The 33 built artifact-preview and file-kind unit tests passed.
- ESLint passed for the two changed production files. `git diff --check` passed.

| Guarantee | Evidence |
| --- | --- |
| SVG filenames work with absent or generic MIME types, including uppercase extensions | SVG classification cases |
| SVG MIME types work without an extension | MIME-only classification case |
| Unicode and reserved URL characters survive image encoding | Exact source encoding compared with image data URL |
| SVG markup is isolated in an image, rather than inserted into the app document | Image rendering test with script-bearing SVG |
| The task file pane offers working Preview and Source controls | RecordArtifactPreview interaction test |
| Existing workspace SVG and PNG previews continue to work | workspaceImagePreview tests |

`npm exec -w web -- next build --webpack` passed, including static export.
`npm exec -w web -- playwright test -c playwright.recovery.config.ts tasksWorkspace.spec.ts -g 'SVG task'`
passed both desktop and phone cases. Each checks actual image decoding, verifies
the embedded script did not execute, and exercises Source/Preview controls.
The complete web E2E suite then passed: 214 tests in 1.3 minutes, using
`npm exec -w web -- playwright test -c playwright.recovery.config.ts` against
the webpack export. Desktop and phone SVG screenshots were visually checked.

Full `npm test` was attempted twice; Next.js Turbopack could not bind its local
worker port (`Operation not permitted`), so the combined command stopped at the
web build. Direct broad Node, React, and Python runs were also attempted and
stopped before completion. React reported an unrelated execution-recovery
notice assertion failure; the Node suite hit process/socket restrictions.
Project-wide coverage has not been verified.
Separate checkpoint commits were not created; the RED/GREEN evidence is
preserved above for the single implementation commit requested by the user.
