# TMCRA × DeepSeek Harness 长期记忆插件

这是 TMCRA 面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的自动记忆接入。

每轮收到用户问题后，插件会并行召回“用户全局记忆”和“当前项目记忆”，把证据写入 Harness 可审计的会话记录。回答完成后，用户陈述与 Agent 回答会以两个角色明确的记录写回 TMCRA。

仓库在 `src/sdk/` 中附带适配器实际使用、可审查的 TypeScript 客户端与生命周期模块。托管 API、账号、计费、控制面、数据库、部署配置和生产记忆引擎代码均不在公开范围内。

> 当前状态：技术预览。已针对 `@deepseek-ai/dsh` `0.1.0-rc.6` 与 TMCRA API `0.2.2` 验证。DeepSeek Harness 本身仍处于 Developer Preview，后续可能出现破坏性兼容变更。

[English](./README.md)

## 已实现能力

- 每轮第一次模型请求前自动召回，无需 Agent 主动调用工具。
- 新开一个 Harness 对话后，可以继续同一项目的工作进度。
- `session_id` 用于项目内部的来源追踪，不会被设计成第三个独立召回范围。
- 用户内容与 Agent 回答分别保存为 `user`、`assistant` 记录。
- 主 Agent 与子 Agent 共享项目记忆，同时保留 Agent 身份、角色、父会话与委派深度。
- 优先根据 Git origin 识别项目，其次使用 Git 公共目录，最后使用规范化工作目录。
- 内容送往 TMCRA 前，会清理常见 API key、Bearer Token、密码、私钥、验证码和带凭据的 URL。
- 召回异常默认不阻断 Harness 回答；写入失败会进入本地持久化待写队列，下次提问前重试。

## 让每一次项目协作都成为可继续使用的知识

一个长期项目中，真正有价值的信息通常散落在许多轮对话里：需求为什么这样确定、方案受过哪些约束、哪些尝试已经失败、代码改到了哪里、测试得到什么结果、下一步还要完成什么。对话窗口关闭以后，这些上下文很容易被遗忘。再次开始工作时，用户往往需要重新解释项目，Agent 也可能重复调查、重复试错，甚至沿用已经失效的结论。

接入 TMCRA 后，Harness 会在协作过程中自动记录用户表达的目标、要求、决定、修正和工作偏好，同时记录 Agent 完成的分析、实现、测试、问题定位与进度。用户说过的话和 Agent 做过的工作会被分别保存，后续能够判断一项内容是用户作出的决定、Agent 给出的建议，还是已经完成并验证的结果。

随着项目推进，这些协作记录会逐步整理为：

- **项目现状**：当前目标、需求与约束、已经完成的工作、正在处理的问题、未完成事项和建议的下一步；
- **决策与实施过程**：方案选择及其原因、重要变更、实验与测试结果、失败尝试、故障原因和最终处理方法；
- **可复用的经验**：经过实际项目验证的方法、排障路径、设计原则、研究笔记、领域知识和容易踩到的坑；
- **个人工作背景**：用户明确表达的偏好、习惯、常用工具、协作方式和长期关注的主题。

这些内容会随项目继续推进而更新。新的结论形成后，系统会更新项目的当前状态，同时保留此前的过程和依据。不同项目分别组织；同一项目中的多次对话可以共享已经积累的背景。用户开始一轮新对话时，Agent 可以先取得与当前问题相关的项目知识，再继续回答和执行任务。

用户可以在 TMCRA 网页端或桌面应用中查看记忆库和知识图谱，搜索项目经历，回到原始对话核对内容，并删除错误、过时或不希望继续保留的记忆。启用本地知识库同步后，稳定的项目知识也可以继续整理到 Obsidian，成为个人可长期维护的资料。

这套能力适合持续数周或数月的开发、研究、产品设计与多 Agent 协作。它减少重复说明、重复调查和重复试错，让项目进度能够跨对话延续，也让一次项目中形成的经验在之后的工作中继续发挥作用。

## 环境要求

- Node.js `22.19.0` 或更新版本
- DeepSeek Harness `0.1.0-rc.6`
- Harness 管理插件时需要 `pnpm` 位于 `PATH`
- 一个 TMCRA 账号。登录命令会自动创建插件所需的范围令牌。

## 安装技术预览包

```bash
dsh plugin --profile web add https://github.com/reshuibuduo/tmcra-deepseek-harness-memory/releases/download/v0.1.1/tmcra-deepseek-harness-memory-0.1.1.tgz
dsh plugin --profile web exec tmcra-harness-memory login
dsh --profile web --dump-config
dsh web
```

Harness Web UI 默认地址为 `http://127.0.0.1:3080`。

压缩包内含 `cordis.patch.yml`，安装后会自动加入指定 Profile 的配置层。建议使用 Release 中已经构建好的 `.tgz`。下载到本地后，也可以执行 `dsh plugin --profile web add ./tmcra-deepseek-harness-memory-0.1.1.tgz`。从 Git 源码安装可能还需要在 `pnpm` 中单独允许构建脚本。

当前 Windows 版 Harness 预览工具在处理“包含空格或非 ASCII 字符的压缩包绝对路径”时，可能会错误地重新拼接路径。遇到此问题时，先把压缩包复制到不含空格的短路径，例如 `D:\\dsh-packages\\tmcra-deepseek-harness-memory-0.1.1.tgz`，再执行安装。

