# Linux 无桌面服务器部署 ga-harness（含远程访问）

## 推荐：服务端预打包版本（不需要桌面环境）

服务端包包含 Python 3.12、GenericAgent、后端依赖和已构建网页，不需要自行安装 Node.js 或构建前端。支持 Linux x64 / arm64（glibc 系统，建议 Ubuntu 22.04+ / Debian 12；不适用于 Alpine/musl）。模型服务的 API 凭据仍需自行配置。

### 下载与运行 tar.gz

在 GitHub Actions 的 `desktop` 工作流成功后，下载对应的 `desktop-server-linux-x64` 或 `desktop-server-linux-arm64` artifact，解开 artifact ZIP 后取得 tar.gz。打 `v*` 标签时，tar.gz 也会附在草稿 Release 中；未发布草稿不会出现在公开下载页。

```bash
# 将文件名替换为实际版本；arm64 服务器选 linux-arm64
 tar -xzf ga-harness-server-<版本>-linux-x64.tar.gz
 cd ga-harness-server-<版本>-linux-x64
 GAH_WEB_HOST=0.0.0.0 ./gah-server
```

默认端口为 `8765`。非回环监听首次启动会生成访问令牌并保存在 `~/.ga-harness/web-token`（权限 600），不会将令牌打印到日志。只在服务器终端自行查看它，然后打开 `http://<服务器IP>:8765/?gah_token=<令牌>`。这是令牌认证，不是账号/密码。不要分享带令牌的 URL。

默认仅监听回环；上面的 `GAH_WEB_HOST=0.0.0.0` 开启网络监听。**不要直接将明文 HTTP 暴露到公网**：优先通过 Tailscale 私网 IP 访问并在防火墙限定来源；或使用 HTTPS 反向代理。域名访问需设置 `GAH_WEB_ALLOWED_ORIGINS=https://gah.example.com`（填写实际 scheme/域名/端口）。

首次访问后在 **设置 → 模型** 添加模型。状态都在 `$GAH_HOME`（默认 `~/.ga-harness`）：GA 可写副本及 `mykey.py` 位于 `genericagent/`，会话和插件设置也在该数据目录内。升级时停服务、替换安装包、保留整个数据目录；不要将数据目录放进安装包目录。启动器刷新 GA 代码，但保留模型配置、temp 和已有 memory 文件。可用 `GA_ROOT` 指定已有 GA 副本。

### systemd 常驻

将解压后的包内容放到 `/opt/ga-harness`，创建专用运行用户，并安装包内的 service：

```bash
sudo useradd --system --create-home --shell /bin/bash gah  # 已存在则跳过
sudo cp /opt/ga-harness/ga-harness.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ga-harness
sudo journalctl -u ga-harness -f
```

包内 service 以 `gah` 用户运行，监听 `0.0.0.0:8765`；确保安装目录可读、该用户主目录可写。令牌位于该用户的 `~/.ga-harness/web-token`。用 `sudo systemctl edit ga-harness` 添加环境变量，例如：

```ini
[Service]
Environment=GAH_HOME=/var/lib/ga-harness
Environment=GAH_WEB_ALLOWED_ORIGINS=https://gah.example.com
```

自定义数据目录须先创建并授权给 `gah`，然后重启服务。此 service 与下文源码部署 service 是两种备选方案，不要同时安装。

### Docker（amd64 / arm64 自动选择）

镜像由 CI 发布至 `ghcr.io/fwind43/genericagent-harness`。`main` 分支发布 `:main` 和 `:latest`，`desktop` 分支发布 `:desktop`，版本标签发布对应版本号。首次发布需仓库管理员确认 GHCR 包可见性为 public，否则拉取需要登录。

```bash
docker volume create gah-data
docker run -d --name ga-harness --restart unless-stopped \
  -p 127.0.0.1:8765:8765 \
  -v gah-data:/data \
  ghcr.io/fwind43/genericagent-harness:main
# 在自己的终端查看自动生成的令牌，勿粘贴到公开日志
docker exec ga-harness cat /data/web-token
```

