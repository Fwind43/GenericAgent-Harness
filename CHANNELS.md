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

## Channel manager

The `channels` plugin also provides `channel_manager`
(`ga_harness/channel_manager.py`). Platform plugins only register a
*provider* (config fields + adapter factory); the user creates *channels*
(instances of a provider) and starts/stops each one independently. Channels
are stored in `channels.json` next to the sessions database. Secret fields are
write-only: never returned by the API, an empty value on update keeps the
stored one, and `env:NAME` is read from the environment at start time.

```python
from ga_harness.channel_manager import Provider

def apply(ctx, config):
    manager = ctx.get("channel_manager")
    def factory(cid, cfg, log):     # build an Adapter for one channel
        return EchoAdapter(cid, cfg, log=log)
    return manager.register_provider(Provider(
        "echo", factory, label="Echo", fields=[{"key": "token", "label": "Token", "secret": True}]))
```

Declare `inject = ["channel_manager"]`. If the adapter dies on its own, call
`manager.fail(cid, error)`. Write status lines with the `log` callback; they
show up in the UI.

Web UI: the `web-channels` plugin (sidebar "Channels") lists channels with
their state, creates/edits/deletes them, starts/stops/restarts them and tails
their logs. API: `GET /api/p/web-channels/` (snapshot),
`GET /api/p/web-channels/?logs=<id>&after=<t>`, `POST /api/p/web-channels/`
with `{action: create|update|delete|start|stop|restart, ...}`.

## Feishu provider

`ga_harness/plugins/feishu/` provides the `feishu` provider (long-connection
bot, no public callback URL). Enabling the plugin starts nothing: create a
Feishu channel in Channels, fill in App ID / App Secret (optionally
`allowed_users`, open_ids), then start it. Each running channel receives events
in its own `ws_worker.py` child process and replies via the REST API. Needs
`lark-oapi`; the bot app needs the `im.message.receive_v1` event and permission
to send messages. Text and rich-text (post) messages are handled.
