# GenericAgent-Harness progress

Design: E:/Work/GenericAgent/temp/dsh_study_20261023/HANDOFF.md (plan A: drop-in compatible with GA).

## Constraints
- Never modify GA core (E:/Work/GenericAgent) or GA-Admin chat_worker.py.
- Atomic local commits; no push without approval.
- Test: `uv run --extra dev pytest -q`

## Done
- kernel: Scope / EventBus (emit/serial/bail/parallel/waterfall) / Context / Runtime (inject-gated lifecycle)
- loader: manifest discovery, profile extends, layered patches
- ga-hooks: bridges GA `plugins.hooks` (8 events) to `ga.<event>` waterfalls; unregisters on unload
- ga-core: hosts unmodified `agentmain.GenericAgent`, provides `agent` (run/abort) + `ga.agent`; emits agent.chunk / agent.done
- profile `ga-compat` = llm-config + ga-hooks + ga-core; CLI `gah run|tree|plugins|llm`
- llm-config: answers GA's `import mykey` with a synthetic module built from `$GAH_LLM_CONFIG`,
  `~/.ga-harness/llm.toml|json` or inline profile keys; `${ENV}` refs for secrets; `__file__` points at
  the config file so GA's mtime hot-reload keeps working. No source -> finder not installed -> GA's own mykey.py.
  `gah llm show` (masked) / `gah llm migrate --from mykey.py --out llm.toml` (user runs it; no clobber).
- ga-tools / ga-prompt: GA tools & system prompt as plugins without editing GA. ga-tools wraps
  `agentmain.load_tool_schema` (re-applied on every reload) to drop/replace schemas, hangs `do_<name>` on
  `ga.GenericAgentHandler` (disabled tools get a refusal StepOutcome), provides `ga.tools`; ga-prompt wraps
  `agentmain.get_system_prompt` (append/prepend/replace_file), provides `ga.prompt`. Both restore on dispose.
- tool-timer: first feature plugin layered purely by patch (`examples/patches/tool-timer.toml`);
  pairs tool_before/after by `id(args)`, emits `tool.timed`, provides `tool.timer.stats()`; ignores `no_tool`.

## Findings
- GA `run()` exits when a str is put on task_queue; display_queue items are {next}/{done}; `inc_out` toggles delta vs cumulative.
- Hook callbacks returning a dict replace GA's ctx.
- importing agentmain has side effects (stdout reconfigure, loads GA plugins, creates temp/).

## M0 verified (2026-10-23, real LLM via GA mykey.py)
- Run with GA's venv (harness venv has no GA deps):
  `$env:PYTHONPATH="<repo>"; E:/Work/GenericAgent/.venv/Scripts/python.exe -m ga_harness.cli run "task" --ga-root E:/Work/GenericAgent`
- Plain task: 3 turns incl. one code_run, streamed output, exit 0.
- Probe task (code_run print(1+1)): all 8 GA hook events reached `ga.*` listeners
  (agent 1/1, turn 2/1, llm 2/2, tool 2/2; tools code_run,no_tool), final "2", dispose clean.
- Not done: side-by-side diff against plain `agentmain.py` output.
- llm-config: real GenericAgent built its client list from a dummy harness TOML (`[Info] Load mykeys from
  <toml>`), finder removed on dispose. Not verified: a real LLM call through a harness config file.
- tool-timer: `gah run ... --patch examples/patches/tool-timer.toml` real run printed
  `[tool-timer] code_run 1.011s` on stderr, answer "2", exit 0.

- launcher: `gah.cmd run "3+4" --ga-root E:/Work/GenericAgent --patch examples/patches/tool-timer.toml`
  from a clean env (no PYTHONPATH/GA_ROOT) re-exec'd into GA's venv, answer "7", exit 0; `gah.cmd tree` ok.

- ga-tools/ga-prompt: `--patch examples/patches/ga-tools-prompt.toml` real run: model reported web_scan
  unavailable (schema removed) and answered the appended marker `GAH-OK`, exit 0 (27 tests).

## Usage (current)
- `gah.cmd run "task"` - ga_root from `--ga-root` > `$GA_ROOT` > `~/.ga-harness/config.toml` (`ga_root = "E:/Work/GenericAgent"`).
- `gah.cmd llm migrate E:/Work/GenericAgent/mykey.py [--out F] [--force]` (positional path, default out ~/.ga-harness/llm.toml).

