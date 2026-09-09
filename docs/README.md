# CardVault Upload for Bunny

Bunny / Vendetta 插件，版本 1.1.2。将 Discord 的 PNG 和 JSON 附件保存到 CardVault。

## 1.1.2 图片菜单位置调整

PNG 上传入口改为图片预览右上角的“…”弹出菜单，与 Save、Share、Open in Browser 并列，排列在 Save 后面；移除 PNG 在消息长按菜单中的入口。JSON 附件继续使用消息长按菜单，也可在插件设置中粘贴附件链接上传。

新菜单适配使用 `useMediaShareActions` 获取当前图片，并通过 `ContextMenu` 的原生菜单项添加操作。通过图片操作回调关联来源，不使用全局“最后一张图片”，避免同时存在多个查看器时串图。普通 Save 保持保存到相册的行为。

这一版本的原生菜单适配已通过本地模拟测试，仍需在实际手机版本确认显示；若手机上没有入口，请提供 Discord 版本和图片菜单截图。

## 1.1.1 修复说明

修复 1.1.0 保留 ES `class` 导致部分 Discord 使用的 Hermes 引擎无法加载的问题。现对最终打包文件统一转译为 ES5，并通过 Hermes 0.11 编译检查。

已上传过 1.1.0 的用户：将新版压缩包中的文件覆盖到同一个仓库并提交，尤其要同步更新 `docs/index.js` 和 `docs/manifest.json`。等待 Pages 重新部署完成，然后在 Bunny 插件信息页面检查更新；如果仍使用缓存，可卸载这个插件并用原 Pages 链接重新安装。不需要新建仓库，也不需要重新设置 Pages。

本版本按用户要求内置账号 `card2` 和密码 `2`。首次启动自动登录，令牌保存在本机；启动、回到前台和前台运行每 5 分钟检查连接，遇到 401 自动登录并重试一次。无需手动输入账号密码。

## 上传 GitHub 并安装

已编译好，不需要电脑安装 Node.js 或运行构建命令。

1. 解压压缩包，在 GitHub 新建一个仓库，例如 `cardvault-bunny`，默认分支使用 `main`。
2. 进入仓库，选择 **Add file > Upload files**，将解压后的文件和文件夹上传到仓库根目录。不要只上传 ZIP；根目录应能看到 `docs`、`src`、`README.md` 等。
3. 打开仓库 **Settings > Pages**。
4. 在 **Build and deployment** 中将 Source 设为 **Deploy from a branch**，Branch 选 **main**，Folder 选 **/docs**，然后 Save。
5. 等待 Pages 部署成功（可以在 Actions 页面查看状态）。
6. 在手机 Bunny 的 **Settings > Plugins > Install a plugin** 中填入：

```text
https://你的GitHub用户名.github.io/cardvault-bunny/
```

仓库名字不叫 `cardvault-bunny` 时，替换为实际仓库名。安装链接是 Pages 目录地址，不是 `github.com` 仓库页面，也不需要添加 `/docs/` 或 `/manifest.json`。

检查发布是否成功，可以在上述链接后添加 `manifest.json`。页面应显示包含 `name`、`main` 和 `hash` 的 JSON。

若 GitHub 网页上传省略了 `.gitignore` 或 `.nojekyll` 这类点开头的文件，不影响插件的 `index.js` 和 `manifest.json` 使用。

## 使用

- PNG：打开图片预览，点右上角“…”菜单，在 Save 下方选择“保存到 CardVault”。消息长按菜单不再显示 PNG 的入口。
- JSON：长按含 JSON 附件的消息，使用“保存到 CardVault”。多附件会列出各自文件名。
- 如果当前 Discord 版本菜单没有显示该项：复制 PNG / JSON 附件的直接下载链接，在插件设置的“附件链接上传”中粘贴后上传。需要附件链接，不能使用消息跳转链接。
- 插件设置可以查看登录状态、“检查连接”，或修改 CardVault API 地址。
- 仅处理 PNG / JSON，单文件上限 25 MB；普通 PNG 是否可入库仍由 CardVault 服务端判定。重复文件会显示“卡库中已存在此文件”。

默认 API 地址沿用原仓库：`http://aaa.xixisillytavern.top:8788`。如果连接失败，请确认此服务仍可从手机访问；如果服务提供 HTTPS，建议在插件设置中替换。GitHub Pages 仅分发插件，卡片仍上传到该 CardVault 服务。

## 登录行为与隐私

“保持登录”指自动恢复会话，不能使服务器令牌永不过期。手机系统暂停 Discord 后定时器也会暂停，回到前台或下一次上传时恢复检查。断网、密码被修改或服务器停机时无法登录。

内置密码会出现在源码及编译文件中，任何能下载插件的人都可以读取；本版本按用户指定采用这一配置。密码不做加密伪装。插件仅将选定的附件上传到卡库，不转发 Discord 账号令牌或聊天文本。

## 修改与重新构建

需要 Node.js 22.18 或更新版本。在仓库根目录运行：

```sh
npm ci
npm run build
npm test
```

构建会更新 `dist/` 和 `docs/` 下的文件，并重新生成 `manifest.json` 的 SHA-256 `hash`。发布修改时，需要把更新后的 `docs/` 文件一并上传到 GitHub。Bunny 开启插件自动更新时会按 hash 检查新版本。

## 验证范围

已进行本地构建、登录/过期重试/上传模拟测试，以及 Bunny 加载格式和菜单模拟测试，并通过 Hermes 0.11 编译检查。未在用户的 iPhone / Bunny 上实机测试，也没有向线上卡库上传测试数据。菜单适配以公开 Bunny 和 Vendetta 源码为依据，Discord 版本更新可能需要进一步调整。

开发时可运行 `npm run test:hermes -- 你的hermesc可执行文件路径`，对每次构建执行真正的 Hermes 编译检查。
