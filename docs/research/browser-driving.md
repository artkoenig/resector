# Driving a browser from Bun without new dependencies

Research for [#144](https://github.com/artkoenig/resector/issues/144) (map [#143](https://github.com/artkoenig/resector/issues/143)). Date: 2026-11-20. Local setup for the spikes: macOS, Bun 1.4.2, Google Chrome 157.0.8103.79.

## Answer

Four ways, not three: Bun itself now ships a browser driver, `Bun.WebView` (experimental, since Bun 1.3.12).

| | Own CDP client | `Bun.WebView` (chrome backend) | Playwright / playwright-core | External CLI (agent-browser, playwright-cli) |
|---|---|---|---|---|
| New npm deps | none | none (needs `engines.bun >= 1.3.12`, today `>=1.3.7`) | `playwright-core` (14 MB unpacked) | none in package.json; a global install on the user's machine |
| Browser download | none, uses installed Chrome/Chromium | none, uses installed Chrome | none with `channel: "chrome"`; else ~280 MB Chromium | agent-browser: Chrome for Testing via `agent-browser install`; playwright-cli: Playwright's browsers, Node 20+ |
| Headed | yes (drop `--headless`) | not by itself (`headless: false` throws); yes when it connects to a Chrome resector launched headed | yes | yes (`--headed`) |
| AX tree + refs | `Accessibility.getFullAXTree` (experimental domain), refs = `backendDOMNodeId`, own formatter | same, through `view.cdp()` | `page.ariaSnapshot({ mode: "ai" })` → `[ref=eN]`, `page.getByRef()` | built in: `snapshot -i` → `@eN` / `snapshot` → `eN` |
| Click a ref | `DOM.getBoxModel` + `Input.dispatchMouseEvent` | `view.cdp(...)` the same way, or `view.click(x, y)` | `getByRef(ref).click()` with actionability checks | `click @e3` with actionability checks |
| Console errors | `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded` | `console` option + CDP events | `page.on("console")`, `page.on("pageerror")` | `console`, `errors` commands |
| Risk | own code (~200 lines), experimental AX domain | experimental API, one Chrome per Bun process | known Bun hangs with Playwright on 1.3.x | output and flags owned by a third party; extra install; process per command |

**Recommendation:** an own small CDP client over Bun's global `WebSocket` against the installed Chrome/Chromium (option 1). It was the only one that met every requirement in the spike with zero new dependencies, headed and headless, on any Bun version resector supports. Two things stay open. Watch `Bun.WebView` as a later replacement for the transport: it needs `engines` raised to 1.3.12, it is experimental, and it can't launch headed. Keep the snapshot formatter resector's own in either case, in the Playwright `ai` style (`- role "name" [ref=eN]`). That format is what agent-browser and playwright-cli both use, so models already know it.

## 1. Own CDP client over Bun's WebSocket

### Dependencies

- Bun implements the global `WebSocket` class as a client ([Bun docs, WebSockets](https://bun.com/docs/runtime/http/websockets)). Bun can also spawn the browser (`Bun.spawn`) and serve test pages (`Bun.serve`). Nothing to install.
- The browser must be installed: Google Chrome, Chromium, or Edge/Brave (all speak CDP).

### Finding and launching the browser

- **macOS:** `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (also `Chromium.app`, `~/Applications/...`). **Linux:** `$PATH` names `google-chrome-stable`, `google-chrome`, `chromium`, `chromium-browser`, plus `/usr/bin/...` and `/snap/bin/...`. Bun's own search order for `Bun.WebView` is a good list to copy: explicit path, then `BUN_CHROME_PATH`, then `$PATH` names, then standard install dirs, then Playwright's cache ([Bun docs, WebView](https://bun.com/docs/runtime/webview)).
- **Flags:** `--remote-debugging-port=0 --user-data-dir=<temp dir> --no-first-run --no-default-browser-check [--headless] about:blank`.
  - `--user-data-dir` is mandatory. Since Chrome 136, `--remote-debugging-port` and `--remote-debugging-pipe` "will no longer be respected if attempting to debug the default Chrome data directory" ([Chrome blog](https://developer.chrome.com/blog/remote-debugging-port)). A temp dir also keeps the user's profile, cookies and extensions out of it.
  - `--headless` is "new headless", the same browser as headed. The old implementation has lived only in the separate `chrome-headless-shell` binary since Chrome 132 ([Chrome docs, Headless](https://developer.chrome.com/docs/chromium/headless)). Headed vs. headless is therefore one flag, and behaviour matches.
  - Linux headed needs a display (`DISPLAY` / `WAYLAND_DISPLAY`). Without one, fall back to `--headless`, as a Headless Run does anyway.
- **Discovering the WS endpoint:** with `--remote-debugging-port=0`, Chrome picks a free port and writes `DevToolsActivePort` into the user-data-dir. The file has two lines: `<port>` and `/devtools/browser/<id>`. Connect to `ws://127.0.0.1:<port><path>`. The same file format is documented in Bun's `WebView` types (`node_modules/bun-types/bun.d.ts`, `Backend.url`). No HTTP `/json/version` call or port polling is needed.
- Alternative transport: `--remote-debugging-pipe` (fds 3/4, NUL-separated JSON), used by Playwright and by `Bun.WebView`. It has no open port, but extra stdio fds under Bun are a known source of hangs (see Playwright below). The port + `127.0.0.1` approach was used in the spike.

**Spike:** headless and headed launches both reached the WS endpoint, in 0.2 to 1.2 s. The spike attached with `Target.getTargets` → `Target.attachToTarget({ flatten: true })`, then sent every page command with that `sessionId` on the one browser socket.

### Accessibility tree and refs

- `Accessibility.getFullAXTree({ depth?, frameId? })` returns a flat list of `AXNode`s with `nodeId`, `ignored`, `role`, `name`, `value`, `properties`, `childIds` and `backendDOMNodeId`. Related: `getPartialAXTree`, `queryAXTree({ accessibleName, role })` and `getChildAXNodes`. The whole Accessibility domain and these commands are marked **experimental** ([CDP Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/), checked against `json/browser_protocol.json` in [ChromeDevTools/devtools-protocol](https://github.com/ChromeDevTools/devtools-protocol)). Puppeteer and Playwright depend on it, so it is de facto stable, but it can change without notice.
- **Refs:** number the kept nodes `e1…eN` and map each ref to its `backendDOMNodeId`. All DOM and Input commands accept `backendNodeId`, so no DOM tree walk is needed. Refs stay valid until the node is replaced or the page navigates. After that, take a new snapshot (agent-browser documents the same rule: [Snapshots](https://agent-browser.dev/snapshots)).
- **Format:** the raw JSON is far too big (see sizes). The spike reduced it to Playwright-style lines. It skips ignored nodes and drops structural roles (`generic`, `none`, `paragraph`, `group`, layout-table roles, `InlineTextBox`) while keeping their children. It prints `StaticText` as `- text: …` only when it differs from the parent's name, and cuts names to 100 characters:

  ```
  - heading "Todo" [ref=e1]
  - textbox "New todo" [ref=e2]
    - text: milk
  - button "Add" [ref=e3]
  - list [ref=e4]
    - listitem [ref=e5]
      - text: milk
  ```

### Screenshots

`Page.captureScreenshot({ format: "png" | "jpeg" | "webp", quality?, clip?, captureBeyondViewport? })` returns base64 (stable). That is the payload for an Image block, with no extra encoding step. In the spike, an 800×600 PNG of a small page was 6 KiB.

### Input

- **Click a ref:** `DOM.scrollIntoViewIfNeeded({ backendNodeId })` → `DOM.getBoxModel({ backendNodeId })`, centre of the `content` quad → `Input.dispatchMouseEvent` `mousePressed` + `mouseReleased` (`button: "left", clickCount: 1`). These are trusted events at real coordinates, so overlays block them, as they would block a user. resector should report "covered by …" rather than fake success. One way is `DOM.getNodeForLocation` at the point, compared with the target.
- **Type:** `DOM.focus({ backendNodeId })` + `Input.insertText({ text })` (experimental, fires `input` without key events), or `Input.dispatchKeyEvent` per character with `text`.
- **Keys:** `Input.dispatchKeyEvent` `keyDown`/`keyUp` with `key`, `code`, `windowsVirtualKeyCode` and `modifiers`. resector would need a small table for Enter, Tab, Escape, arrows and Backspace.
- `DOM.*`, `Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Page.navigate` and `Page.captureScreenshot` are stable. `Input.insertText` and `DOM.getContentQuads` are experimental ([CDP](https://chromedevtools.github.io/devtools-protocol/)).

**Spike:** the spike focused the textbox ref, inserted "milk", clicked the button ref and pressed Tab. The new snapshot then showed the added list item.

### Console errors

Enable `Runtime` and `Log`. Then collect `Runtime.consoleAPICalled` (`type`, `args[]` as RemoteObjects; use `value ?? description`), `Runtime.exceptionThrown` (`exceptionDetails.exception.description`, i.e. uncaught errors) and `Log.entryAdded` (network failures, CSP, intervention messages). All are stable. Buffer them per page, and hand back "new since the last call".

**Spike output:** `console.log: boot`, `exception: Error: boom`, `console.error: added milk`.

### Cost

The whole spike, from launch through snapshot, refs, input, console and screenshot, is ~170 lines of TypeScript with no types from `devtools-protocol`.

## 2. `Bun.WebView` (Bun's built-in driver)

- **Status:** experimental, added in Bun 1.3.12. `class WebView` is absent from `bun-types@1.3.11` and present from `1.3.12` on. resector pins `engines.bun >= 1.3.7`, so it would need a bump. Its docs say "This API is experimental and may change in future releases" ([Bun docs, WebView](https://bun.com/docs/runtime/webview)).
- **Backends:** `"webkit"` (macOS only, system WKWebView, the default there) and `"chrome"` (CDP over `--remote-debugging-pipe`, auto-detected binary; `path`/`argv`/`BUN_CHROME_PATH`). Default Chrome flags: `--remote-debugging-pipe --headless --no-first-run --no-default-browser-check --disable-gpu --user-data-dir=<temp>`. **One Chrome per Bun process**: the first view's path, argv and data dir win (`bun-types/bun.d.ts`).
- **Headed:** "Only `true` is implemented; `false` throws." Workaround, tested: resector launches headed Chrome itself and passes `backend: { type: "chrome", url: "ws://127.0.0.1:<port><path>" }`. Without `path`/`url`, it **auto-connects to any Chrome that has a `DevToolsActivePort`**. That could be the user's own debugging Chrome, so always pass `url: false` or an explicit `url`.
- **API:** `navigate`, `evaluate`, `screenshot` (png/jpeg/webp, blob/buffer/base64), `click(x, y)` / `click(selector)` with actionability waits, `type`, `press`, `scroll`, `resize`, `back`/`forward`/`reload`, and a `console` capture callback. It has **no accessibility tree or refs**. The chrome backend has `view.cdp(method, params)` and `addEventListener("Domain.event")`, so the AX tree, ref clicks and `Runtime.exceptionThrown` go through raw CDP exactly as in option 1.
- **Spike** (chrome backend, headless and connected to a headed Chrome): `getFullAXTree` via `view.cdp`, `type`, `click`, `press`, console capture, an exception via a CDP event and a screenshot all worked. Ready in 0.3 to 0.6 s.
- **Open issues:** it can't hold isolated contexts in one process, and the WebKit backend is macOS only ([oven-sh/bun#48157](https://github.com/oven-sh/bun/issues/48157)). It is also slower than Playwright for navigate and screenshot ([oven-sh/bun#48010](https://github.com/oven-sh/bun/issues/48010)).
- **Verdict:** it saves the transport and launch code from option 1 (~60 of the ~170 lines). The snapshot, refs, ref clicks and console handling stay resector's own, and headed still needs resector's launcher. It isn't worth an experimental-API dependency and an engines bump yet. Revisit when it gains headed mode or AX support.

## 3. Playwright / playwright-core

- **Dependencies:** `playwright-core@1.65.1` is 14 MB unpacked, with no further npm deps. `playwright` adds the test runner (5 MB). Both are new dependencies, which the project convention rules out without a reason.
- **Browsers:** `npx playwright install [--with-deps] chromium` downloads into `~/Library/Caches/ms-playwright` (macOS) or `~/.cache/ms-playwright` (Linux); `PLAYWRIGHT_BROWSERS_PATH` moves it. The docs' sample listing shows Chromium at 281 MB. Headless uses a separate headless shell unless `channel: "chromium"`. `channel: "chrome"` uses the installed Google Chrome, with no download ([Playwright, Browsers](https://playwright.dev/docs/browsers)). `executablePath` is "use at your own risk". `connectOverCDP` is "significantly lower fidelity" ([BrowserType](https://playwright.dev/docs/api/class-browsertype#browser-type-connect-over-cdp)).
- **Headed/headless:** `launch({ headless: false })`, with the default `true`.
- **AX tree + refs:** `page.ariaSnapshot({ mode: "ai", depth?, boxes? })` (v1.59). It returns YAML with `[ref=eN]` and includes iframes. `page.getByRef("e2")` (v1.64) resolves against the latest snapshot ([Page API](https://playwright.dev/docs/api/class-page#page-aria-snapshot), [Aria snapshots](https://playwright.dev/docs/aria-snapshots)). This is the format agent tools copy.
- **Screenshots / input / console:** `page.screenshot()`; `locator.click()`, `fill()` and `press()` with auto-waiting and actionability; `page.on("console")`, `page.on("pageerror")`.
- **On Bun:** open reports exist. Repeated launch/close hangs forever on Bun 1.3.x because of double-closed stdio fds with `--remote-debugging-pipe` (fixed by 1.4.4) ([oven-sh/bun#47956](https://github.com/oven-sh/bun/issues/47956)). `recordHar` deadlocks the event loop on Bun ([#30652](https://github.com/oven-sh/bun/issues/30652)). resector would run on a runtime Playwright isn't developed against.
- **Verdict:** the best snapshot and actionability for free, but it breaks the no-dependency rule and adds Bun-compat risk. Its `ai` format is still worth copying.

## 4. External CLI through bash

### Vercel agent-browser ([README](https://github.com/vercel-labs/agent-browser), v0.43.0, Apache-2.0)

- Native Rust CLI with a background daemon per `--session`. It drives the browser over CDP and closes an idle headless browser after 1 h. Install with `npm i -g agent-browser` / `brew install agent-browser`, then `agent-browser install` (downloads Chrome for Testing; `--with-deps` on Linux). It can attach to a running Chrome (`--cdp`, `--auto-connect`) or use `--executable-path`.
- `--headed` shows the window. `snapshot -i` gives interactive elements only, `-c` compact, `-d N` depth, `-s <css>` scope. Refs look like `@e1`; `click @e1`, `fill`, `type`, `press Enter`, `keyboard type`. `screenshot [--annotate]`, `console` and `errors` cover the rest ([Commands](https://agent-browser.dev/commands), [Snapshots](https://agent-browser.dev/snapshots)). A click fails rather than reporting success when the target is hidden or covered.

### Microsoft playwright-cli ([README](https://github.com/microsoft/playwright-cli), `@playwright/cli` v0.1.25) / Playwright MCP ([README](https://github.com/microsoft/playwright-mcp))

- Needs Node 20+ and depends on `playwright` + `playwright-core` (alpha builds). Headless by default; `open --headed`. Sessions with `-s`, idle timeout 1 h. Commands: `snapshot [--depth]`, `find <text>`, `click/fill/press/check <ref>`, `screenshot [ref]`, `console [min-level]`. It writes the snapshot to `.playwright-cli/page-*.yml` and only returns a link, which the README calls token-efficient.
- The MCP variant is a server with its own tool schemas. That fits resector poorly (no MCP client; tools belong in the Tools Block).

### Verdict

- These CLIs need zero code in resector, but they fail the "dedicated tool in the Tools Block" decision of #143. They would be a Skill over bash: the model must learn a third-party CLI, and its output format and flags change with releases resector doesn't control.
- They also need a global install plus a browser download on every user's machine (Node for playwright-cli), and they cost a shell round-trip per action.
- A Headless Run would also lose the "no browser installed" answer to whatever the CLI prints.

## Snapshot size

Measured with the spike formatter on live pages. Tokens are estimated at 4 characters per token; local tokenizers often get 3–3.5, so add ~20 %. "Interactive" counts only lines for link, button, textbox, combobox, checkbox, radio, menuitem, tab, option, switch and slider.

| Page | AX nodes | Raw `getFullAXTree` JSON | Compact snapshot | Interactive only |
|---|---|---|---|---|
| Local todo app (h1, input, button, list) | 11 | — | 8 lines | — |
| bun.com/docs | 1,073 | 394 KiB (~100k tok) | 498 lines, ~5k tok | 125 lines, ~1k tok |
| news.ycombinator.com (front page) | 1,624 | 615 KiB (~157k tok) | 672 lines, ~5k tok | 230 lines, ~2k tok |
| github.com/oven-sh/bun | 3,478 | 1.3 MiB (~324k tok) | 1,477 lines, ~15k tok | 403 lines, ~5k tok |
| MDN `<input>` reference | 9.8k–18.9k (lazy content) | 3.4–7.5 MiB | 5–9k lines, ~47–100k tok | 1,513 lines, ~22k tok |

Takeaways:

- The raw JSON is never an option. A filtered tree is 1–2 % of it.
- A typical dev-server page of the app being written (a form, a list, a nav) lands at a few hundred tokens up to ~5k compact. Content-heavy pages need limits.
- Limits worth building in: depth, scope to a ref (`getPartialAXTree` / subtree of the formatter), interactive-only, a hard token cap with a "truncated, narrow with …" note, and a `find <text>` style query (`Accessibility.queryAXTree`). Playwright, agent-browser and playwright-cli all offer depth and scope controls; agent-browser adds interactive-only and playwright-cli adds `find`.

## Spike sources

Throwaway scripts (not committed), run against the local Chrome 157:

- Own CDP client: `Bun.serve` test page, `Bun.spawn` Chrome with `--remote-debugging-port=0 --user-data-dir=<tmp> [--headless]`, read `DevToolsActivePort`, `new WebSocket(...)`, flattened target session, `Accessibility.getFullAXTree`, the formatter above, ref click via `DOM.getBoxModel` + `Input.dispatchMouseEvent`, `Input.insertText`, `Input.dispatchKeyEvent`, `Page.captureScreenshot`, console events. Headless and headed both worked.
- `Bun.WebView`: `backend: { type: "chrome", url: false, path }` headless, and `backend: { type: "chrome", url: <ws of a headed Chrome launched by the script> }`; `view.cdp("Accessibility.getFullAXTree")`, `type`/`click`/`press`, `console` capture, `Runtime.exceptionThrown` via `addEventListener`, `screenshot`. Both worked.
