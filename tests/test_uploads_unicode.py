import io
from pathlib import Path
from urllib.parse import quote

from ga_harness import uploads


def test_non_ascii_upload_url_round_trips(tmp_path):
    data = b"\x89PNG fake"
    info = uploads.save(io.BytesIO(data), len(data), "男生.png", "image/png", root=tmp_path)
    assert info["name"] == "男生.png"
    rel = info["url"].removeprefix("/api/upload/")
    assert rel.isascii()  # percent-encoded, safe for <img src>
    assert uploads.locate(rel, tmp_path) == Path(info["path"]).resolve()
    day = rel.split("/")[0]
    raw = day + "/" + Path(info["path"]).name  # older stored messages keep the raw name
    assert uploads.locate(raw, tmp_path) is not None
    assert uploads.resolve([{"url": "/api/upload/" + raw}], tmp_path)[0]["path"] == info["path"]
    assert uploads.resolve([{"url": info["url"]}], tmp_path)[0]["path"] == info["path"]
    assert uploads.locate(day + "/..%2F..%2Fx", tmp_path) is None


def test_literal_percent_name_still_resolves(tmp_path):
    data = b"x"
    info = uploads.save(io.BytesIO(data), 1, "a%20b.txt", "text/plain", root=tmp_path)
    stored = Path(info["path"])
    day = stored.parent.name
    assert uploads.locate(day + "/" + stored.name, tmp_path) == stored.resolve()  # raw legacy url
    assert uploads.locate(info["url"].removeprefix("/api/upload/"), tmp_path) == stored.resolve()
    assert uploads.locate(day + "/" + quote(stored.name), tmp_path) == stored.resolve()
