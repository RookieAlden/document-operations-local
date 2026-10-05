# macOS 安装与使用

[项目首页](../README.md) · [完整示例](EXAMPLE_WALKTHROUGH.md) · [实测环境与边界](../docs/current/LOCAL_FINAL_ACCEPTANCE.md)

这是源码安装版，没有一键安装程序。下列命令在 macOS「终端」运行；复制时不要带 Markdown 的围栏符号。默认位置为 `~/Projects/document-operations-local`。已有安装请直接看“备份与更新”，不要覆盖或删除 `.local`。

## 1. 准备依赖

需要 Git、Node.js 24、pnpm 11.16.0、PostgreSQL 17（包括 pgcrypto 扩展）。已有兼容依赖可复用。未安装 Homebrew 时先按 [Homebrew 官方安装页](https://brew.sh/)完成安装及页面提示的 shell 配置，确认 `brew --version` 可用，再运行：

```sh
brew install git node@24 postgresql@17
export PATH="$(brew --prefix node@24)/bin:$PATH"
npm install --global pnpm@11.16.0
node --version
pnpm --version
"$(brew --prefix postgresql@17)/bin/postgres" --version
```

应分别显示 Node `v24.x`、pnpm `11.16.0` 和 PostgreSQL `17.x`。每次新开终端需要执行上面的 `export PATH=...`，或按 Homebrew 的提示将它加入 `~/.zshrc`。不需要运行 `brew services start`：本项目自己管理独立数据库，不使用 Homebrew 默认数据库，也不连接已有云数据库。

依赖获取需要互联网。Homebrew 的新安装步骤来自[官方 PostgreSQL 配方](https://formulae.brew.sh/formula/postgresql@17)；本次实测复用了已有运行时，没有在一台空白 Mac 上重装 Homebrew，详见验证记录。

## 2. 获取代码、安装依赖

```sh
mkdir -p "$HOME/Projects"
cd "$HOME/Projects"
git clone https://github.com/RookieAlden/document-operations-local.git
cd document-operations-local
git checkout v0.1.1
cd platform/service
pnpm install --frozen-lockfile
```

后续命令均在 `~/Projects/document-operations-local/platform/service` 执行。重新打开终端后，先运行：

```sh
cd "$HOME/Projects/document-operations-local/platform/service"
export PATH="$(brew --prefix node@24)/bin:$PATH"
```

## 3. 首次设置自己的账号

```sh
node scripts/local/setup.mjs
```

终端依次询问账号、密码：账号按回车默认为 `alden`，也可以填写自己的账号；密码自行设置，至少 8 个字符，输入时不显示。没有公开通用密码。再次运行 setup 会保留已有设置。

以后网页登录只填账号和密码，不需要复制令牌、密钥或打开登录文件。浏览器可保存密码。重启、正常更新或新建演示数据库不会重新生成密码。

## 4. 启动、打开、停止

首次启动：

```sh
node scripts/local/runtime.mjs start --pg-bin "$(brew --prefix postgresql@17)/bin"
```

使用其他 PostgreSQL 17 安装时，将 `--pg-bin` 后的值替换为该安装的 `bin` 绝对路径，里面必须有 `postgres`、`initdb`、`pg_ctl`。启动器会编译程序、创建专用数据库、执行迁移并准备虚构初始客户；不会导入你的云端资料。

打开 **http://127.0.0.1:4318/workbench**，用刚才设置的账号密码登录。资料运营台为 **http://127.0.0.1:4318/ops**，使用相同登录。

```sh
node scripts/local/runtime.mjs status
node scripts/local/runtime.mjs stop
node scripts/local/runtime.mjs start
```

以上分别是查询状态、停止、再次启动。启动后进程在后台运行，关闭终端不会自动停止。正常停止不会删除资料；后续启动不必重复指定 PostgreSQL 路径。

## 5. 无密钥也能体验：导入示例

“导入”指通过界面上传文件，不是导入数据库。按 [完整示例](EXAMPLE_WALKTHROUGH.md)新建季度资料任务，使用仓库根目录 `output/pdf/local-closeout/` 的 PDF。Finder 中按 `⌘⇧G`，输入 `~/Projects/document-operations-local/output/pdf/local-closeout` 即可找到。

保持 AI 关闭，上传后点击文件旁“人工分类”，选择类型并“保存新分类”。预览、人工分类、补交、交接、历史和导出都在本地完成，不产生 AI 费用。

## 6. 可选：配置自己的 AI

1. 在员工台左下方展开“本机 AI 设置”，填入自己的 OpenAI API 密钥。
2. 设置自己接受的**累计预算上限（USD）**及**累计分类尝试上限**，勾选“启用付费 AI”，保存。本版本使用 `gpt-5.6-sol`；你的 API 项目必须能访问该模型。
3. 上传文件后，主动点击“AI 分类（付费）”。这会向 OpenAI 发送选中的原件和分类上下文。保存密钥或上传文件本身不会自动发起分类。
4. 检查分类结果，不确定或错期间资料按示例转人工处理。无权限、无密钥、调用失败或达到额度时，继续用“人工分类”。

额度由每位使用者自行设置，不是赠送额度。每次生成尝试预留 USD 0.50，预算至少需要容纳下一次预留；允许的累计上限为 USD 100、200 次。比如想允许一次尝试，可设 USD 0.50 和 1 次；这是应用的请求保护，不是保证供应商只收该数额。估算用量与最终账单可能不同，其他程序使用同一密钥的费用不在此限制内。

应用不自动重试，不清空累计用量；网络失败或结果不明时也保留预留额度。后续增加额度需自己主动调高**累计**上限。取消启用可停止本应用后续 AI 调用，不影响人工处理。意外断电留下调用锁时先人工处理，核对记录后再维护，不要删用量文件来绕过。

## 7. 数据放在哪里

以下路径均相对于仓库根目录，而不是 `platform/service`：

| 内容 | 默认路径 |
| --- | --- |
| 个人账号校验值、可选 API 密钥 | `.local/personal/settings.json` |
| AI 累计用量 | `.local/personal/ai-usage.json`（有调用后生成） |
| 专用数据库、原件、启动配置和日志 | `.local/dop/` |
| 冷备份 | `.local/backups/<时间>/` |

`.local` 被 Git 忽略；不要公开或上传，其中包含私密资料。配置文件只允许本机用户读取。更新时保留代码目录和 `.local`，不要把“重新 clone 一份源码”当作迁移数据的方法。

需要不影响现有资料的空白演示实例，可在**首次 setup 和 start 之前**设置以下变量；路径和端口都应是新的：

```sh
export DOP_LOCAL_HOME="$HOME/DocumentOperationsDemo/data"
export DOP_LOCAL_CONFIG_HOME="$HOME/DocumentOperationsDemo/personal"
export DOP_LOCAL_APP_PORT=4328
export DOP_LOCAL_DATABASE_PORT=55449
node scripts/local/setup.mjs
node scripts/local/runtime.mjs start --pg-bin "$(brew --prefix postgresql@17)/bin"
```

此例打开 http://127.0.0.1:4328/workbench 。之后对此实例执行 start、stop、status、backup，都要在同一终端保留这些变量；重新开终端需重新执行四行 export。它使用新的个人配置，不改变旧实例密码或额度。不要删除旧目录来重置演示。

## 8. 备份与更新

先停止，再备份；数据库运行时不能做一致的冷备份：

```sh
node scripts/local/runtime.mjs stop
node scripts/local/runtime.mjs backup
```

终端会显示备份绝对路径。备份包含 `data/`、`personal/`、`manifest.json`；程序核对原件摘要。把整个备份目录私人保存，连同所用 Git 版本一起保留。备份也含账号配置及可能的密钥，不要发到 GitHub。

从旧版本升级至此版本（仍在 `platform/service`）：

```sh
git status --short
git fetch origin --tags
git checkout v0.1.1
pnpm install --frozen-lockfile
node scripts/local/runtime.mjs start
```

有自己的代码修改时先保存到分支或提交，不要强制覆盖。今后升级将标签替换为新 Release 指定的版本。启动器会执行未应用的迁移，保留现有记录和登录；若需回退，旧代码与升级前数据库备份应配套恢复，不能只切回代码就假定数据库兼容。

冷备份仅验证了同机保存及原件校验；历史另有同机恢复实测，**跨机器恢复未验证**。不要直接搬动 PostgreSQL 数据目录后宣称迁移完成，尤其是不同操作系统、架构或 PostgreSQL 主版本。

## 常见问题与开发检查

- 提示端口占用：保留已有实例；用上面的独立实例方式选择其他未占用端口。已有实例的端口保存在它的启动配置中。
- 提示找不到 pgcrypto 或 initdb：使用完整 PostgreSQL 17 安装；不要只安装客户端工具。
- 页面打不开：运行 status，检查 `.local/dop/app.log` 和 `postgres.log`；不要把含配置的整个 `.local` 上传求助。
- 无法交接：检查资料要求、待复核文件和开放补交问题；数量满足不代表所有问题已解决。

开发检查（不需要个人密钥，不调用付费 AI）：

```sh
pnpm run typecheck
pnpm test
```

GitHub Actions 使用相同检查。完整浏览器验收需单独的本地实例与浏览器环境，不作为此自动检查的依赖。