示例只发布到宿主机回环，可通过 SSH 隧道或 HTTPS 反代访问。Tailscale 远程直连时，将 `127.0.0.1` 替换为宿主机的实际 tailnet IPv4；不要无意中发布到所有公网接口。Docker 容器内已监听 `0.0.0.0`，默认端口 8765。使用域名时在 `docker run` 加 `-e GAH_WEB_ALLOWED_ORIGINS=https://gah.example.com`。数据卷保留模型配置、会话和令牌；升级需拉取镜像、删除旧容器并以同一卷重新创建，**不要删除数据卷**。

容器默认以 root 运行，Agent 能执行容器内命令；不要挂载 Docker socket 或不必要的宿主机目录。仅安装核心依赖，桌面自动化及其他可选集成仍需额外依赖。配置与代码同步由启动器完成，不需要 Electron。

---

## 备选：从源码部署

适用于没有图形界面的 Linux 服务器（Ubuntu/Debian 为例，其他发行版换成对应的包管理器）。部署完成后：

- ga-harness 网页界面作为 systemd 服务常驻，只监听 `127.0.0.1:8765`；
- 通过 **Tailscale** 远程访问 `http://<服务器 tailnet IP>:8766/`，用访问令牌（token）登录。

没有账号/密码体系，**唯一的凭据是 token**（至少 16 个字符，不能有空格、`;`、`,`、`"`）。

下文约定的路径（可以按需更改，但要前后一致）：

| 用途 | 路径 |
| --- | --- |
| GenericAgent 源码 | `/opt/GenericAgent` |
| ga-harness 源码 | `/opt/ga-harness` |
| ga-harness 数据目录（`GAH_HOME`） | `/var/lib/ga-harness` |
| 运行用户 | `gah` |

---

## 1. 安装系统依赖

```bash
sudo apt update
sudo apt install -y git python3 python3-venv python3-pip curl
python3 --version   # 需要 3.11 ~ 3.13（ga-harness 要求 >=3.11，GenericAgent 要求 <3.14）
```

