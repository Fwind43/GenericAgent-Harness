# ga-harness

GenericAgent（GA）的 **Everything is a Plugin** 外壳，思路参考 DeepSeek Harness / Cordis。

- **不改 GA**：GA 源码以只读方式加载，所有新能力都以插件叠加。
- **随时替换 GA**：默认 profile `ga-compat` 运行原版 GA，行为与直接运行一致。
- **一切皆插件**：模型配置、工具、系统提示词、钩子、展示前端都是插件，用 profile 和 patch 组合。

> 状态：早期开发（0.0.1）。内核与兼容层已用真实 GA 跑通，接口仍可能调整。

## 快速开始

需要 Python ≥ 3.11、[uv](https://docs.astral.sh/uv/)，以及一份本地 GenericAgent 代码。

```bat
git clone https://github.com/Fwind43/ga-harness
cd ga-harness
uv sync --extra dev

gah.cmd run "介绍一下你自己" --ga-root D:\path\to\GenericAgent
gah.cmd run --ui tui --ga-root D:\path\to\GenericAgent
```

GA 目录查找顺序：`--ga-root` → 环境变量 `GA_ROOT` → `~/.ga-harness/config.toml` 中的 `ga_root`。
如果 GA 有自己的虚拟环境，`gah` 会自动切换到该环境运行，不用手动设置 `PYTHONPATH`。

## 命令

| 命令 | 作用 |
| --- | --- |
| `gah run [task] [--profile P] [--patch F] [--ui U] [--timeout S]` | 组装插件树并运行 |
| `gah tree` | 显示当前组装出的插件树 |
| `gah plugins` | 列出所有可用插件 |
| `gah llm show` / `gah llm migrate` | 查看模型配置；把 GA 的 `mykey.py` 迁移为 harness 配置 |

## 内置插件

| 插件 | 作用 |
| --- | --- |
| `ga-core` | 托管未修改的 `agentmain.GenericAgent`，对外提供 `agent` 能力 |
| `ga-hooks` | 把 GA 的 hooks（agent/turn/llm/tool 前后）桥接为 harness 事件 `ga.<event>` |
| `ga-prompt` | 把系统提示词变成可前置、追加、替换的 waterfall |
| `ga-tools` | 不改 GA 即可新增、替换或禁用工具 |
| `llm-config` | 从 `~/.ga-harness/llm.toml`（或 `$GAH_LLM_CONFIG`、内联配置）提供模型配置，替代 `mykey.py` |
| `tool-grep` | 示例：通过 `ga-tools` 注册的只读正则搜索工具 |
| `tool-timer` | 统计每次工具调用耗时 |
| `ui-cli` | 单次任务：流式输出后退出（默认前端） |
| `ui-tui` | 终端多轮对话；Ctrl+C 中止当前任务，`/exit` 退出 |

## Profile 与 Patch

profile 定义基础插件树，按顺序挂载。默认的 `ga_harness/profiles/ga-compat.toml`：

```toml
[[plugins]]
name = "llm-config"   # 必须在 ga-core 之前

[[plugins]]
name = "ga-hooks"

[[plugins]]
name = "ga-core"
```

patch 在不修改 profile 的情况下插入插件，例如 `examples/patches/tool-timer.toml`：

```toml
[[patch]]
after = "ga-hooks"
insert = { name = "tool-timer", config = { print = true } }
```

```bat
gah.cmd run "列出当前目录" --patch examples\patches\tool-timer.toml
```

更多示例见 `examples/patches/`：禁用浏览器工具并追加提示词、注册 `grep` 工具。

## 写一个插件

每个插件是 `ga_harness/plugins/` 下的一个目录：

```
ga_harness/plugins/my-plugin/
├── plugin.toml
└── main.py
```

```toml
# plugin.toml
name = "my-plugin"
entry = "main:apply"
description = "一句话说明"
inject = ["ga.hooks"]       # 依赖的能力
provides = ["my.service"]   # 对外提供的能力
```

```python
# main.py
def apply(ctx, config):
    def before(gactx, nxt):
        # 工具调用前做点什么
        return nxt(gactx)

    ctx.on("ga.tool_before", before)        # 订阅事件
    ctx.provide("my.service", object())     # 提供能力
    ctx.scope.add(lambda: None)             # 卸载时清理
```

完整示例可参考 `tool-timer`（钩子）、`tool-grep`（工具）。

## 接入新的展示前端

前端也是插件：提供 `frontend` 能力即可，不用改 CLI、`ga-core` 或 GA。

1. 新建 `ga_harness/plugins/ui-xxx/`，`plugin.toml` 中声明 `inject = ["agent"]`、`provides = ["frontend"]`。
2. 在 `apply` 中 `ctx.provide("frontend", 前端对象)`。
3. 前端对象实现 `main(task=None, timeout=None) -> int`：
   - `ctx.get("agent").run(task, timeout=...)` 发送任务，可以多轮调用；
   - `ctx.get("agent").abort()` 中止当前任务；
   - 订阅 `agent.chunk` 事件拿到流式输出。
4. 用 `gah run --ui xxx` 启动（自动选 `ui-xxx`）。

最简实现见 `ga_harness/plugins/ui-cli/main.py`，多轮对话与中断见 `ui-tui/main.py`。

## 目录结构

```
ga_harness/
├── kernel/      # 无业务内核：Context、Events、Effect、Plugin、Loader
├── plugins/     # 全部能力
├── profiles/    # 基础插件树
├── cli.py       # gah 命令
├── launcher.py  # 切换到 GA 虚拟环境
└── llmconfig.py # 模型配置加载
examples/patches/  # patch 示例
tests/             # pytest
```

## 测试

```bat
uv run --extra dev pytest -q
```
