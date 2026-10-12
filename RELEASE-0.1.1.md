# 0.1.1 更新说明

**发布日期**：2026-10-12

本次更新带来**跨平台支持**（macOS / Linux），并修复了若干会导致配置失效或崩溃的问题。

---

## 升级步骤

### 如果你已经装过 0.1.0

```bash
# 1. 停掉旧的中继（可选，install 会自动处理端口占用）
node src/cli.js uninstall

# 2. 更新代码后重新安装
node scripts/install.mjs

# 3. 重启 MiMo Desktop 使其重新读取配置
```

> ⚠️ **必须重新运行 install**。0.1.0 写入的配置含有非法字段
> （根级标记 + 错误的 `output` 位置），会被 MiMo Desktop 拒绝加载并提示「配置文件有误」。
> 重跑 install 会生成一份通过 schema 校验的配置。

### 首次安装

```bash
node scripts/install.mjs
```

Windows 也可以继续用 `powershell -ExecutionPolicy Bypass -File scripts\install.ps1`。

---

## 新增

### 推理等级可选

23 个推理模型现在可以在 MiMo Desktop 里选择思考强度（`low` / `medium` / `high` / `xhigh` / `max`）。

档位不是猜的——上游会校验 `reasoning_effort`，不支持的档位返回
`400 模型不支持该思考强度`，所以探测结果可以当真。实测 `space-bunny` 的 `xhigh`
确实产生明显多于 `low` 的思考内容。

想为更多模型启用（每个档位需一次真实请求，会消耗额度）：

```bash
node src/cli.js install --probe-efforts
```

### 跨平台安装

一份 `scripts/install.mjs` 覆盖三个平台，自启方式自动选择：

| 平台 | 自启方式 |
|---|---|
| Windows | 注册表 Run 键 |
| macOS | launchd agent（`~/Library/LaunchAgents/`） |
| Linux | systemd user unit |

### 实时倍率查询

```bash
node src/cli.js status --rates
```

倍率**不再写进模型名**。配置里的名字是静态字符串，App 启动读一次后不再更新，
写入倍率会在上游调价后长期显示过期价格。现在模型名保持干净，倍率按需实时查询。

### doctor 体检

```bash
node src/cli.js doctor
```

9 项检查，每项失败都给出具体修法。

---

## 修复

### 配置被 App 拒绝加载（重要）

MiMoCode 的 schema 在**根 / provider / model / limit 四层**都是
`additionalProperties: false`——多一个字段**不是被忽略，而是整份配置失效**。

0.1.0 写入了两个非法字段，均已修复：

| 错误 | 修正 |
|---|---|
| 根级 `mimoWorkbuddyConnect` 标记 | 移除；改用固定 provider id + `apiKey` 哨兵值识别归属 |
| model 级 `output` | 移入 `limit.output`（该对象要求 `context` 与 `output` 同时存在） |

现在 `writeConfig()` 落盘前**强制校验**，不合规就抛错并保持原文件不动。

### macOS 崩溃

`protection.js` 缺少 `homedir` 导入，macOS 分支必然抛 `ReferenceError`。
Windows 走另一分支所以从未暴露——这类"只在新平台炸"的问题还有可能存在，
详见下方平台支持说明。

### 状态目录位置错误（macOS）

原本会落到 `~/.local/state`（Linux 约定）。已改为 `~/Library/Application Support`。

### 不可用模型重新出现

探测缓存只记录了「接受的档位」，没记录「模型不可用」。空列表有两种含义，
缓存命中时无法区分，导致 6 个调不动的模型又回到选择器里。已修复。

### 档位被误删

单次探测偶发超时会被误判为「不支持」，导致可用档位被删。现在重试 3 次，
且**模糊结果一律排除、绝不当成支持**。

---

## 平台支持

| 平台 | 状态 |
|---|---|
| **Windows** | ✅ **已实机验证**（开发平台，全链路实测通过） |
| **macOS** | ⚠️ 代码已适配，**未实机验证** |
| **Linux** | ⚠️ 代码已适配，未实机验证 |

macOS 上已处理：凭据路径、WorkBuddy 可执行文件位置、状态目录、launchd 自启。

**但有一个关键未验证点**：macOS 获取凭据加密密钥的方式与 Windows 根本不同
（**Keychain vs DPAPI**）。解密模块按 WorkBuddy 自身 Electron 的私有绑定实现，
**这一环在 macOS 上能否工作没有验证过**。

如果你在 Mac 上试了，无论成功还是失败，都欢迎提 issue 反馈。
**请附上 `node src/cli.js doctor` 的输出**——它能直接指出卡在哪一步。

---

## 已知限制

- 依赖 WorkBuddy 客户端接口（**非公开 API**），上游更新后可能需要跟进。
- 国际版（WorkBuddy AI）未经实机验证，需要时用 `WORKBUDDY_AI_AUTH_FILE` 指定。
- 加密凭据解密依赖 WorkBuddy 自身 Electron 的私有绑定。
- 配置变更需**重启 MiMo Desktop** 才生效（官方行为，非本项目限制）。
- 6 个模型出现在上游目录里但账号调不动，已自动剔除。

---

## 完整变更

见 [CHANGELOG.md](./CHANGELOG.md)。
