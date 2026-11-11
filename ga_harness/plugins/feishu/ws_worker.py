"""Feishu long-connection receiver, run as a child process per channel.

lark's ws client keeps a module-level event loop and has no public stop, so
each channel runs it in its own process; stopping a channel kills it.
Credentials come from env (GAH_FEISHU_APP_ID / GAH_FEISHU_APP_SECRET), never
argv. Each received message is written to stdout as one JSON line; the parent
does filtering, dedup and replies.

The parent passes its pid in GAH_PARENT_PID. A harness that is killed or crashes
never gets to stop its channels, and this process would otherwise live on forever
(~150 MB each, still holding a Feishu connection), so it exits once that pid is gone.
"""
import json
import os
import sys
import threading
import time

_out = threading.Lock()


def emit(obj):
    with _out:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def on_message(data):
    msg, sender = data.event.message, data.event.sender
    emit({"type": "message", "message_id": getattr(msg, "message_id", "") or "",
          "chat_id": msg.chat_id, "msg_type": msg.message_type,
          "content": msg.content,
          "user": getattr(sender.sender_id, "open_id", "") or ""})


def _wait_parent_exit(pid):
    """Block until process ``pid`` has exited. Returns False when it cannot be watched."""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.WaitForSingleObject.restype = wintypes.DWORD
        kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
        # A handle (not the pid) is held, so a recycled pid cannot keep us alive.
        handle = kernel32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not handle:
            # 87 = ERROR_INVALID_PARAMETER: no such process (already gone).
            return ctypes.get_last_error() == 87
        try:
            return kernel32.WaitForSingleObject(handle, 0xFFFFFFFF) == 0  # WAIT_OBJECT_0
        finally:
            kernel32.CloseHandle(handle)
    while True:
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        except OSError:
            pass  # e.g. EPERM: it exists
        time.sleep(2)


def watch_parent(pid, on_exit=None):
    """Exit this process when the harness that spawned it is gone."""
    def run():
        try:
            gone = _wait_parent_exit(pid)
        except Exception:
            gone = False
        if gone:
            (on_exit or os._exit)(0)
    thread = threading.Thread(target=run, name="gah-parent-watch", daemon=True)
    thread.start()
    return thread


def main():
    parent = os.environ.get("GAH_PARENT_PID", "")
    if parent.isdigit() and int(parent) > 0:
        watch_parent(int(parent))
    app_id = os.environ.get("GAH_FEISHU_APP_ID", "")
    app_secret = os.environ.get("GAH_FEISHU_APP_SECRET", "")
    try:
        import lark_oapi as lark
    except ImportError:
        emit({"type": "fatal", "text": "lark-oapi is not installed"})
        return 2
    handler = lark.EventDispatcherHandler.builder("", "") \
        .register_p2_im_message_receive_v1(on_message).build()
    emit({"type": "log", "level": "info", "text": "connecting to Feishu"})
    try:
        lark.ws.Client(app_id, app_secret, event_handler=handler,
                       log_level=lark.LogLevel.INFO).start()
    except Exception as e:
        emit({"type": "fatal", "text": f"{type(e).__name__}: {e}"})
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
