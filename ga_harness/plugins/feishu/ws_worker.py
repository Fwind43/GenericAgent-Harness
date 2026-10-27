"""Feishu long-connection receiver, run as a child process per channel.

lark's ws client keeps a module-level event loop and has no public stop, so
each channel runs it in its own process; stopping a channel kills it.
Credentials come from env (GAH_FEISHU_APP_ID / GAH_FEISHU_APP_SECRET), never
argv. Each received message is written to stdout as one JSON line; the parent
does filtering, dedup and replies.
"""
import json
import os
import sys
import threading

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


def main():
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