## tool-grep (custom tool via ga.tools)
- `plugins/tool-grep`: harness-owned read-only `grep` tool (pattern/path/glob/ignore_case/max_results), registered with `ctx.get("ga.tools").register(SCHEMA, do_grep)`; skips .git/node_modules/.venv/binary/>2MB files; dispose removes schema + handler.
- Patch: `examples/patches/tool-grep.toml` (ga-tools after ga-core, tool-grep after ga-tools).
- Verified: 28 tests; real GA run -- model called `grep` and reported `ga.py:427` (matches actual `def do_file_read`).

## ui-web (2026-10-24)
- Plugin `ui-web`: stdlib ThreadingHTTPServer on 127.0.0.1:8765, `/api/state`, `/api/run` (202, 409 if busy), `/api/abort`, `/api/events` SSE; same-origin check; single-file index.html (textContent render, light/dark/warm from GA Admin tokens).
- Tests: tests/test_ui_web.py (fake agent); full suite 36 passed.
- Real GA verified in browser: reply streamed and finished, stop during run -> status=aborted, 3 theme colors computed, 390px no horizontal overflow. Not done: screenshot visual review.

## Output contract: ga-events only (2026-10-24)
- GA's `agent.chunk` is display text (`**LLM Running (Turn N) ...**`, tool fences, `[Stdout]`); GA's own frontends each regex it differently. Not a contract.
- `ga_harness/textview.py` `TextView`: renders run/turn/assistant/tool events as plain text; chunk only as fallback when a run emits no ga-events; `raw = true` for debug. ui-cli and ui-tui use it (`tool_lines` config).
- README documents the event table and "never regex agent.chunk". ui-web already renders events (chunk text only as fallback).
- Verified: 46 tests; real GA `gah run` printed `-- step 1: ... / > code_run print(2**20) / ok 1.0s / | 1048576 / -- step 2: ...`, no LLM Running. GA's own print() lines ([Debug]/[Cache]/code run output) still reach stdout -- they bypass the stream.

