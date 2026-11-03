"""vlm-tool: a `vision_ask` GA tool with its own vision HTTP client.

The model is either the chat's current model (``model = ""``; failover-group
members are tried in order) or a concrete entry of mykey.py. Claude-style
entries use ``/messages``; OpenAI-style ones use ``/chat/completions`` or
``/responses`` (``api_mode``). Non-streamed requests; SSE replies are parsed too.
"""
from __future__ import annotations
import base64, glob, importlib, io, json, os, re
from concurrent.futures import ThreadPoolExecutor

SCHEMA = {"type": "function", "function": {
    "name": "vision_ask",
    "description": ("Look at local image file(s) with a vision LLM and answer a prompt. "
                    "Use for screenshots, drawings, PPT/DFM pictures, renders. png/jpg/bmp/gif/webp (emf/wmf if PIL can open). "
                    "Several images are asked independently with the same prompt (max 12 per call)."),
    "parameters": {"type": "object", "properties": {
        "images": {"type": "array", "items": {"type": "string"},
                   "description": "Absolute image paths; glob patterns allowed."},
        "prompt": {"type": "string", "description": "Question / instruction for the vision model."},
        "max_pixels": {"type": "integer", "description": "Optional downscale limit; default from plugin setting."}},
        "required": ["images", "prompt"]}}}

MAX_IMAGES = 12
DEFAULT_PROMPT = "\u8be6\u7ec6\u63cf\u8ff0\u8fd9\u5f20\u56fe\u7247\u7684\u5185\u5bb9"


# ---------- endpoints ----------

def _url(base, path):
    """Same joining rule as GA llmcore.auto_make_url."""
    b, p = str(base).rstrip("/"), path.strip("/")
    if b.endswith("$"):
        return b[:-1].rstrip("/")
    if b.endswith(p):
        return b
    return f"{b}/{p}" if re.search(r"/v\d+(/|$)", b) else f"{b}/v1/{p}"


def _mode(value):
    m = str(value or "chat_completions").strip().lower().replace("-", "_")
    return "responses" if m in ("responses", "response") else "chat_completions"


def _from_session(s):
    cls = type(s).__name__
    claude = "Claude" in cls
    key = getattr(s, "api_key", "") or ""
    xkey = claude and (cls == "ClaudeSession" or key.startswith("sk-ant-")
                       or getattr(s, "api_key_header", "") == "x-api-key")
    return {"name": getattr(s, "name", "") or getattr(s, "model", ""), "kind": "claude" if claude else "oai",
            "base": s.api_base, "key": key, "xkey": xkey, "model": getattr(s, "model", ""),
            "mode": getattr(s, "api_mode", "chat_completions"), "proxies": getattr(s, "proxies", None),
            "verify": getattr(s, "verify", True)}


def _from_entry(key, cfg):
    from ga_harness import llmconfig
    cfg = llmconfig._expand(dict(cfg), key)
    claude = "claude" in key and "oai" not in key
    apikey = str(cfg.get("apikey") or "")
    proxy = cfg.get("proxy")
    return {"name": cfg.get("name") or key, "kind": "claude" if claude else "oai",
            "base": str(cfg.get("apibase") or "").rstrip("/"), "key": apikey,
            "xkey": claude and (not key.startswith("native") or apikey.startswith("sk-ant-")
                                or cfg.get("api_key_header") == "x-api-key"),
            "model": cfg.get("model") or "", "mode": _mode(cfg.get("api_mode")),
            "proxies": {"http": proxy, "https": proxy} if proxy else None, "verify": cfg.get("verify", True)}


def _endpoints(agent, choice):
    if choice:
        from ga_harness import llmconfig
        entries = llmconfig.model_entries()
        if choice not in entries:
            raise ValueError(f"model {choice!r} is not in mykey.py")
        return [_from_entry(choice, entries[choice])]
    client = getattr(agent, "llmclient", None)
    backend = getattr(client, "backend", None)
    if backend is None:
        raise ValueError("no current model")
    subs = getattr(backend, "_sessions", None)
    if subs:
        i = getattr(backend, "_cur_idx", 0) or 0
        return [_from_session(s) for s in subs[i:] + subs[:i]]
    return [_from_session(backend)]


# ---------- images ----------

def _expand(paths):
    out = []
    for p in paths or []:
        p = os.path.expandvars(os.path.expanduser(str(p)))
        out.extend(sorted(glob.glob(p)) if any(c in p for c in "*?[") else [p])
    return list(dict.fromkeys(out))


