# ga-harness progress

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

## Next
1. User migrates mykey.py -> ~/.ga-harness/llm.toml and confirms a real run without mykey.
2. Pick next plugin (e.g. session recorder: per-turn JSONL of messages/tool calls/timings).