## 连接 TMCRA 账号

安装后执行：

```bash
dsh plugin --profile web exec tmcra-harness-memory login
```

命令会启动带 PKCE 保护的设备授权，并打开 `tmcra.com`。注册或登录账号，核对权限并确认页面上的设备代码。TMCRA 随后签发仅含 `memory:read`、`memory:write` 权限的令牌，同时下发账户全局 scope 和项目 scope 前缀。插件会把这些值保存到 Harness 管理的 `$DSH_HOME/.credentials.yaml`，用户无需手工复制 API key。

```bash
dsh plugin --profile web exec tmcra-harness-memory status
dsh plugin --profile web exec tmcra-harness-memory logout
```

`status` 只显示当前 Profile 的连接状态，不输出令牌。`logout` 只删除 TMCRA 相关凭据，其他 Harness 凭据会原样保留。电脑遗失或不再可信时，还应在 TMCRA 个人控制台中撤销该连接。

Harness 不会把凭据值写入普通设置或模型请求。如果模型控制的工具和 Harness 使用同一个系统用户，它仍可能读取该系统用户有权访问的本地文件，因此只应在可信本地账号中保留连接。

插件默认配置：

```yaml
- insert:
    - id: tmcra-memory
      name: tmcra-deepseek-harness-memory
      config:
        baseUrl: https://api.tmcra.com
        baseUrlEnv: TMCRA_API_BASE_URL
        apiKeyEnv: TMCRA_API_KEY
        globalScopeEnv: TMCRA_GLOBAL_SCOPE
        projectScopePrefixEnv: TMCRA_PROJECT_SCOPE_PREFIX
        evidenceMode: auto
        recallFailureMode: continue
        waitForIngest: false
        recallTimeoutMs: 30000
        ingestTimeoutMs: 30000
```

受控部署可以显式填写 `globalScope`、`projectScopePrefix` 与 `projectScope`。个人电脑上的常规使用建议保留自动项目识别：不同项目相互隔离，同一个项目里的不同会话可以继续彼此的进度。Harness 接入与 Codex 接入共用 `.tmcra/project.json` 标记和 Git 项目 scope 公式，因此两种工具能够落到同一张项目记忆图。

## 自动链路

```text
用户提问
  -> 等待同项目上一轮写入
  -> 恢复本地待写队列
  -> 并行召回全局与项目记忆
  -> 注入可审计的 TMCRA 证据
  -> Harness 模型与工具循环
  -> 本轮正常完成
  -> USER / ASSISTANT 分角色写回
```

召回证据使用 Harness 的持久插件消息形式（`form: recall`），会保留到 Harness 执行上下文压缩。插件不会隐藏或改写用户本地的 Harness 会话记录。

## 验证

```bash
npm run typecheck
npm test
npm run build
npm run pack:check
pnpm audit --prod
```

公开单元测试覆盖生命周期 Hook、Scope 推导、角色分离、敏感信息清理、召回注入和持久化 Outbox。生产服务契约测试会导入 TMCRA 控制面模块，因此继续保留在私有环境；下方公开验收结果，但不公开服务端实现。

远端测试会连接真实 TMCRA 账户，并创建两个互相独立的 Harness 会话：

```bash
TMCRA_REMOTE_API_KEY=... \
TMCRA_REMOTE_CLEANUP_API_KEY=... \
TMCRA_REMOTE_GLOBAL_SCOPE=... \
TMCRA_REMOTE_PROJECT_SCOPE_PREFIX=... \
npm run test:remote
```

它核验写入、任务完成、新会话召回与待写队列清空。`TMCRA_REMOTE_CLEANUP_API_KEY` 是可选项，只用于删除一次性测试会话；插件日常令牌仍只需要 `memory:read` 与 `memory:write`。回答端使用记录型测试 Adapter，因此不会产生模型 Token 费用。

2026 年 8 月 14 日，技术预览通过了生产 API 验收：全新项目的两个完整回合写成四条分角色记忆，第二个独立 Harness 会话成功取回用户检查点与 Agent 进度。共享套餐账本记录了两次写入事件（共 53 个估算 Token）和一次有效召回，平台归因为 `deepseek_harness`，成员明细归到测试用户。验收结束后，测试分组已取消，全部测试密钥与令牌均已注销。

## 当前边界

- 账号连接目前采用 CLI 引导加浏览器确认；Harness 内部暂时没有原生 TMCRA 设置页。
- 暂未提供 Harness 历史会话导入。
- 长会话中的上下文增长遵循 Harness 的召回消息与压缩机制，仍需补充长时间工作负载测试。
- 当前只验证了 Harness `0.1.0-rc.6`。
- npm 包尚未正式发布；当前安装产物是已经审计的 `.tgz`。
- 使用真实 DeepSeek 模型完成回答，需要用户自己的 DeepSeek 凭据；记忆生命周期测试本身不依赖该凭据。
- 记忆库和知识图谱通过 TMCRA 网页端或桌面应用查看；Harness 接入在对话过程中后台运行。

## 许可

Apache License 2.0。Copyright 2026 Yu Haoxin and TMCRA contributors.