def _encode(path, max_pixels):
    from PIL import Image
    im = Image.open(path)
    im.load()
    if im.mode in ("RGBA", "LA", "P"):
        im = im.convert("RGBA")
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im, mask=im.split()[-1])
        im = bg
    elif im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    w, h = im.size
    if max_pixels and w * h > max_pixels:
        k = (max_pixels / (w * h)) ** 0.5
        im = im.resize((max(1, int(w * k)), max(1, int(h * k))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode("ascii")


# ---------- HTTP ----------

def _request(ep, b64, prompt, max_tokens, timeout):
    import requests
    data_url = "data:image/jpeg;base64," + b64
    headers = {"Content-Type": "application/json"}
    if ep["kind"] == "claude":
        url = _url(ep["base"], "messages")
        headers["anthropic-version"] = "2023-06-01"
        if ep["xkey"]:
            headers["x-api-key"] = ep["key"]
        else:
            headers["Authorization"] = "Bearer " + ep["key"]
        payload = {"model": ep["model"], "max_tokens": max_tokens, "messages": [{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": b64}},
            {"type": "text", "text": prompt}]}]}
    elif ep["mode"] == "responses":
        url = _url(ep["base"], "responses")
        headers["Authorization"] = "Bearer " + ep["key"]
        payload = {"model": ep["model"], "max_output_tokens": max_tokens, "input": [{"role": "user", "content": [
            {"type": "input_text", "text": prompt}, {"type": "input_image", "image_url": data_url}]}]}
    else:
        url = _url(ep["base"], "chat/completions")
        headers["Authorization"] = "Bearer " + ep["key"]
        payload = {"model": ep["model"], "max_tokens": max_tokens, "messages": [{"role": "user", "content": [
            {"type": "text", "text": prompt}, {"type": "image_url", "image_url": {"url": data_url}}]}]}
    r = requests.post(url, headers=headers, json=payload, timeout=(15, timeout),
                      proxies=ep["proxies"], verify=ep["verify"])
    if r.status_code >= 400:
        raise RuntimeError(f"HTTP {r.status_code}: {r.text[:300]}")
    if "event-stream" in r.headers.get("Content-Type", ""):
        text = _parse_sse(r.text)
    else:
        text = _parse_json(r.json())
    if not text.strip():
        raise RuntimeError("empty answer")
    return text


def _text_of(content):
    if isinstance(content, str):
        return content
    return "".join(c.get("text", "") for c in content or [] if isinstance(c, dict))


def _parse_json(d):
    if isinstance(d.get("error"), dict) or isinstance(d.get("error"), str):
        raise RuntimeError(f"API error: {str(d['error'])[:300]}")
    if "choices" in d:
        return _text_of(((d.get("choices") or [{}])[0].get("message") or {}).get("content"))
    if d.get("type") == "message" or "stop_reason" in d:
        return "".join(c.get("text", "") for c in d.get("content") or [] if c.get("type") == "text")
    if d.get("output_text"):
        return d["output_text"]
    return "".join(_text_of(o.get("content")) for o in d.get("output") or [] if o.get("type") == "message")


def _parse_sse(body):
    out = []
    for line in body.splitlines():
        if not line.startswith("data:"):
            continue
        s = line[5:].strip()
        if not s or s == "[DONE]":
            continue
        try:
            e = json.loads(s)
        except ValueError:
            continue
        t = e.get("type", "")
        if "choices" in e:
            out.append(((e.get("choices") or [{}])[0].get("delta") or {}).get("content") or "")
        elif t == "content_block_delta":
            out.append((e.get("delta") or {}).get("text") or "")
        elif t == "response.output_text.delta":
            out.append(e.get("delta") or "")
        elif t == "error" or "error" in e:
            raise RuntimeError(f"API error: {str(e.get('error') or e)[:300]}")
    return "".join(out)


# ---------- tool ----------

def run_vision(agent, config, images, prompt, max_pixels=None):
    """Returns (model label, [(path, answer)])."""
    timeout = int(config.get("timeout") or 120)
    max_tokens = int(config.get("max_tokens") or 2048)
    max_pixels = int(max_pixels or config.get("max_pixels") or 1_440_000)
    paths = _expand(images if isinstance(images, list) else [images])
    if not paths:
        raise ValueError("no image paths matched")
    if len(paths) > MAX_IMAGES:
        raise ValueError(f"{len(paths)} images > {MAX_IMAGES}; split into several calls")
    eps = _endpoints(agent, str(config.get("model") or ""))
    used = {}

    def one(p):
        if not os.path.isfile(p):
            return p, "Error: file not found"
        try:
            b64 = _encode(p, max_pixels)
        except Exception as e:
            return p, f"Error: cannot open image - {type(e).__name__}: {e}"
        errs = []
        for ep in eps:
            try:
                ans = _request(ep, b64, prompt, max_tokens, timeout)
                used[ep["name"]] = 1
                return p, ans
            except Exception as e:
                errs.append(f"{ep['name']}: {type(e).__name__}: {e}")
        return p, "Error: " + " | ".join(errs)

    with ThreadPoolExecutor(max_workers=min(4, len(paths))) as ex:
        results = list(ex.map(one, paths))
    return ", ".join(used) or ", ".join(ep["name"] for ep in eps), results


def apply(ctx, config):
    tools = ctx.get("ga.tools") if ctx.has("ga.tools") else None
    if tools is None:
        return
    agent = ctx.get("ga.agent") if ctx.has("ga.agent") else None

    def do_vision_ask(handler, args, response):
        StepOutcome = importlib.import_module("agent_loop").StepOutcome
        args = args if isinstance(args, dict) else {}
        imgs = args.get("images") or args.get("image") or []
        try:
            model, results = run_vision(agent, config, imgs, args.get("prompt") or DEFAULT_PROMPT,
                                        args.get("max_pixels"))
            msg = f"[vision_ask model={model}]\n" + "\n\n".join(f"### {p}\n{r}" for p, r in results)
        except Exception as e:
            msg = f"[Error] vision_ask: {type(e).__name__}: {e}"
        return StepOutcome(msg, next_prompt=msg + "\n")

    do_vision_ask.__name__ = "do_vision_ask"
    ctx.scope.add(tools.register(SCHEMA, do_vision_ask))
