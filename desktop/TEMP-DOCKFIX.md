# macOS Dock 修复临时验证包

- 版本：`0.0.46-dockfix.1`
- 架构：macOS arm64（Apple Silicon / M 系列；不是 Intel 版本）
- 基线：正式版 `v0.0.46`；运行时代码只修改 `desktop/src/main.js` 和 `desktop/src/autostart.js`。
- 用途：验证登录启动或其他启动路径导致应用缺少 Dock 图标 / Cmd-Tab 入口时的应用侧恢复措施。
- 这是未经过 Developer ID 签名、公证的临时测试包，不是正式 Release，也不会发布到自动更新通道。

## 安装

1. 从应用菜单或托盘菜单彻底退出旧版；不要仅关闭窗口。
2. 打开 DMG，把应用拖到 `/Applications`，替换原来的 `ga-harness-desktop.app`。
3. 不要删除 `~/.ga-harness`、`~/Library/Application Support/ga-harness-desktop` 或其他原有数据目录。
4. macOS 如阻止打开，可在“系统设置 → 隐私与安全性”确认来源后选择“仍要打开”。不要全局关闭 Gatekeeper。
5. 如果之前开启了“开机自启”，请关闭再开启一次，让登录项按新参数重新登记。
6. 测试期间不要接受正式版更新，以免替换此测试壳。

## 修复内容

- macOS 就绪时、请求显示主窗口时，恢复 `regular` 激活策略，Dock 隐藏时调用 `app.dock.show()`。
- macOS 登录项不再传 `openAsHidden: true`；登录启动仍只隐藏主窗口，不隐藏应用的 Dock 身份。

## 请反馈

分别验证普通打开、关闭窗口后从托盘打开、退出登录再登录后的自动启动；如果能复现原来的重启场景，也请重复验证。

预期：应用在 Dock 和 Cmd-Tab 中可见；登录自启可以不弹主窗口，但仍有 Dock 图标。

可在终端执行：

```sh
lsappinfo info -only ApplicationType -app io.github.fwind43.ga-harness
```

预期为 `Foreground`，不应为 `UIElement`。请反馈 macOS 版本、启动方式、上述命令输出及是否仍反复起停。

## 验证边界

构建流程检查 JavaScript 语法、打包内容、包版本、Info.plist、DMG 完整性，并提供 SHA-256。
不代表已经在真实用户登录环境中复现并修复；报告中的登录期反复起停驱动源仍未确定。
