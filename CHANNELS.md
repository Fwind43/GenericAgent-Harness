# Channels

`channels` is a platform-neutral base for chat bridges (Telegram, Feishu,
WeChat, ...). It ships no platform adapter; add your own as a plugin.

Code: `ga_harness/channels.py` (hub) and `ga_harness/plugins/channels/`
(service plugin, provides `channels`, needs `runs` + `sessions`).

## What the hub does

- Binds each `(channel, chat_id)` to a session, persisted in `channels.db`
  next to the sessions database.
- Starts a run for every inbound message (`source = "channel:<name>"`).
- On `run.finished` takes the final reply, splits it to the adapter's
  `max_len`, and sends it from one ordered delivery thread.
- Built-in commands: `/new`, `/stop`, `/status`, `/help`.

## Writing an adapter

```python
from ga_harness.channels import Adapter

class EchoAdapter(Adapter):
    name = "echo"        # unique, no ":"
    max_len = 4000

    def start(self, hub):
        super().start(hub)   # then start polling / webhook
    def stop(self):
        ...                  # stop polling
    def send(self, chat_id, text):
        ...                  # call the platform API

def apply(ctx, config):
    return ctx.get("channels").register(EchoAdapter())  # disposer
```

Inbound messages: `self.hub.receive(self.name, chat_id, text, user=...)`.
Your plugin's `plugin.toml` should `inject = ["channels"]`.
Keep tokens in plugin settings or environment variables, never in code.
