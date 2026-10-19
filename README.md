# CIKE

本地多开指纹浏览器 + 本地自动化 API。Clean-room 实现，仅用于学习研究，
无任何厂商后端依赖，所有数据只存本机。

架构思路借鉴自对 Electron 指纹浏览器客户端的静态分析
（Koa 本地 API + 端口发现 + token 鉴权），代码全部重写。

## 功能

- **Profile 管理**：每个 profile 独立用户数据目录（cookie / storage / 缓存持久化），
  可配 UA、平台（mac/win）、viewport、locale、时区、地理位置、单 profile 代理。
- **指纹伪装（JS 层）**：
  - `navigator.webdriver` 隐藏、plugins/mimeTypes、`window.chrome`、`chrome.runtime`
  - languages（Playwright locale 保证与 Accept-Language 一致，不用 stealth 的硬编码覆盖）
  - **UA 跟随真实内核版本**：运行时实测 Chromium 版本（`browser.version()`），
    UA / Client Hints 三方一致，不会出现"UA 说 156、内核是 131"的穿帮
  - **Client Hints 一致性**：`navigator.userAgentData` 在原型链上打补丁
    （实例仍是真正的 NavigatorUAData，只改返回值；`getHighEntropyValues` 保持原生，
    覆盖它会被检测）
  - **Canvas 噪声（默认关闭，可选）**：browserscan 对**任何** canvas 像素修改都判"篡改"扣 5%
    （Brave 内置随机化也被扣），要满分必须保持 canvas 纯净。
    需要多环境去关联时，可在 profile 里开启 `canvasNoise`（恒定通道偏移 + 函数原生伪装）
  - **AudioContext 噪声**：`getChannelData` 注入恒定微小偏移（不被检测）
  - **函数原生伪装**：被 patch 的函数经 `Function.prototype.toString` 拦截，
    `fn.toString()` / `Function.prototype.toString.call(fn)` / `hasOwnProperty` 检查都返回原生字样
  - **WebRTC 防泄漏**：绑定代理时自动用 `disable_non_proxied_udp`，真实 IP 不经 STUN 泄漏
  - **硬件指纹按 profile 独立**：hardwareConcurrency / deviceMemory（mac 8/10/12 核等）
  - WebGL vendor/renderer 伪装（stealth 插件）
  - viewport、deviceScaleFactor、colorScheme、timezone、locale、geolocation
- **本地多开**：每个 profile 独立 Chromium 进程 + 独立远程调试端口
  （`--remote-debugging-port`，外部工具可经 CDP 接入）。
- **Local API**（Koa，127.0.0.1）：
  - 端口在 4440–4539 自动选取，实际地址写入数据目录的 `local_api_url.txt`
  - token 鉴权（`?token=` 或 `x-api-token` 头），token 存 `api_token.txt`，首次启动打印
  - 接口：`getVersion / profiles / openBrowser / closeBrowser / checkOpen / openedList / closeAllBrowsers`

## 桌面版（macOS DMG）

发布页提供 `CIKE-版本号-mac-arm64.dmg`，支持 **苹果 M 系列芯片、macOS 13 及以上**，不支持 Intel Mac。
侧边栏含 **Profiles / Proxies / Settings**。

本项目使用免费的临时签名（ad-hoc），构建时会验证应用签名和 DMG 完整性。
**未使用苹果开发者证书，也未经过苹果公证**，首次打开需要用户自行确认来源并允许运行。

安装与首次打开：

1. 从本仓库 Releases 下载 DMG，将 CIKE 拖入「应用程序」，然后推出磁盘镜像。
2. 从「应用程序」打开 CIKE；若系统阻止，前往「系统设置 → 隐私与安全性」，找到刚才的拦截记录，点击「仍要打开」，按提示确认。
3. 如果仍提示已损坏或没有放行按钮，确认文件来自本仓库、并可用发布页的 `SHA256SUMS.txt` 核对下载文件后，只移除此应用的下载隔离标记：

   ```bash
   xattr -dr com.apple.quarantine /Applications/CIKE.app
   ```

   然后再次打开。无需关闭系统安全机制；这一步仅针对 CIKE。临时签名不验证开发者身份，文件校验和也不等同于苹果公证。

首次使用：

1. 打开后进 **Settings**，点 **Download Chromium**（约 170MB，一次）
2. **Proxies** 页点 Add Proxy，按 `host:port:user:pass` 每行一个批量导入，
   选中后 Check Proxy 看出口 IP
3. **Profiles** 页点 + New Profile：起名、选平台、关联代理，
   高级里可调时区/语言/分辨率
4. 点 Open 弹出独立浏览器窗口，即多开

数据在 `~/.local-fingerprint-browser/`，删目录即清零。

## 命令行版（Node API）

```bash
# 1. Node.js >= 22
node -v

# 2. 安装依赖
npm install

# 3. 下载 Chromium（一次）
npx playwright install chromium
# 注：若下载失败（如受限网络），可手动下载 Chrome for Testing
# 并用环境变量指向：LFB_CHROMIUM_EXECUTABLE=/path/to/chrome npm start

# 4. 启动 API 服务
npm start
# 输出示例：
# [LocalAPI] listening on http://127.0.0.1:4447/
# [LocalAPI] api token: <token>
```

```bash
# 创建 profile（mac 指纹）
curl -X POST http://127.0.0.1:4447/api/profiles?token=<token> \
  -H 'Content-Type: application/json' \
  -d '{"name":"shop-01","platform":"mac","locale":"en-US","timezone":"America/New_York"}'

# 打开浏览器（有头模式，直接弹出窗口）
curl -X POST http://127.0.0.1:4447/api/openBrowser?token=<token> \
  -H 'Content-Type: application/json' \
  -d '{"profile_id":"p_xxxx","headless":false}'

# 查询 / 关闭
curl 'http://127.0.0.1:4447/api/checkOpen?token=<token>&profile_id=p_xxxx'
curl -X POST http://127.0.0.1:4447/api/closeBrowser?token=<token> \
  -H 'Content-Type: application/json' -d '{"profile_id":"p_xxxx"}'
```

带代理的 profile：

```json
{
  "name": "shop-02",
  "platform": "win",
  "proxy": { "server": "http://127.0.0.1:7890", "username": "", "password": "" },
  "geolocation": { "latitude": 40.7128, "longitude": -74.006, "accuracy": 100 }
}
```

## 烟雾测试

```bash
npm run smoke
```

测试内容：profile 增删改查、双 profile headless 打开、指纹探针
（webdriver 隐藏、plugins、platform/UA 一致性、canvas 噪声按 profile 区分）、关闭清理。

## 能力边界（必读）

这是 **JS 层** 的指纹伪装，能过常规自动化检测清单
（pixelscan / browserleaks 的基础项、"是否 webdriver" 类判断）。
但它**不是**商业指纹浏览器的 native 级方案，以下不在 v1 范围：

- TLS / JA3 指纹（Chromium 原生握手特征，需 C++ 层补丁）
- WebGL 指纹的深层一致性伪装（只做 vendor/renderer 层面）
- 字体指纹、音频指纹的高级混淆
- CreepJS 这类交叉一致性引擎的全部对抗

如果某天需要更进一步，路线是：自行编译打补丁的 Chromium，
或以本项目的 profile/API 层为上层，替换底层启动器。

## 数据位置

默认 `~/.local-fingerprint-browser/`（可用 `LFB_DATA` 环境变量改）：
`profiles.json`、`profiles/<id>/`、`local_api_url.txt`、`api_token.txt`。
删目录即删全部数据。
