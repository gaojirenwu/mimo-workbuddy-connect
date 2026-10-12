# Changelog

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.1] — 2026-10-12

跨平台支持，以及若干会导致配置失效或崩溃的修复。

### 新增

- **跨平台安装脚本 `scripts/install.mjs`**：一份脚本覆盖 Windows / macOS / Linux，
  自动选择自启方式——Windows 用注册表 Run 键，macOS 用 launchd agent
  （`~/Library/LaunchAgents/`），Linux 用 systemd user unit。
  支持 `--no-autostart`、`--uninstall`、`--provider=cn|ai|both`。
- **推理等级（reasoning effort）**：通过 MiMoCode 的 `model.variants` 暴露可选档位。
  实测 23/29 个推理模型获得了档位选择，且经真实验证确实改变模型行为。
- **档位探测**（`install --probe-efforts`，可选）：上游大多不声明支持哪些档位，
  本项目通过真实请求探测，结果按账号缓存 14 天。
- `status --rates`：**实时**查询积分倍率与促销徽章。
- `doctor` 命令：全链路体检，每项失败给出具体修法。
- 完全离线的测试套件（57 个测试），可安全用于 CI。

### 修复

- **配置 schema 违规导致 App 拒绝加载**（影响 0.1.0）。
  MiMoCode 在**根 / provider / model / limit 四层**均为 `additionalProperties: false`，
  多一个字段不是被忽略而是**整份配置失效**。此前写入了两个非法字段：
  - 根级 `mimoWorkbuddyConnect` 标记 → 已移除，改用结构识别（固定 provider id + `apiKey` 哨兵值）
  - model 级 `output` → 已移入 `limit.output`（`limit` 要求 `context` 与 `output` 同时存在）
  现在 `writeConfig()` 落盘前强制校验，不合规就抛错并**保持原文件不动**。
- **`protection.js` 缺少 `homedir` 导入**，导致 macOS 分支必然抛
  `ReferenceError`。Windows 走 `LOCALAPPDATA` 分支所以从未暴露。
- **状态目录在 macOS 上使用 Linux 约定**（`~/.local/state`），
  已改为按平台取值（macOS `~/Library/Application Support`）。
- **探测缓存丢失「模型不可用」标记**：空档位列表无法区分
  「账号调不动」与「没有档位被接受」，导致缓存命中时不可用模型重新出现在选择器里。
- **单次探测会假性失败**：偶发超时被误判为「不支持该档位」，导致可用档位被误删。
  现在重试 3 次，且 `inconclusive` 结果一律排除、**绝不当成支持**。

### 变更

- **倍率不再写入模型名**。配置里的模型名是静态字符串，MiMo Desktop 启动时读一次后不再更新，
  写入倍率会在上游调价后长期显示**过期价格**。现改为只在 `status --rates` 里实时展示。
- 6 个上游目录中列出但**账号无法调用**的模型（`glm-4.6`、`glm-4.7`、`glm-4.6v`、
  `glm-5.0`、`minimax-m2.5`、`kimi-k2-thinking`）自动从配置中剔除，避免选中后必然报错。
- 需要真实账号的验证脚本移至 `test/manual/`，避免误入 CI。

### 平台支持

| 平台 | 状态 |
|---|---|
| Windows | ✅ 已实机验证（开发平台） |
| macOS | ⚠️ 代码已适配，**未实机验证** |
| Linux | ⚠️ 代码已适配，未实机验证 |

macOS 上凭据加密密钥的获取方式与 Windows 根本不同（Keychain vs DPAPI），
**这一环未经实机验证**。`doctor` 会明确报出失败在哪一步。

### 已知限制

- 依赖 WorkBuddy 客户端接口（非公开 API），上游更新后可能需要跟进。
- 国际版（WorkBuddy AI）未经实机验证，需要时用 `WORKBUDDY_AI_AUTH_FILE` 指定。
- 加密凭据解密依赖 WorkBuddy 自身 Electron 的私有绑定。
- 配置变更需**重启 MiMo Desktop** 才生效（官方行为）。

---

## [0.1.0] — 2026-10-12

首个版本。

- 复用 WorkBuddy 桌面 App 的登录状态（含 5.6+ 静态加密凭据的解密）
- 实时拉取模型目录（国内版实测 33 个模型）
- 本地 OpenAI 兼容中继，仅监听 `127.0.0.1`
- 流式输出、工具调用、多轮对话、图片输入
- 写入 MiMoCode 的 `provider` 配置，模型出现在 MiMo Desktop 选择器中
- 上游 401/403 自动刷新 token 并重试，每 30 分钟定时刷新