网页前端的构建产物 `ga_harness/plugins/ui-web/dist/` **不在 git 里**，需要用 Node.js 构建一次（建议 Node 20 LTS 或更新版本）：

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v && npm -v
```

> 不想在服务器上装 Node：可以在别的机器上执行第 4 步的构建，再把 `ga_harness/plugins/ui-web/dist/` 整个目录复制到服务器的同一位置。

## 2. 创建运行用户和目录

```bash
sudo useradd --system --create-home --shell /bin/bash gah
sudo mkdir -p /opt/GenericAgent /opt/ga-harness /var/lib/ga-harness
sudo chown -R gah:gah /opt/GenericAgent /opt/ga-harness /var/lib/ga-harness
```

后面的命令都以 `gah` 用户执行：

```bash
sudo -iu gah
```

## 3. 安装 GenericAgent（Agent 本体和模型配置）

```bash
git clone https://github.com/lsdefine/GenericAgent /opt/GenericAgent
cd /opt/GenericAgent
python3 -m venv .venv
.venv/bin/pip install -U pip
.venv/bin/pip install -e .          # 只装核心依赖即可，桌面/机器人类 extras 不需要
```

模型配置在 GenericAgent 原生的 `mykey.py` 里：

```bash
cp mykey_template.py mykey.py       # 英文模板：mykey_template_en.py
chmod 600 mykey.py
nano mykey.py                       # 填写模型的 API 地址和 key
```

也可以先放一份模板，部署好后在网页的 **设置 → 模型** 里配置，保存时写回的是同一个 `mykey.py`。

## 4. 安装 ga-harness 并构建网页前端

```bash
git clone -b desktop https://github.com/Fwind43/GenericAgent-Harness.git /opt/ga-harness
cd /opt/ga-harness/frontend
npm ci
npm run build                        # 生成 ../ga_harness/plugins/ui-web/dist/
ls ../ga_harness/plugins/ui-web/dist/index.html
```

ga-harness 自身没有第三方 Python 依赖，运行时直接使用 GenericAgent 的 `.venv`，不需要单独再建 venv。（可选：要用飞书频道的话，执行 `/opt/GenericAgent/.venv/bin/pip install lark-oapi`。）

## 5. 准备数据目录和配置文件

所有 ga-harness 数据（会话、插件开关、远程访问状态、上传文件、日志）都放在 `GAH_HOME`。不设置时默认是 `~/.ga-harness`，本文统一用 `/var/lib/ga-harness`。

### 5.1 `config.toml`：GenericAgent 的位置

```bash
cat > /var/lib/ga-harness/config.toml <<'EOF'
ga_root = "/opt/GenericAgent"
EOF
```

（启动命令里的 `--ga-root` 优先级更高，这个文件只是兜底，方便手动运行 `gah`。）

### 5.2 生成访问令牌

```bash
TOKEN=$(python3 -c "import secrets;print(secrets.token_urlsafe(24))")
echo "$TOKEN"     # 记下来，登录要用
```

### 5.3 `plugins.json`：启用 Tailscale 远程访问插件

```bash
cat > /var/lib/ga-harness/plugins.json <<'EOF'
{
  "version": 1,
  "profiles": {
    "ga-compat": {
      "web-tailscale": {"enabled": true, "config": {"port": 8766, "tailscale_path": ""}}
    }
  }
}
EOF
```

- `port`：tailnet 上对外开放的端口，**不能和网页界面本身的端口（8765）相同**。
- `tailscale_path`：留空会在 PATH 里找 `tailscale`；装在别处就填完整路径。
- `ga-compat` 是默认 profile 名；启动时用了 `--profile xxx` 的话，这里也换成 `xxx`。
- 这个文件只能配置“允许公开修改”的插件字段。`ui-web` 是受保护插件，**不能**在这里改它的 host/token（写了会导致启动失败）。

### 5.4 `web-tailscale.json`：开启转发并写入令牌

```bash
cat > /var/lib/ga-harness/web-tailscale.json <<EOF
{"enabled": true, "token": "$TOKEN"}
EOF
chmod 600 /var/lib/ga-harness/web-tailscale.json
```

- `enabled: true`：启动后自动开始转发。Tailscale 还没连上时，插件会在后台不断重试。
- `token` 可以不写，插件会自动生成一个随机令牌并写回这个文件，之后用 `cat` 查看。
- 令牌的优先级：环境变量 `GAH_WEB_TOKEN` > `ui-web` 配置里的 `token` > 这个文件里的 `token`。本文的 systemd 配置没有设置前两个。

## 6. 安装并登录 Tailscale

（换回有 sudo 权限的用户执行。）

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up                    # 无桌面时会打印一个登录链接，在任意设备的浏览器中打开即可
# 自建 Headscale：sudo tailscale up --login-server https://你的headscale地址
```

确认 **`gah` 用户** 能读取到状态（插件就是靠这条命令获取 tailnet IP 的）：

```bash
sudo -u gah tailscale status --json | python3 -c "import json,sys;d=json.load(sys.stdin);print(d['BackendState'],d['Self']['TailscaleIPs'])"
# 应输出：Running ['100.x.y.z', 'fd7a:...']
```

开了防火墙的话，放行 tailnet 网卡上的 8766 端口：

```bash
sudo ufw allow in on tailscale0 to any port 8766 proto tcp
```

## 7. systemd 服务

```bash
sudo tee /etc/systemd/system/ga-harness.service >/dev/null <<'EOF'
[Unit]
Description=ga-harness web UI
After=network-online.target tailscaled.service
Wants=network-online.target

[Service]
Type=simple
User=gah
Group=gah
WorkingDirectory=/opt/ga-harness
Environment=GAH_HOME=/var/lib/ga-harness
Environment=PYTHONPATH=/opt/ga-harness
Environment=PYTHONIOENCODING=utf-8
Environment=GAH_WEB_PORT=8765
Environment=GAH_WEB_OPEN_BROWSER=0
ExecStart=/opt/GenericAgent/.venv/bin/python -m ga_harness.cli run --ui web --ga-root /opt/GenericAgent
KillSignal=SIGINT
TimeoutStopSec=30
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now ga-harness
```

说明：

