"""llm-config: replace GA's mykey.py.

config:
  file      TOML/JSON path (default $GAH_LLM_CONFIG or ~/.ga-harness/llm.toml)
  keys      inline table overlaid on the file (same shape as mykey.py globals)
  required  fail when no source exists (default false -> fall back to GA's mykey.py)

Must be mounted before ga-core (profile order). Strings support ${ENV} / ${ENV:-default}.
Provides llm.config: {"origin", "names", "source"} (no secret values).
"""
from ga_harness import llmconfig


def apply(ctx, config):
    src = llmconfig.Source.from_config(config or {})
    if not src.available:
        if config.get("required"):
            raise llmconfig.ConfigError(f"no LLM config: {src.file} not found and no inline keys")
        ctx.provide("llm.config", {"origin": "mykey.py (GA fallback)", "names": [], "source": None})
        return
    finder = llmconfig.install(src)
    ctx.scope.add(lambda: llmconfig.uninstall(finder))
    names = [k for k in src.load() if llmconfig.is_llm_key(k)]
    ctx.provide("llm.config", {"origin": src.origin, "names": names, "source": src})
