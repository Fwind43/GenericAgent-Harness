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
- profile `ga-compat` = ga-hooks + ga-core; CLI `gah run|tree|plugins`

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

## Next
1. First real harness plugin layered via patch (e.g. telemetry/tool timer on ga.tool_before/after).
2. Optional `gah` launcher that auto-uses GA's interpreter.
