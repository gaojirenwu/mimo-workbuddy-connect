# mimo-workbuddy-connect

把 **WorkBuddy 桌面 App** 里的模型（GLM-5.3、DeepSeek-V4-Pro、Kimi-K3、MiniMax-M3、Hy3 等）接入 **小米 MiMo Desktop（MiMoCode）**，零配置使用。

这是 [`dsh-workbuddy-connect`](https://github.com/corrinehu/dsh-workbuddy-connect) 的**兄弟实现**：功能一致（复用 WorkBuddy 自己的登录、拉取模型目录、图片输入、推理档位、积分显示），但接入的宿主不是 DeepSeek Harness，而是 MiMo Desktop。

---

## 为什么是「本地中继 + provider 配置」而不是 MiMoCode 插件

这一点是本项目最重要的设计决定，值得先讲清楚。

MiMoCode（MiMo Desktop 的内核）确实有插件机制 `@mimo-ai/plugin`，但它**在 MiMo Desktop 上不可用**。官方仓库 `XiaomiMiMo/MiMo-Code` 的 `compose/spec/plugin-host-sdk.md` 写得很明确：

> On Bun, `PluginHost.provideSdk()` registers `@mimo-ai/plugin`, `/tool` and `/tui` as host-provided virtual modules…
> **When the runtime cannot serve the SDK (the Node build used by Desktop)** … only plugins whose source lies inside `MIMOCODE_CONFIG_DIR` load …
> Directory plugins written by users are only half supported there: **they load, but a plugin that imports the SDK fails to resolve.**

也就是说：**Desktop 用的是 Node 运行时，SDK 只供给 Bun；在 Desktop 上写 provider 插件会 import 失败。**

所以本项目走 MiMoCode 官方支持、且在 Desktop 上确定可用的那条路：**声明式 `provider.<id>` 配置**（见官方 README 的 "Custom OpenAI-Compatible Endpoints"，以及 `provider-local-refresh.md` 中可热刷新的配置面正是 `provider` / `model` / `enabled_providers` 等）。

于是架构是：

```
MiMo Desktop (MiMoCode)
   │  读 mimocode.jsonc 里的 provider.workbuddy
   ▼
http://127.0.0.1:8791/v1        ← 本项目的本地中继（仅回环）
   │  带上 WorkBuddy 自己的 token
   ▼
https://copilot.tencent.com/v2/chat/completions
```

这不是「绕开」官方机制，而是**在官方机制里选了那条在 Desktop 上真正能跑通的路**。

---

## 快速开始

前置：Windows，已安装并**登录** WorkBuddy 桌面 App；Node.js ≥ 22.19 或 ≥ 24。

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

脚本会（可重复执行）：

1. 检查 WorkBuddy 登录状态；
2. 把 provider 配置写进 MiMoCode 的配置文件；
3. 注册当前用户登录自启，并立即启动中继；
4. 用 `/health` 验证中继。

然后**重启 MiMo Desktop**（或刷新窗口），模型选择器里就会出现 WorkBuddy 的模型。

只接国际版 / 两个都要：

```powershell
... -File scripts\install.ps1 -Provider ai
... -File scripts\install.ps1 -Provider both
```

只要配置、不要自启：

```powershell
... -File scripts\install.ps1 -NoAutostart
```

卸载：

```powershell
... -File scripts\install.ps1 -Uninstall
```

---

## 命令行

```powershell
node src\cli.js status      # 登录状态、账号、模型数
node src\cli.js doctor      # 全链路体检，每项失败都给具体修法
node src\cli.js install     # 写 provider 配置
node src\cli.js refresh     # 重新拉目录并更新配置
node src\cli.js uninstall   # 移除配置
node src\cli.js serve       # 前台运行中继
```

`doctor` 输出示例：

```
  ok    WorkBuddy auth file
  ok    WorkBuddy Electron binary (for encrypted tokens)
  ok    WorkBuddy sign-in          app-encrypted, account 98e913e6-…
  ok    WorkBuddy model catalog    33 models (live)
  ok    provider written to MiMoCode config
  ok    configured relay URL matches the running relay
7/7 checks passed
```

---

## 功能

- **零配置复用登录**：读 WorkBuddy App 自己的凭据，不另开 OAuth。账号切换自动跟随。
- **加密凭据透明解密**：WorkBuddy 5.6+ 把 token 加密落盘，本项目用**它自己的 Electron 二进制**取出密钥（仅内存，不落盘、不写日志）后解开。
- **完整模型目录**：`/v3/config` 实时拉取，失败时回退到上次保存的副本。
- **图片输入**：多模态模型可直接发图。
- **推理档位**：上层声明的档位写进 provider 配置。
- **积分与徽章**：`/health` 与 `status` 显示账号、倍率、剩余积分。
- **流式 / 工具调用 / 多轮**：SSE 原样转发；非流式时把 SSE 聚合成一个 completion，按 index 正确重组 `tool_calls` 参数。
- **会话自愈**：上游 401/403 时自动刷新 token 并重试一次；每 30 分钟定时刷新；App 重新登录后自动重读凭据。

---

## 与 dsh-workbuddy-connect 的对应关系

| 能力 | dsh-workbuddy-connect | 本项目 |
|---|---|---|
| 宿主 | DeepSeek Harness（Cordis 插件） | MiMo Desktop / MiMoCode |
| 接入方式 | 进程内注册 LLM provider | 本地中继 + 声明式 `provider` 配置 |
| 凭据来源 | WorkBuddy App auth 文件（含加密） | 同左 |
| 上游协议 | `/v2/chat/completions`、`/v3/config` | 同左 |
| 模型选择器 | DSH 客户端 UI 插件 | MiMoCode 原生 provider 列表 |
| 设置界面 | DSH 设置卡片 | `status` / `doctor` 命令行 |

上游线协议（请求头、`developer`→`system` 改写、`tool_choice` 展平、错误分类、计费解析）都是从 dsh-workbuddy-connect 移植的，其源头是 MIT 的 [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)。

---

## 已验证行为

在真实账号上实测通过：

- 解密真实加密凭据（`accessToken` 1327 字符）；
- 拉取 **33 个模型**实时目录；
- 流式：11 个 SSE 帧，首帧 4ms；
- 非流式、`stream_options`、多轮历史、`temperature`/`top_p`/`max_tokens`；
- 工具调用：`tool_calls` 参数正确重组，并能作为历史回传续轮；
- 视觉：真实图片理解；
- 未知模型名回退、空 `messages` 明确报错、未登录返回 401、积分不足返回 402。

单元与离线集成测试（**不需要任何账号或密钥**，可直接上 CI）：

```powershell
node test\run.mjs      # 55 passed, 0 failed
```

需要本机已登录 WorkBuddy 的手工验证脚本在 `test\manual\`（会真实发请求、消耗额度，CI 里不要跑）：

```powershell
node test\manual\live.mjs            # 目录 + 一次对话
node test\manual\live-stream.mjs     # 流式 / 工具调用 / 视觉
node test\manual\probe-effort.mjs    # 探测档位
```

---

## 配置写在哪

MiMoCode 的全局配置目录按引擎自己的规则解析（从 MiMo Desktop `26.1010` 实测反推）：

```
MIMOCODE_HOME（须为绝对路径）  ->  <home>/config
否则 XDG_CONFIG_HOME          ->  <xdg>/mimocode
否则                              <用户目录>/.config/mimocode
```

**注意：Windows 上也是 `.config`，不是 `%LOCALAPPDATA%`。** MiMo Desktop 自己就在
`~/.config/mimocode` 下生成 `mimocode.jsonc`，并为 `@mimo-ai/plugin` 在该目录执行 npm 安装。
写到别处会得到一个 App 永远不读的配置——这一点最初做错过，现已修正，并有测试锁定该行为。

实际文件（Windows）：

```
C:\Users\<你>\.config\mimocode\mimocode.jsonc
```

本项目只增删 `provider.workbuddy`（或 `provider.workbuddy-ai`）与 `mimoWorkbuddyConnect` 标记，**其余配置原样保留**；`uninstall` 也只移除自己写的那部分。可用 `MIMOCODE_HOME` 覆盖。

写入格式与 MiMo Desktop「设置 → 模型」里手动添加自定义模型**完全一致**
（`provider.<id>.{name, npm, models, options.{baseURL, apiKey}}`），
所以两种方式操作的是同一份数据，可以互相覆盖。

### 配置必须通过 schema 校验（重要）

MiMoCode 的配置 schema 在**根、provider、model、limit 四层都是 `additionalProperties: false`**。
也就是说：多写一个未知字段**不是被忽略，而是整份配置失效**，App 会直接报「配置文件有误」并拒绝加载。

本项目早期版本踩过两个坑，现已修复且有测试锁定：

| 错误写法 | 后果 | 正确写法 |
|---|---|---|
| 根级 `mimoWorkbuddyConnect` 标记 | 未知顶层字段 → 整个文件失效 | 不放标记；靠固定的 provider id + `apiKey` 哨兵值识别归属 |
| model 级 `output` | 未知字段 → 整个文件失效 | 放进 `limit.output`；且 `limit` 要求 `context` 与 `output` **同时存在**，缺一就整个不写 |

因此 `writeConfig()` 在落盘前会先跑 `validateConfigDocument()`，
发现不合规就**抛错并保持原文件不动**，绝不会写出一个让 App 打不开的配置。

`node src\cli.js doctor` 也会校验当前配置并给出具体修法。

### 积分倍率：只在 `status --rates` 里看

**倍率不写进配置**，只通过命令行动态查询：

```powershell
node src\cli.js status --rates
```

原因是配置里的模型名是**静态字符串**——MiMoCode 启动时读一次，之后不会再问上游。
把倍率烧进名字里，一旦 WorkBuddy 调价就会一直显示**过期的旧倍率**；
而一个理直气壮的错数字，比没有数字更糟。所以模型名保持干净：

```jsonc
"deepseek-v4-pro": { "name": "Deepseek-V4-Pro" }   // 只有名字
```

`status --rates` 则是**实时**的（当场拉上游目录），永远反映当前价格：

```
WorkBuddy rates (live from upstream)
  deepseek-v4-pro          x0.51
  deepseek-v4.1-flash      x0.11
  glm-5.3                  x0.79
  ...
```

促销徽章（限时免费 / 夜间折扣）同理，也只在 `status --rates` 里出现。

想更新模型目录本身（新上架 / 已下架模型），用 `refresh` 或 `install`，然后重启 App。

### 推理等级

MiMoCode 的 `model.variants` 会被**合并进内置档位（配置优先）**，且 variant 的 key 会成为界面上可选的档位。
本项目用它把 WorkBuddy 的思考强度暴露成可选项：

```jsonc
"deepseek-v4-pro": {
  "reasoning": true,
  "options": { "reasoningEffort": "high" },   // 不发档位时的基准
  "variants": {
    "low":    { "reasoningEffort": "low" },
    "high":   { "reasoningEffort": "high" },
    "xhigh":  { "reasoningEffort": "xhigh" },
    "max":    { "reasoningEffort": "max" }
  }
}
```

**档位从哪来**（上游大多数模型并不声明自己支持哪些档位）：

1. **上游声明的**直接采用——权威且零成本（7 个模型属于此类）；
2. **没声明的**用 `--probe-efforts` 主动探测（见下）。

上面那 4 个档位是实测出来的，不是猜的：上游会**校验** `reasoning_effort`，
不支持的档位返回 `400 模型不支持该思考强度，请调整`，所以探测结果可以当真。
实测 `space-bunny` 的 `xhigh` 确实产生了比 `low` 多得多的思考内容，档位是真实生效的。

**探测是可选操作**，因为每个档位都要发一次真实请求：

```powershell
node src\cli.js install --probe-efforts
```

- 结果按账号缓存（14 天），重复运行不重复花钱；
- 单档位请求用 `max_tokens: 1`，开销极小；
- **探测不出结果时不会瞎猜**：`inconclusive`（超时等）的档位会**排除**而不是当成支持；
- 探测失败会重试 3 次——实测单次探测偶尔会假性失败，重试后才准。

实测结果：**23 / 29** 个推理模型拿到了可选档位。

另外有 6 个模型（`glm-4.6`、`glm-4.7`、`glm-4.6v`、`glm-5.0`、`minimax-m2.5`、`kimi-k2-thinking`）
虽然出现在目录里，但账号**根本调不动**（任何请求都返回「当前模型不可用，请切换模型」，与档位无关）。
这些模型会被直接**从配置里剔除**，免得选上去必然报错。

中继始终只监听 `127.0.0.1`，端口固定 `8791`（国际版 `8792`）。端口固定是刻意的：配置文件里记的就是这个地址，若端口每次变化，配置立刻失效。

图形界面入口：**设置 → 模型 / Providers**（填模型名 + 以 `/v1` 结尾的 baseURL），可用于查看或手改。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `MIMO_WORKBUDDY_PORT` | `8791` / `8792` | 覆盖中继端口 |
| `MIMO_WORKBUDDY_HOME` | `%APPDATA%\mimo-workbuddy-connect` | 状态与日志目录 |
| `MIMOCODE_HOME` | `~/.config/mimocode` | MiMoCode 配置目录（设为绝对路径时用 `<home>/config`） |
| `WORKBUDDY_AUTH_FILE` | 自动 | 显式指定 auth 文件（国内版） |
| `WORKBUDDY_AI_AUTH_FILE` | 自动 | 同上（国际版） |
| `WORKBUDDY_ELECTRON_BIN` | 自动探测 | WorkBuddy 可执行文件，用于取解密密钥 |

---

## 安全说明

- 凭据仅在内存中使用；解密密钥同样只在内存，**不落盘、不写日志**。
- 中继仅监听回环地址，默认不暴露局域网。
- 中继的 `apiKey` 是占位符；真正的鉴权用的是 WorkBuddy App 自己的登录。
- 工具读取的是**当前机器当前用户自己登录的** WorkBuddy 凭据，仅供本人使用。
- 调用消耗的是你自己的 WorkBuddy 额度。

---

## 已知限制

- 上游依赖 WorkBuddy 客户端接口（非公开 API），WorkBuddy 更新后可能需要跟进。
- 国际版（WorkBuddy AI）的 auth 路径与 Electron 位置未经实机验证，必要时用环境变量指定。
- 加密凭据解密依赖 WorkBuddy 自身 Electron 的私有绑定；若上游更换实现，需重新对齐（`doctor` 会明确报出是哪一步失败）。
- Desktop 上的 provider 配置**需要重启 MiMo Desktop 生效**（官方 `provider-local-refresh` 说明：静态配置变更需显式重启）。

---

## 免责声明

- 本项目仅供个人学习与研究使用，仅驱动使用者自己的 WorkBuddy 账号在本机调用，请勿用于商业用途。
- 使用者需遵守 WorkBuddy 与小米 MiMo 各自的服务条款；因使用本项目产生的任何后果由使用者自行承担。
- 本项目与腾讯、WorkBuddy、小米、MiMo 均无关联，未获其授权或认可；相关名称仅用于描述兼容关系。

## 许可证

[MIT](./LICENSE)

## 致谢

- [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) — 上游线协议、凭据链与解密 AAD 的参照实现。
- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（MIT）— WorkBuddy 协议原始参照。
- [g1at/MiMoDesktopRelay](https://github.com/g1at/MiMoDesktopRelay) — 验证了「MiMo 侧走本地中继」这条路可行。
- [XiaomiMiMo/MiMo-Code](https://github.com/XiaomiMiMo/MiMo-Code) — provider 配置与插件宿主策略的依据。