- 直接用 GenericAgent 的 venv 解释器启动，ga-harness 不需要再切换一次解释器。
- `GAH_WEB_PORT=8765` 固定本地端口（默认是随机端口）；网页界面本身只监听 `127.0.0.1`，外部访问全部经由 Tailscale 转发。
- `GAH_WEB_OPEN_BROWSER=0`：服务器上没有浏览器，不要尝试打开。
- 必须带 `--ui web`：默认 profile 不含前端，不带这个参数会退回到命令行前端。

## 8. 验证

```bash
systemctl status ga-harness --no-pager
journalctl -u ga-harness -n 50 --no-pager
# 正常会有一行：[tailscale] forwarding http://100.x.y.z:8766/, ... -> 127.0.0.1:8765

ss -ltnp | grep -E ':8765|:8766'     # 8765 在 127.0.0.1 上，8766 在 tailnet IP 上
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8765/api/state   # 已设置令牌时，不带令牌应返回 401
```

在已加入同一个 tailnet 的手机/电脑上打开：

```
http://<服务器的 tailnet IP>:8766/?gah_token=<令牌>
```

如果 tailnet 开了 MagicDNS，也可以用 `http://<机器名>.<tailnet 域名>:8766/`。首次带上 `?gah_token=` 进入后，会写入一个 30 天的 HttpOnly cookie（每次打开页面都会续期），地址栏里的令牌也会被去掉；令牌本身不会过期。

## 9. 日常维护

| 操作 | 命令 / 做法 |
| --- | --- |
| 换令牌 | 修改 `/var/lib/ga-harness/web-tailscale.json` 里的 `token`，然后 `sudo systemctl restart ga-harness`；也可以在网页的远程访问面板里重置 |
| 暂停远程访问 | 把 `web-tailscale.json` 里的 `enabled` 改成 `false`，或把 `plugins.json` 里的插件 `enabled` 改成 `false`，然后重启服务 |
| 更新 | `cd /opt/ga-harness && git pull && cd frontend && npm ci && npm run build && sudo systemctl restart ga-harness`；GenericAgent 用 `git pull` 更新 |
| 查看日志 | `journalctl -u ga-harness -f` |
| 备份 | 备份 `/var/lib/ga-harness/` 和 `/opt/GenericAgent/mykey.py` |

重启前最好确认网页上没有正在执行的任务，重启会中断它们。

---

## 附：其他访问方式

### A. 只在局域网/内网访问（web-lan）

把第 5.3、5.4 步改成：

```json
// plugins.json -> profiles.ga-compat
"web-lan": {"enabled": true, "config": {"port": 8766, "bind": "0.0.0.0"}}
```

```bash
echo "{\"enabled\": true, \"token\": \"$TOKEN\"}" > /var/lib/ga-harness/web-lan.json
chmod 600 /var/lib/ga-harness/web-lan.json
```

- 在服务器上 `bind` 要写死（留空就得在网页面板里选择网卡）；`0.0.0.0` 表示监听所有网卡。
- web-lan **只放行内网地址的客户端**，公网 IP 访问会被拒绝，所以它不能用作公网入口。

### B. 公网域名 + HTTPS（反向代理）

不启用 web-tailscale/web-lan，让 nginx/Caddy 在本机把流量反代到 `127.0.0.1:8765`。ga-harness 仍只监听本机，但需要在 systemd 的 `[Service]` 里多加两行：

```ini
Environment=GAH_WEB_TOKEN=你的令牌
Environment=GAH_WEB_ALLOWED_ORIGINS=https://gah.example.com
```

- `GAH_WEB_TOKEN`：网页界面强制要求令牌。
- `GAH_WEB_ALLOWED_ORIGINS`：允许从这个域名发起写请求；不设置的话，页面能打开，但发送消息之类的 POST 请求会被同源校验拦下。

nginx 示例（实时输出依赖 SSE，必须关闭缓冲）：

```nginx
server {
    listen 443 ssl http2;
    server_name gah.example.com;
    # ssl_certificate / ssl_certificate_key ...

    client_max_body_size 100m;           # 上传附件
    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;             # SSE
        proxy_read_timeout 1h;
    }
}
```

然后访问 `https://gah.example.com/?gah_token=<令牌>`。暴露到公网时，令牌务必足够长，最好再在反代层加一层 IP 白名单或 Basic Auth。
