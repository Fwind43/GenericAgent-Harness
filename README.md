# GenericAgent-Harness

GenericAgent（GA）的 **Everything is a Plugin** 外壳，思路参考 DeepSeek Harness / Cordis。

- **不改 GA**：GA 源码以只读方式加载，所有新能力都以插件叠加。
- **随时替换 GA**：默认 profile `ga-compat` 运行原版 GA，行为与直接运行一致。
- **一切皆插件**：模型配置、工具、系统提示词、钩子、展示前端都是插件，用 profile 和 patch 组合。

> 状态：早期开发（0.0.1）。内核与兼容层已用真实 GA 跑通，接口仍可能调整。

## 快速开始

需要 Python ≥ 3.11、[uv](https://docs.astral.sh/uv/)，以及一份本地 GenericAgent 代码；使用 Web 界面还需要 Node.js 与 npm 来构建前端。

```bat
git clone https://github.com/Fwind43/GenericAgent-Harness
cd GenericAgent-Harness
uv sync --extra dev

gah.cmd run "介绍一下你自己" --ga-root D:\path\to\GenericAgent
gah.cmd run --ui tui --ga-root D:\path\to\GenericAgent
```

Web 首次启动前，在 `frontend/` 构建 React 宿主与插件资源，再回到仓库根目录启动：

```bat
cd frontend
npm.cmd ci
npm.cmd run build
cd ..
gah.cmd run --ui web --ga-root D:\path\to\GenericAgent
```

默认访问 `http://127.0.0.1:8765/`。前端源码更新后需重新构建；缺少构建产物时，Web 首页会返回 503 并提示构建，不会回退到旧版界面。前端开发与插件 SDK 说明见 [frontend/MIGRATION.md](frontend/MIGRATION.md)。

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
| `ga-stdout` | 接管 GA 自己 `print` 的输出（`[Info]`、`[Debug]` 等）：每行变成 `agent.log` 事件，不再直接打到终端；可配 `file` 写日志、`passthrough` 照常输出；对外提供 `console`（真实的 stdout/stderr） |
| `ga-hooks` | 把 GA 的 hooks（agent/turn/llm/tool 前后）桥接为 harness 事件 `ga.<event>` |
| `ga-prompt` | 把系统提示词变成可前置、追加、替换的 waterfall |
| `ga-tools` | 不改 GA 即可新增、替换或禁用工具 |
| `llm-config` | 从 `~/.ga-harness/llm.toml`（或 `$GAH_LLM_CONFIG`、内联配置）提供模型配置，替代 `mykey.py` |
| `ga-events` / `ga-usage` | 提供结构化执行事件，以及每步、每次任务的 token 用量 |
| `ga-timing` | 通过 GA 钩子统计每次工具调用耗时（只记录，不改变 GA 行为） |
| `session-store` | 独立的会话持久化插件；保存对话和 GA 上下文，供前端切换、恢复会话 |
| `workspace-store` | 会话绑定的工作目录与项目（项目记忆复用 GA 官方 project_mode） |
| `project-memory` | 分层项目记忆（L0 规范 / L1 索引 / L2 事实 / L3 专题）：每次调用模型时把索引和事实注入系统提示；官方 project_mode 只指向单个 `project_memory.md`，这里保留为只读来源 |
| `model-store` | 独立的运行时模型目录、切换和文件配置管理；接口不返回 API 密钥 |
| `run-store` | Web 模式的持久化任务记录与独立 worker 进程；同一会话只允许一个活动任务，不同会话可并行 |
| `plugin-manager` | 独立的插件目录、依赖检查与配置持久化；网页保存的修改在下次启动生效 |
| `web-sessions` / `web-models` | Web 会话列表、模型与推理强度选择，以及模型设置面板 |
| `web-plugins` / `web-channels` | 统一设置中的插件、通道管理面板；通道面板需启用对应后端能力 |
| `web-workspaces` / `web-theme` | 工作区与项目命令、编辑弹窗，以及浅色/深色/暖色主题 |
| `worldline` | 消息编辑、重新生成、分支切换与在新对话中分支 |
| `ui-cli` | 单次任务：流式输出后退出（默认前端） |
| `ui-tui` | 终端多轮对话；Ctrl+C 中止当前任务，`/exit` 退出 |
| `ui-web` | React + TypeScript 浏览器界面，Python 标准库提供 HTTP + SSE；默认 `http://127.0.0.1:8765/`，只接受同源请求 |

## 会话与模型管理（Web）

完成前端构建后，使用 `gah.cmd run --ui web` 启动。会话、模型、工作区与任务执行能力由独立插件提供，Web 负责交互；默认 profile 的 Web 模式会自动挂载 `run-store`。

- **侧边栏**：桌面端支持展开、收起与拖动边缘调宽，双击拖动手柄恢复默认宽度；宽度和收起状态按浏览器保存。窄屏使用抽屉式侧边栏。
- **统一设置**：侧边栏底部的“设置”集中显示模型、通道和插件面板，具体栏目随启用的插件而定，不再分别打开独立管理弹窗。
- **会话**：新建、切换、重命名和删除；对话及 GA 上下文保存到 `~/.ga-harness/sessions.sqlite3`，刷新或重启后可恢复。可通过 `$GAH_SESSION_DB` 或 `session-store` 的 `file` 配置更换位置。删除为逻辑删除，不代表安全擦除磁盘数据。
- **模型切换**：输入框下方合并模型与推理强度选择；平铺列表支持按模型名、ID 或服务商搜索，也可用下拉筛选服务商。后续任务使用新模型并保留当前上下文；推理强度按会话设置，运行中的会话不可切换模型。
- **模型配置**：通过“设置 → 模型”新增、编辑或删除 OpenAI/Claude 配置，支持名称、模型 ID、Base URL、API Key 和上下文窗口；至少保留一个模型。默认展示全部模型，可搜索或按服务商筛选；桌面端列表/详情双栏，手机端上下排列。保存后原子替换配置文件并重载，加载失败时回滚；过期编辑会被拒绝，重新加载面板后再试。
- **密钥**：接口不返回已有 API Key；密码框留空保留原值，也支持 `${ENV_NAME}`。文件仍按原有 TOML/JSON 方式保存配置；需要避免明文密钥时请使用环境变量引用。含账号、密码、查询参数或片段的 URL 不允许保存。
- **编辑边界**：仅编辑 `llm-config` 使用的 harness TOML/JSON 文件；GA 的 `mykey.py` 和带内联覆盖的配置只读。不改写 GA 源码或 `mykey.py`，复杂 mixin 依赖需在本地文件维护。模型选择目前属于运行时状态，不承诺跨进程重启保留。

Web 服务只适用于可信的本机环境，不应直接暴露到公网。

### 助手输出

- 最终回复单独展示，执行过程、步骤和工具明细逐层折叠；流式更新保留手动展开/收起状态。助手消息头显示模型、推理强度与本地日期时间。
- 正文支持 Markdown 标题、列表、表格、引用和代码块。回复底部实时更新耗时、首 token 延迟、输入/输出 token、缓存读写、生成速率和缓存命中率；指标按已有数据展示，旧消息缺少计时数据时不补造数值。缓存命中率为 `cache_read / input`，其中输入量已包含缓存，不重复加总。
- 回复底部和输入框下方的会话统计栏均为单行，超出宽度时横向滚动。回复完成后，统计栏末尾提供复制图标；启用 `worldline` 时，其后提供“在新对话中分支”。代码块也可单独复制。
- Marked 与 DOMPurify 随包提供，不依赖 CDN。原始 HTML 作为文本展示，生成的 HTML 经过白名单净化；依赖加载失败时退回纯文本。Markdown 中的远程图片仍可能发起网络请求。
- React 宿主与插件共用主题和前端运行时，保留 `GAH.define` 兼容接口；新插件可使用 `@gah/sdk` 的类型化 API、插槽和设置面板，见 [前端迁移与 SDK 文档](frontend/MIGRATION.md)。

### 隔离执行

Web 模式通过 `run-store` 为每次任务创建独立 worker 进程，使用启动时的会话、模型和工作区快照；宿主统一持久化会话。同一会话不能同时运行多个任务，不同会话可在 `run-store.max_parallel` 上限内并行。

CLI/TUI 仍使用原有单 Agent 路径。进程隔离不等于安全沙箱，也不提供跨宿主协调、任务自动重试或崩溃后自动续跑；服务与 Web API 契约见 [RUNS.md](RUNS.md)。

## 工作区与项目

两者都由独立插件提供；项目记忆直接复用 GA 官方 `plugins/project_mode.py`，不再自建规则/笔记：`workspace-store` 管状态与执行上下文，`web-workspaces` 提供输入框斜杠命令、补全和编辑弹窗。输入框上方不再展示常驻工作区配置条。

- **工作区**：服务器上已存在的绝对目录。切换目录会新建会话，不会把旧对话改挂到新目录；相对文件路径及默认代码执行目录使用当前工作区。
- **项目**：名称 + 固定工作目录。项目间会话隔离，新建会话继承当前项目；切回项目恢复其最近会话。进入项目时会为 agent 激活 GA 官方项目模式（与 `/project <名称>` 同一机制），项目私域目录与记忆位于 GA 的 `temp/projects/<名称>/`（`project_memory.md`），由 agent 按官方规则读写。项目名即目录名，不能含 `\ / : * ? " < > |`。
- **持久化**：项目和会话共用 `session-store` 的 SQLite 文件；刷新或重启后保留。项目目录创建后不可修改，需要换目录时新建项目。
- **保护**：范围切换、项目修改受运行状态与版本校验保护；多标签页过期编辑会被拒绝。指定的启动范围无法激活时拒绝运行，不会静默使用别的目录。
- **边界**：工作区是默认执行目录，**不是沙箱**；工具仍可使用绝对路径访问其他位置。项目记忆只是模型上下文，不是访问控制。

Web 中在输入框输入以下命令，支持补全；命令由插件处理，不发送给模型：

| 命令 | 作用 |
| --- | --- |
| `/workspace` | 打开工作区弹窗；当前在项目中时打开项目设置 |
| `/workspace C:\work\demo` | 进入指定的普通工作区 |
| `/project` | 创建项目；已在项目中时打开项目设置 |
| `/project new` | 创建新项目 |
| `/project <项目ID或名称>` | 切换项目；也支持唯一的名称前缀 |
| `/project off` / `/workspace off` | 退出项目或自定义工作区，回到默认范围 |

CLI/TUI/Web 也支持启动参数（两者互斥）：

```bat
gah.cmd run --ui web --workspace "C:\work\demo"
gah.cmd run --ui tui --project <项目ID>
```

项目 ID 可从项目设置中复制。未指定参数时沿用当前会话范围；首次启用时使用 GA 的 `temp` 目录。

## 插件管理（Web）

默认 profile 提供 `plugin-manager`。打开“设置 → 插件”，可按分类、状态或关键字查找插件，在卡片详情中查看运行状态、依赖与待生效设置，启用/禁用非保护插件，编辑公开字段，或恢复启动配置。

- **下次启动生效**：保存不会热卸载插件，也不会中断当前会话。任务运行时禁止修改；保存后需自行重新启动 harness。
- **配置位置**：默认 `~/.ga-harness/plugins.json`，可用 `$GAH_PLUGIN_CONFIG` 指定；按 profile 隔离，启动时叠加到 profile 和 patch 之后。`gah tree` 展示叠加结果。
- **安全边界**：仅编辑清单声明的公开字段；密钥类字段不开放。GA 核心、模型配置入口、前端及管理服务受保护；模型配置通过“设置 → 模型”管理。不会修改 GA 源码或 `mykey.py`。
- **依赖与并发**：缺少必要依赖、能力冲突、过期编辑或其他写入占锁时拒绝保存；重新加载后再试。损坏配置不会被自动覆盖，需先在本地修复。
- **范围**：只管理本机已发现的插件，不提供下载安装或远程执行入口。恢复启动配置会清除此插件的网页覆盖，不改原 profile/patch。

插件作者可在 `plugin.toml` 中声明 `[settings.<字段名>]`：支持 `type = "string" | "integer" | "boolean"`，以及 `label`、`default`、整数 `min/max`、字符串 `max_length`；`secret = true` 的字段不会开放。

## Profile 与 Patch

profile 定义基础插件树，按顺序挂载。下面摘录默认 profile 的 GA 桥接部分；完整配置（含会话、模型、工作区及 Web 插件）见 [`ga_harness/profiles/ga-compat.toml`](ga_harness/profiles/ga-compat.toml)：

```toml
[[plugins]]
name = "ga-stdout"    # 最先挂载，接管 GA 的 print 输出

[[plugins]]
name = "llm-config"   # 必须在 ga-core 之前

[[plugins]]
name = "ga-hooks"

[[plugins]]
name = "ga-timing"    # 工具耗时（tool.timed），默认不打印 stderr
config = { print = false }

[[plugins]]
name = "ga-events"    # 结构化的 run/turn/tool 事件

[[plugins]]
name = "ga-usage"     # 每步/每次任务的 token 用量

[[plugins]]
name = "ga-core"

[[plugins]]
name = "ga-prompt"    # 系统提示词覆盖，未配置时不生效

[[plugins]]
name = "ga-tools"     # 工具集覆盖，未配置时不生效
```

patch 在不修改 profile 的情况下插入或调整插件，例如 `examples/patches/ga-timing.toml` 打开耗时打印：

```toml
[[patch]]
id = "ga-timing"
config = { print = true }
```

```bat
gah.cmd run "列出当前目录" --patch examples\patches\ga-timing.toml
```

更多示例见 `examples/patches/`：禁用浏览器工具并追加提示词。

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
category = "extension"   # 可选：core / extension / observe / service / ui，缺省或未知归 other
inject = ["ga.hooks"]       # 依赖的能力
provides = ["my.service"]   # 对外提供的能力
packages = ["httpx>=0.27"]  # 可选：需要的 Python 包（pip 规格）
```

声明了 `packages` 的插件，如果缺包，启动时会跳过加载（不报错），在插件管理里显示"缺少 Python 依赖"。插件详情页有"安装依赖"按钮，会安装到当前 Python 环境（有 uv 用 uv，否则用 pip），下次启动生效。启动时不会自动安装。

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

完整示例可参考 `ga-timing`（钩子）。

## 接入新的展示前端

前端也是插件：提供 `frontend` 能力即可，不用改 CLI、`ga-core` 或 GA。

1. 新建 `ga_harness/plugins/ui-xxx/`，`plugin.toml` 中声明 `inject = ["agent"]`、`provides = ["frontend"]`。
2. 在 `apply` 中 `ctx.provide("frontend", 前端对象)`。
3. 前端对象实现 `main(task=None, timeout=None) -> int`：
   - `ctx.get("agent").run(task, timeout=...)` 发送任务，可以多轮调用；
   - `ctx.get("agent").abort()` 中止当前任务；
   - 订阅 `ga-events` 的结构化事件来显示（见下节）。
4. 用 `gah run --ui xxx` 启动（自动选 `ui-xxx`）。

### 输出事件规范

GA 内核只输出一段显示用的文本（`**LLM Running (Turn N) ...**`、`🛠️ Tool:` 代码块、`[Stdout]` 等），
格式由 GA 决定，随时可能变。**前端一律使用 `ga-events` 的结构化事件，禁止用正则解析 `agent.chunk`。**

| 事件 | 时机 | 主要字段 |
| --- | --- | --- |
| `run.start` / `run.end` | 一次任务开始/结束 | `exit` |
| `turn.start` / `turn.end` | 一个步骤开始/结束（最后一步可能没有 `turn.end`，以 `run.end` 收尾） | `turn`、`exit` |
| `assistant.delta` | 模型输出流式到达，每个片段发一次（顺序与 GA 一致） | `turn`、`part`（`summary` / `thinking` / `reply`）、`text`（本次增量） |
| `assistant.text` | 模型回复完整（流式结束后再发一次整段，前端据此校正） | `turn`、`text`（原文）、`reply`（去掉 summary/thinking）、`summary` |
| `tool.call` / `tool.result` | 工具调用开始/结束 | `id`、`turn`、`name`、`args`；结果另有 `ok`、`data`、`seconds` |
| `usage` | 每次模型调用之后（由 `ga-usage` 发出） | `turn`、`input`（含缓存）、`cache_read`、`cache_write`、`output` |
| `usage.total` | 任务结束、`run.end` 之前 | `calls` 加上同样四项的累计值 |

- `agent.chunk`：GA 原始文本，只用来调试（`raw = true`），或在一次任务完全没有 `ga-events` 事件时兜底显示。
- `agent.log`：GA 自己 `print` 出的一行（`stream` 为 `stdout` 或 `stderr`，`text` 为内容），由 `ga-stdout` 发出。前端默认不显示；`TextView(show_log=True)` 会以 `  . ` 前缀显示。
- 挂载 `ga-stdout` 后 `sys.stdout` 已被接管，前端要输出到终端须写 `ctx.get("console").out` / `.err`，不要直接 `print`（否则会被当成 GA 日志吞掉）。
- 终端前端可以直接用 `ga_harness.textview.TextView`，按事件输出“步骤 / 工具调用 / 结果 / 回复”的纯文本（`ui-cli`、`ui-tui` 就是这么做的）。
- GA 改了显示格式，只需改 `ga-events` 一处，前端不用改。

最简实现见 `ga_harness/plugins/ui-cli/main.py`，多轮对话与中断见 `ui-tui/main.py`，浏览器前端见 `ui-web/main.py`。

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
frontend/          # React + TypeScript 宿主、SDK 与插件构建
RUNS.md            # 隔离执行服务与 Web API 契约
tests/             # pytest
```

## 测试

```bat
uv run --extra dev pytest -q
```

助手输出的真实浏览器回归是可选项（未安装 Playwright 时自动跳过），使用独立随机端口和模拟 Agent，不读取用户模型配置或调用真实模型：

```bat
uv run --with playwright playwright install chromium
uv run --extra dev --with playwright python -m pytest tests/test_ui_web_output_browser.py -q
```

设置 `GAH_OUTPUT_ARTIFACTS` 为仓库外目录可保留三主题、桌面和窄屏验收截图。
