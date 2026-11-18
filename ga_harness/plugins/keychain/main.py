"""keychain: manage the GenericAgent keychain (~/ga_keychain.enc) from Settings.

The file format matches GenericAgent's ``memory/keychain.py``: ``json.dumps({name: value})``
XOR-ed with ``sha256(f"{user}@ga_keychain")``. This is obfuscation, not encryption.

Values are write-only: the API returns names and lengths, never values. A file that does
not decode is left untouched and writes are refused, so a bad mask (e.g. another user)
cannot wipe existing secrets.
"""
import getpass
import hashlib
import json
import os
import pathlib
import re
import tempfile
import threading

NAME = "keychain"
HERE = pathlib.Path(__file__).resolve().parent
KEY_NAME = re.compile(r"^[A-Za-z][A-Za-z0-9_]{0,63}$")   # GA reads secrets as keys.<name>
MAX_VALUE = 64 * 1024


def default_path():
    return pathlib.Path.home() / "ga_keychain.enc"


def user_name():
    try:
        return os.getlogin()
    except OSError:
        return getpass.getuser()


def mask_for(user):
    return hashlib.sha256(f"{user}@ga_keychain".encode()).digest()


def xor(data, mask):
    return bytes(b ^ mask[i % len(mask)] for i, b in enumerate(data))


class KeychainError(ValueError):
    pass


class Keychain:
    def __init__(self, path=None, user=None):
        self.path = pathlib.Path(path).expanduser() if path else default_path()
        self.mask = mask_for(user or user_name())
        self.lock = threading.Lock()

    def _load(self):
        if not self.path.exists():
            return {}
        try:
            data = json.loads(xor(self.path.read_bytes(), self.mask))
        except (ValueError, UnicodeDecodeError):
            data = None
        if not isinstance(data, dict) or not all(isinstance(k, str) and isinstance(v, str) for k, v in data.items()):
            raise KeychainError(f"cannot decode {self.path}; it was left untouched (wrong user or corrupted file)")
        return data

    def _save(self, data):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(prefix=".ga_keychain.", suffix=".tmp", dir=self.path.parent)
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(xor(json.dumps(data).encode(), self.mask))
            os.replace(tmp, self.path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def items(self):
        with self.lock:
            data = self._load()
        return [{"name": k, "length": len(v)} for k, v in sorted(data.items(), key=lambda kv: kv[0].lower())]

    def set(self, name, value):
        name = str(name or "").strip()
        if not KEY_NAME.match(name):
            raise KeychainError("name must start with a letter and use only letters, digits and _ (max 64)")
        if not isinstance(value, str) or not value.strip():
            raise KeychainError("value must be a non-empty string")
        if len(value) > MAX_VALUE:
            raise KeychainError("value is too long")
        with self.lock:
            data = self._load()
            data[name] = value.strip()
            self._save(data)

    def delete(self, name):
        with self.lock:
            data = self._load()
            if name not in data:
                raise KeychainError(f"no secret named {name}")
            del data[name]
            self._save(data)

    def rename(self, name, new):
        new = str(new or "").strip()
        if not KEY_NAME.match(new):
            raise KeychainError("name must start with a letter and use only letters, digits and _ (max 64)")
        with self.lock:
            data = self._load()
            if name not in data:
                raise KeychainError(f"no secret named {name}")
            if new != name and new in data:
                raise KeychainError(f"{new} already exists")
            data = {(new if k == name else k): v for k, v in data.items()}
            self._save(data)


class Api:
    def __init__(self, keychain):
        self.keychain = keychain

    def snapshot(self):
        info = {"path": str(self.keychain.path), "exists": self.keychain.path.exists(), "items": [], "error": ""}
        try:
            info["items"] = self.keychain.items()
        except KeychainError as e:
            info["error"] = str(e)
        return info

    def status(self, req=None):
        return self.snapshot()

    def change(self, req):
        body = (req or {}).get("body") or {}
        action = body.get("action") or "status"
        try:
            if action == "set":
                self.keychain.set(body.get("name"), body.get("value"))
            elif action == "delete":
                self.keychain.delete(str(body.get("name") or ""))
            elif action == "rename":
                self.keychain.rename(str(body.get("name") or ""), body.get("new_name"))
            elif action != "status":
                return 400, {"error": f"unknown action: {action}"}
        except KeychainError as e:
            return 400, {"error": str(e)}
        except OSError as e:
            return 500, {"error": f"keychain write failed: {e}"}
        return self.snapshot()


def apply(ctx, config):
    host = ctx.get("web.host")
    api = Api(Keychain((config or {}).get("path") or None))
    ctx.scope.add(host.register(NAME, script=HERE / "client.js", style=HERE / "client.css", order=62,
                                routes={("GET", ""): api.status, ("POST", ""): api.change}))
