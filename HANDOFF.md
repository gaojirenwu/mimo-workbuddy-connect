# 交接文档：把 `mimo-workbuddy-connect` 发布到 GitHub

> 这份文档是给**另一个 AI agent** 的完整交接。读完即可独立完成发布，不需要再问原作者。
> 文档里的事实都来自本机实测，不是推测；凡是我没能验证的，都明确标注了。

---

## 0. 一句话背景

**把 WorkBuddy 桌面 App 里的模型（33 个）接进小米 MiMo Desktop**，零配置使用。
它是 [corrinehu/dsh-workbuddy-connect](https://github.com/corrinehu/dsh-workbuddy-connect) 的**兄弟实现**：
功能一致，但宿主从 DeepSeek Harness 换成了 MiMo Desktop。

**当前状态：已在本机完整跑通并通过实测**，代码、文档、测试都齐了，只差推到 GitHub。

---

## 1. 项目位置与当前状态

| 项 | 值 |
|---|---|
| 源码目录 | `C:\Users\54389\Documents\deepseek-harness\default-workspace\mimo-workbuddy-connect` |
| 源码行数 | `src/` 共 **2940 行**（10 个模块） |
| 测试状态 | **55 passed, 0 failed**（`node test/run.mjs`） |
| 许可证 | MIT（`LICENSE` 已存在） |
| 编码 | 全部 UTF-8 无 BOM，已扫描确认无乱码 |
| 敏感信息 | 已扫描，**无任何硬编码 token / 密钥** |

### ⚠️ 本机环境的关键限制

```
git   : 未安装（命令不存在）
gh    : 未安装
node  : v24.18.0
npm   : 11.16.0
```

**所以本机无法直接 `git init` + push。** 你有两条路，见第 6 节。

---

## 2. 文件清单

### 要发布的（全部）

```
mimo-workbuddy-connect/
├── .gitignore
├── LICENSE                      MIT
├── README.md                    181 行，中文为主（已含架构说明/限制/免责声明）
├── package.json                 见第 4 节，发布前需微调
├── scripts/
│   ├── install.ps1              一键安装 + 注册登录自启（Windows）
│   └── relay-hidden.cmd         隐藏窗口启动中继
├── src/
│   ├── index.js          (253)  组装：VariantRuntime / startAll
│   ├── cli.js            (389)  status / doctor / install / uninstall / refresh / serve
│   ├── auth.js           (284)  读 WorkBuddy 登录凭据（含加密分支）
│   ├── protection.js     (245)  WorkBuddy 5.6+ 静态加密凭据解密
│   ├── upstream.js       (405)  WorkBuddy 线协议 + 档位探测
│   ├── catalog.js        (258)  模型目录解析 / 标签 / 档位 variants
│   ├── provider.js       (448)  MiMoCode 配置读写 + schema 校验
│   ├── probe-store.js    (124)  档位探测结果缓存
│   ├── server.js         (351)  本地 OpenAI 兼容中继
│   └── session.js        (183)  凭据生命周期 + token 定时刷新
└── test/
    ├── run.mjs             55 个测试，纯离线，可安全上 CI  ← 必须发布
    └── manual/             需要真实 WorkBuddy 账号（会消耗额度），CI 里不要跑
        ├── decrypt.mjs
        ├── leftest-effort.mjs
        ├── live-stream.mjs
        ├── live.mjs
        ├── probe-effort.mjs
        ├── rate-freshness.mjs
        ├── shapes.mjs
        └── verify-variants.mjs
```

> 这些 `test/manual/` 脚本已经从 `test/` 移入子目录，并且相对导入已改为 `../../src/`
> （已逐个 `node --check` 并实跑验证过）。

---

## 3. 这个项目做了什么（可直接用作 GitHub 描述）

### 核心机制

MiMoCode（MiMo Desktop 的内核）**在 Desktop 上不能用插件提供 provider**。
证据来自官方仓库 `XiaomiMiMo/MiMo-Code` 的 `compose/spec/plugin-host-sdk.md`：

> On Bun, `PluginHost.provideSdk()` registers `@mimo-ai/plugin`…
> **When the runtime cannot serve the SDK (the Node build used by Desktop)** … a plugin that imports the SDK **fails to resolve**.

所以本项目走**官方支持且在 Desktop 上确定可用**的路：**本地中继 + 声明式 `provider` 配置**。

```
MiMo Desktop (MiMoCode)
   │ 读 ~/.config/mimocode/mimocode.jsonc 里的 provider.workbuddy
   ▼
http://127.0.0.1:8791/v1        ← 本项目的中继（仅回环）
   │ 带上 WorkBuddy 自己的 token
   ▼
https://copilot.tencent.com/v2/chat/completions
```

### 已实测通过的能力

| 能力 | 实测结果 |
|---|---|
| 解密 WorkBuddy 加密凭据（5.6+ `$wbEncrypted`） | ✅ 解出真实 accessToken（1327 字符） |
| 拉取模型目录 | ✅ 33 个模型 |
| 流式 | ✅ 11 个 SSE 帧，首帧 4ms |
| 工具调用 | ✅ `tool_calls` 参数正确重组 + 多轮续接 |
| 视觉 | ✅ 真实图片理解 |
| **推理等级** | ✅ 23/29 个推理模型可选档位，且实测生效 |
| 异常处理 | ✅ 未知模型回退 / 未登录 401 / 积分不足 402 |

### 两个值得写进 README 的技术点

1. **配置 schema 极严**：MiMoCode 在**根 / provider / model / limit 四层**都是
   `additionalProperties: false`——多一个字段不是被忽略，而是**整份配置失效**，
   App 报「配置文件有误」。所以 `writeConfig()` 落盘前强制跑 `validateConfigDocument()`。
2. **倍率不写进配置**：配置里的模型名是静态字符串，写进去会过期；
   倍率只在 `status --rates` 里**实时**查询。这是刻意的设计取舍，值得在 README 说明。

---

## 4. 发布前需要微调的地方

### `package.json` 必改

```jsonc
{
  "name": "mimo-workbuddy-connect",     // 建议先 npm view 确认没被占用
  "version": "0.1.0",
  "description": "…",                    // 已是中英双语，可保留
  "repository": {                        // ← 缺，必须补
    "type": "git",
    "url": "git+https://github.com/<你的用户名>/mimo-workbuddy-connect.git"
  },
  "homepage": "https://github.com/<你的用户名>/mimo-workbuddy-connect#readme",  // ← 补
  "bugs": "https://github.com/<你的用户名>/mimo-workbuddy-connect/issues",       // ← 补
  "author": "<你的名字>",                 // ← 补
  "files": ["src", "README.md", "LICENSE"]   // 建议加 "scripts"
}
```

### 建议补的

- `README.en.md`（英文版；README.md 已是中文）
- `CHANGELOG.md`
- GitHub Actions：跑 `node test/run.mjs`（**纯离线，无需密钥，可安全上 CI**）

---

## 5. 发布前自检清单

在源目录执行，全部应通过：

```powershell
cd C:\Users\54389\Documents\deepseek-harness\default-workspace\mimo-workbuddy-connect

node test/run.mjs                    # 期望: 55 passed, 0 failed
node src\cli.js doctor               # 期望: 9/9 checks passed（需本机已登录 WorkBuddy）

# 确认没有敏感信息
Select-String -Path src\*.js -Pattern "sk-[A-Za-z0-9]{10,}|ghp_[A-Za-z0-9]{20,}"
```

⚠️ **发布前务必确认**：仓库里**不要**包含任何真实 token、`%APPDATA%\mimo-workbuddy-connect`
下的运行时状态文件（`.gitignore` 已覆盖）。

---

## 6. 如何发布（本机没有 git，二选一）

### 方案 A：让本机 agent 装 git 后直接推

```powershell
winget install --id Git.Git -e --source winget
# 重开终端后
cd <源码目录>
git init
git add .
git commit -m "feat: bring WorkBuddy models into MiMo Desktop"
git branch -M main
git remote add origin https://github.com/<用户名>/mimo-workbuddy-connect.git
git push -u origin main
```

需要用户提供：**GitHub 用户名 + 一个 Personal Access Token**（或已登录的 `gh auth login`）。
**不要在文档或对话里回显 token。**

### 方案 B：打包交给用户手动上传

```powershell
$src = "C:\Users\54389\Documents\deepseek-harness\default-workspace\mimo-workbuddy-connect"
$zip = "$env:USERPROFILE\Desktop\mimo-workbuddy-connect.zip"
Compress-Archive -Path "$src\*" -DestinationPath $zip -Force
```

然后在 GitHub 网页上：New repository → 上传解压后的文件。

---

## 7. 给接手 agent 的注意事项

1. **先跑 `node test/run.mjs`**。55 个测试全绿才说明环境完好。
2. **不要用本机真实账号跑 `test/manual/` 里的脚本**，除非用户明确同意（会消耗 WorkBuddy 额度）。3. **改代码后必须重跑 `node test/run.mjs`**。尤其动 `catalog.js` / `provider.js` 时——
   那里有 4 个 schema 校验测试专门防止配置再次写坏。
4. **`doctor` 的 "config passes MiMoCode schema validation" 一定要绿**。
   这是之前踩过的坑：配置里多一个非法字段，App 会直接拒绝加载。
5. **不要臆造上游能力**。所有关于 WorkBuddy / MiMoCode 的断言都应能在本机复现；
   `src/` 里每个"实测"注释都对应一次真实验证。
6. **端口固定 8791 / 8792 是有意的**（配置里记的就是这个地址），不要改成随机端口。
7. README 里的**免责声明必须保留**（非官方接口、仅供个人使用、遵守各平台服务条款）。

---

## 8. 已知限制（诚实清单，建议写进 README）

- 依赖 WorkBuddy 客户端接口（**非公开 API**），上游更新后可能需要跟进。
- **国际版（WorkBuddy AI）未经实机验证**：auth 路径与 Electron 位置是照 DSH 插件抄的，
  本机只有国内版。需要环境变量 `WORKBUDDY_AI_AUTH_FILE` 指定。
- 加密凭据解密依赖 WorkBuddy 自身 Electron 的私有绑定；上游改实现需重新对齐。
  （`doctor` 会明确指出是哪一步失败。）
- 配置变更**需重启 MiMo Desktop** 才生效（官方行为，非本项目限制）。
- 倍率是**快照式**的，只在 `status --rates` 里实时。
- 6 个模型（`glm-4.6` / `glm-4.7` / `glm-4.6v` / `glm-5.0` / `minimax-m2.5` / `kimi-k2-thinking`）
  出现在上游目录里但**账号调不动**，已自动从配置剔除。

---

## 9. 建议的 GitHub 仓库信息

**仓库名**：`mimo-workbuddy-connect`

**Description**：
```
把 WorkBuddy 桌面 App 的模型接入小米 MiMo Desktop（MiMoCode），零配置使用 | Bring WorkBuddy desktop models into Xiaomi MiMo Desktop with zero configuration
```

**Topics**：
```
mimocode  mimo-desktop  xiaomi-mimo  workbuddy  model-provider  openai-compatible  nodejs  windows
```

**License**：MIT

---

## 10. 一句话总结给用户

> 项目已经**做完并实测通过**（55 个测试全绿，本机 MiMo Desktop 里能看到 27 个 WorkBuddy 模型、
> 23 个带推理档位）。本机没装 git，所以需要把 `mimo-workbuddy-connect` 整个目录
> 交给一个能访问 GitHub 的 agent，按第 6 节推上去即可。
