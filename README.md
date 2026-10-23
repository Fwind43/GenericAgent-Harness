# ga-harness

GenericAgent 的 "Everything is a Plugin" 版本，思想参考 DeepSeek Harness / Cordis。

- `ga_harness/kernel/`：无业务内核（Context、Event、Effect、Plugin、Loader）。
- `ga_harness/plugins/`：所有能力（loop、llm、tools、prompt、memory……）都是插件。
- `ga_harness/compat/ga_bridge.py`：唯一 import GenericAgent 源码的位置，只读复用，不修改 GA。

状态：M0（内核 + 整体包装 GA 的兼容插件）开发中。