## ga-usage: token usage (2026-10-24)
- Plugin `ga-usage` (in `ga-compat`, before ga-core): wraps `llmcore._record_usage` in place (restored on unmount), reads `STATS['out']` after each call (messages protocol sets output later). Counting follows GA: `input` includes cache.
- Events `usage {turn,input,cache_read,cache_write,output}` per LLM call, `usage.total {calls,...}` at agent_after (before GA's final `done`).
- TextView prints per-step `tokens` line + run total; ui-web stores `turn.usage` / `msg.usage`, shows `in / out tok` on step rows and a total line under the reply.
- Verified: 56 tests; real GA `gah run` and ui-web (port 18766): turn1 4343/88 (cache 4224), turn2 4487/29, total 2 calls 8830 in (cache 8448) / 117 out; playwright light/dark x 1280/390: no pageerror, no horizontal overflow. Screenshots not visually reviewed.

## Next
1. User migrates mykey.py -> ~/.ga-harness/llm.toml and confirms a real run without mykey.
2. ui-web: screenshot visual review; optional markdown rendering.
3. Pick next plugin (e.g. session recorder: per-turn JSONL of messages/tool calls/timings).

## ga-stdout: GA's own print() output (2026-10-24)
- GA prints `[Info]`/`[Debug]`/working-memory dumps etc. straight to sys.stdout/stderr. New plugin `ga-stdout`
  (first in `ga-compat`) swaps both for line-buffered proxies: each line -> `agent.log {stream, text}`;
  config `file` (append log) / `passthrough`; provides `console` (real out/err); restores on dispose.
- Frontends write via `console` (ui-cli/ui-tui output + tui prompt, ui-web log). TextView `show_log` shows agent.log.
- Verified: 51 tests; real GA `gah run` terminal shows only step/tool/result/reply; with
  `--patch` setting `ga-stdout.file`, the `[Info] Load mykeys ...`, `[Debug] ...`, `[Cache]` lines landed in the file.
- Known gap: frontends are added after profile/patch resolution, so `--patch id = "ui-cli"` fails (KeyError);
  `show_log` can only be set from code for now. ui-tui / ui-web not re-run against real GA after this change.

## Web plugin management (2026-10-24)
- Independent `plugin-manager` capability; Web only lists plugins and edits manifest-declared public settings.
- Enable/disable and reset are persisted per profile in `~/.ga-harness/plugins.json` (or `GAH_PLUGIN_CONFIG`).
  CLI launch/tree applies overrides after profile/patch resolution. Changes require a new launch; no hot unload.
- Protected core/config/frontend/management plugins, dependency and capability checks, strict field validation,
  revision conflicts, exclusive write lock and atomic replacement. Busy tasks reject writes; broken files are not overwritten.
- Verified: `uv run --extra dev pytest -q` -- 108 passed. Isolated real ui-web + fake agent browser acceptance:
  light/dark/warm x 1280/390, save/reload/disable/reset/protection/dependencies/conflicts/busy/chat/layout;
  no page errors or horizontal overflow. Whole-page/dialog contact sheet reviewed: no obvious clipping,
  overlap or contrast defects; fine typography/1px details are not reliably judged at the reduced scale.
- Evidence: `E:/Work/GenericAgent/temp/gah_plugin_acceptance/` (`browser-result.json`, screenshots,
  `visual-review-compact.txt`, `pytest-final.txt`). No real GA/LLM request or production-port validation;
  existing port 8765 was not restarted. This change is local only, not pushed or deployed.

## Assistant output aligned with Admin Chat (2026-10-24)
- Kept native JS and the existing frontend plugin API. Final answer is separate from collapsible
  process/step/tool details; manual disclosure state survives SSE renders and streaming completion.
- Added readable Markdown, locally bundled Marked 18.1.1 / DOMPurify 3.4.17 with licenses,
  reply/code copy, responsive output styling, and light/dark/warm theme variables.
  Raw HTML is escaped, generated HTML is allowlist-sanitized, and parser failure falls back to text.
  Remote Markdown images can still make network requests. Host assets use a fixed route allowlist.
- Verified: 116 pytest tests including 3 real Chromium regressions (simulated agent / random local port),
  covering Markdown safety/copy, SSE disclosure/final reply, parser failure, three themes and 1280/390 layouts.
  Wheel build passed; all seven new renderer/vendor/license assets match source bytes in the wheel.
- Evidence: E:/Work/GenericAgent/temp/gah_output_validation/ (pytest-final.log, browser-tests.log,
  page screenshots and visual reviews). Process/reply contact sheets were reviewed; an initial mobile-light
  clipping concern did not reproduce when the exact test interactions were rerun: heading Y=214.75,
  scrollTop=0 before/after the screenshot in all mobile themes (recheck/positions.json).
  Reduced-scale review is not pixel-perfect acceptance or a real phone test.
- No GA/Admin source changes, live GA/model request, existing-port restart, push or deployment.

## Native workspace/project plugins (2026-10-24)
- Added independent `workspace-store` and `web-workspaces` plugins, without Admin's project mode or layered memory.
  Workspaces bind relative tool paths/default execution directories to an existing absolute server directory;
  changing a workspace creates a conversation instead of relabeling old history.
- Projects persist name, fixed directory, rules and user-edited shared notes with sessions in SQLite.
  New conversations inherit the selected project; selecting a project restores its latest conversation.
  The native sidebar provides selection/creation/settings and a copyable read-only project ID;
  CLI/TUI/Web startup supports mutually exclusive `--workspace` and `--project` flags.
- Requests reserve their scope before queueing and keep it pinned until GA has actually stopped, including timeout/abort.
  Busy changes and stale project edits are rejected; requested startup scope must activate or launch fails.
  This is execution context, NOT a sandbox or automatic memory learning.
- Verified: 130 pytest tests passed, including the opt-in installed-GA tool-method test and real Chromium UI regression.
  The tool test AST-loads GA path/subprocess methods without importing GA or credentials: two projects wrote real
  relative files in their own directories without changing the harness process cwd. It is not a full GA/LLM run.
- Browser acceptance used the real UI with a simulated agent: create/edit/reload/select/workspace switch/busy protection,
  light/dark/warm at 1280px and 390px, no page errors or horizontal overflow. Desktop and mobile contact sheets
  were visually reviewed with no definite blocking defect; reduced scale cannot establish pixel-perfect contrast
  or real-phone behavior. Wheel build passed and all seven workspace module/plugin files matched source bytes.
- Evidence: E:/Work/GenericAgent/temp/gah-workspace-acceptance/ (`pytest-final.log`, `ga-tool-test.log`,
  `wheel-build.log`, browser screenshots, `desktop-review-sheet.txt`, `mobile-review-final.txt`).
  No GA/Admin source changes, live GA/LLM request, restart of existing 8765/8799 services, push or deployment.

## Plugin cleanup (2026-10-25)
- Removed the `tool-grep` example plugin (with its test and `examples/patches/tool-grep.toml`); no other plugin injected `ga.tools`, which stays available.
- Renamed `tool-timer` to `ga-timing` (hook observer, same family as `ga-usage`): capability `tool.timer` -> `ga.timing`,
  patch `examples/patches/ga-timing.toml`, test `tests/test_ga_timing.py`; event name `tool.timed` unchanged.
  Saved plugin config under the old name is not migrated.
