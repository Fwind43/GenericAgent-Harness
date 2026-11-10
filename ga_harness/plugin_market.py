"""Plugin market: public GitHub repositories tagged with the ``ga-harness-plugin`` topic.

Read-only listing. Installing goes through the regular git import (``plugin_import``), so a
market plugin lands in the user directory and stays disabled like any other import.
No credentials are sent; the anonymous search API is rate limited, hence the small cache.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import json
import threading
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request

TOPIC = "ga-harness-plugin"
API = "https://api.github.com/search/repositories"
RAW_URL = "https://raw.githubusercontent.com/{full}/{branch}/{path}"
CONTENTS_URL = "https://api.github.com/repos/{full}/contents/{path}?ref={branch}"
TTL = 300
TIMEOUT = 10
RAW_TIMEOUT = 6
MAX_BODY = 4 << 20
MAX_RAW_BYTES = 64 << 10
LIMIT = 100

_lock = threading.Lock()
_cache = {"at": 0.0, "data": None}


class MarketError(RuntimeError):
    """The listing could not be fetched (network, rate limit, unexpected response)."""


def _fetch(url):
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": "ga-harness-plugin-market",
        "X-GitHub-Api-Version": "2022-11-28",
    })
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read(MAX_BODY).decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code in (403, 429):
            raise MarketError("GitHub rate limit reached; try again in a few minutes") from None
        raise MarketError(f"GitHub returned HTTP {e.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise MarketError(f"could not reach GitHub: {getattr(e, 'reason', e)}") from None
    except ValueError:
        raise MarketError("GitHub returned an unexpected response") from None


def _item(repo):
    if not isinstance(repo, dict):
        return None
    full, url = repo.get("full_name"), repo.get("html_url")
    # Only plain github.com repositories are offered for one-click install.
    if not isinstance(full, str) or not isinstance(url, str) or url != "https://github.com/" + full:
        return None
    if repo.get("private") or repo.get("archived") or repo.get("disabled"):
        return None
    owner = repo.get("owner") if isinstance(repo.get("owner"), dict) else {}
    lic = repo.get("license") if isinstance(repo.get("license"), dict) else {}
    return {
        "full_name": full,
        "name": str(repo.get("name") or ""),
        "owner": str(owner.get("login") or ""),
        "description": str(repo.get("description") or ""),
        "url": url,
        "clone_url": url + ".git",
        "stars": int(repo.get("stargazers_count") or 0),
        "updated_at": str(repo.get("pushed_at") or repo.get("updated_at") or ""),
        "default_branch": str(repo.get("default_branch") or ""),
        "license": str(lic.get("spdx_id") or ""),
        "fork": bool(repo.get("fork")),
    }


def _fetch_raw(full, branch, path):
    b = urllib.parse.quote(branch or "main", safe="")
    for url, headers in (
        (RAW_URL.format(full=full, branch=b, path=path), {"User-Agent": "ga-harness-plugin-market"}),
        (CONTENTS_URL.format(full=full, path=path, branch=b), {
            "Accept": "application/vnd.github.raw+json",
            "User-Agent": "ga-harness-plugin-market",
            "X-GitHub-Api-Version": "2022-11-28",
        }),
    ):
        req = urllib.request.Request(url, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=RAW_TIMEOUT) as r:
                return r.read(MAX_RAW_BYTES).decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return ""
        except Exception:
            continue
    return ""


def _str_list(val):
    return [x for x in val if isinstance(x, str) and x] if isinstance(val, list) else []


def _parse_manifest(raw):
    if not raw or not isinstance(raw, str):
        return {}
    try:
        data = tomllib.loads(raw)
    except Exception:
        return {}
    if not isinstance(data, dict):
        return {}
    req = _str_list(data.get("requires"))
    inj = _str_list(data.get("inject"))
    return {
        "plugin_name": data["name"] if isinstance(data.get("name"), str) else "",
        "version": data["version"].strip() if isinstance(data.get("version"), str) else "",
        "category": data["category"] if isinstance(data.get("category"), str) and data.get("category") else "",
        "description": data["description"] if isinstance(data.get("description"), str) else "",
        "description_zh": data["description_zh"] if isinstance(data.get("description_zh"), str) else "",
        "requires": list(dict.fromkeys([*req, *inj])),
        "provides": _str_list(data.get("provides")),
        "packages": _str_list(data.get("packages")),
    }


def _enrich_items(items, fetch_raw):
    tasks = {}
    with ThreadPoolExecutor(max_workers=8) as pool:
        for idx, item in enumerate(items):
            branch = item.get("default_branch") or "main"
            tasks[(idx, "toml")] = pool.submit(fetch_raw, item["full_name"], branch, "plugin.toml")
            tasks[(idx, "readme")] = pool.submit(fetch_raw, item["full_name"], branch, "README.md")
    out = []
    for idx, item in enumerate(items):
        try:
            toml_raw = tasks[(idx, "toml")].result() or ""
        except Exception:
            toml_raw = ""
        try:
            readme_raw = tasks[(idx, "readme")].result() or ""
        except Exception:
            readme_raw = ""
        meta = _parse_manifest(toml_raw)
        out.append({
            **item,
            "plugin_name": meta.get("plugin_name") or "",
            "version": meta.get("version") or "",
            "category": meta.get("category") or "",
            "description": meta.get("description") or item["description"],
            "description_zh": meta.get("description_zh") or "",
            "requires": meta.get("requires") or [],
            "provides": meta.get("provides") or [],
            "packages": meta.get("packages") or [],
            "readme": readme_raw.strip(),
        })
    return out


def search(refresh=False, fetch=None, now=None, fetch_raw=None):
    """Return ``{"topic", "items", "fetched_at", "cached"}``; raises ``MarketError``."""
    clock = now or time.time
    with _lock:
        data = _cache["data"]
        if data is not None and not refresh and clock() - _cache["at"] < TTL:
            return {**data, "cached": True}
        query = urllib.parse.urlencode({"q": "topic:" + TOPIC, "sort": "stars", "order": "desc", "per_page": LIMIT})
        body = (fetch or _fetch)(API + "?" + query)
        if not isinstance(body, dict) or not isinstance(body.get("items"), list):
            raise MarketError("GitHub returned an unexpected response")
        items = [i for i in map(_item, body["items"]) if i]
        raw_fn = fetch_raw if fetch_raw is not None else (_fetch_raw if fetch is None else None)
        if raw_fn is not None and items:
            items = _enrich_items(items, raw_fn)
        data = {"topic": TOPIC, "items": items, "fetched_at": clock()}
        _cache.update(at=data["fetched_at"], data=data)
        return {**data, "cached": False}


def reset_cache():
    with _lock:
        _cache.update(at=0.0, data=None)
