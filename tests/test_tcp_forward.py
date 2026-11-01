"""Shared loopback forwarder used by web-lan and web-tailscale."""
import socket
import threading

from ga_harness.tcp_forward import Forwarder, load_state, save_state


def _echo_server():
    srv = socket.create_server(("127.0.0.1", 0))

    def run():
        while True:
            try:
                c, _ = srv.accept()
            except OSError:
                return
            with c:
                c.sendall(c.recv(1024).upper())
    threading.Thread(target=run, daemon=True).start()
    return srv


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _roundtrip(port):
    with socket.create_connection(("127.0.0.1", port), timeout=5) as c:
        c.sendall(b"ping")
        try:
            return c.recv(1024)
        except ConnectionResetError:  # a dropped peer may see RST instead of EOF (Windows)
            return b""


def test_forwarder_pipes_allowed_peers_and_drops_others():
    srv = _echo_server()
    target = srv.getsockname()[1]
    try:
        fwd = Forwarder(["127.0.0.1"], _free_port(), target, lambda ip: True, "t")
        fwd.start()
        assert _roundtrip(fwd.port) == b"PING"
        fwd.close()
        deny = Forwarder(["127.0.0.1"], _free_port(), target, lambda ip: False, "t")
        deny.start()
        assert _roundtrip(deny.port) == b""
        deny.close()
    finally:
        srv.close()


def test_state_file_merges_and_tolerates_garbage(tmp_path):
    f = tmp_path / "s.json"
    assert load_state(f) == {}
    save_state(f, token="a")
    save_state(f, enabled=True)
    assert load_state(f) == {"token": "a", "enabled": True}
    f.write_text("[1]", encoding="utf-8")
    assert load_state(f) == {}
