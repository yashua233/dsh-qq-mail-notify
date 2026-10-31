# dsh-qq-mail-notify

> 快速跳转：[安装](#安装) · [配置](#配置) · [在界面里调](#在界面里调) · [自检](#自检) · [兼容性](#兼容性) · [遇到问题](#遇到问题) · [相关插件](#相关插件)

**中文** | [English](./README.en.md)

工作结束时把本轮摘要发到 QQ 邮箱的 Host 插件。装一次，之后每个会话都会生效：agent 这一轮真正停下（不再有工具调用、没有新的追问）就**立刻发一封**，人不用盯着屏幕了。想安静些可以把 `idleDelayMs` 调大，变成攒批汇总。

## 安装

三种方式任选一种，装完重启 DeepSeek Harness 生效（关掉再打开即可；装了 [dsh-restart-yashua](https://github.com/yashua233/dsh-restart-yashua) 的话也可以点侧栏那个按钮）。

**从 GitHub**

```bash
dsh plugin --profile desktop add github:<owner>/dsh-qq-mail-notify
```

**本地目录（开发或自己改的时候）**

```bash
dsh plugin --profile desktop add link:/path/to/dsh-qq-mail-notify
```

**从 npm（若已发布）**

```bash
dsh plugin --profile desktop add dsh-qq-mail-notify
```

装完在你自己的 profile 清单（`~/.dsh/profiles/<你的 profile>/package.json`）的 `dependencies` 里会多一条记录；卸载就是把那条删掉再重新安装依赖。

> 上面的 `desktop` 是 DSH 桌面端默认的 profile 名，web 端通常是 `web` 或你自定义的名字——用你自己的那个就行（`~/.dsh/profiles/` 下能看到的目录名）。

首次进入新对话时，插件会弹一张卡片问「这个对话的通知怎么发」；不想被问，就提前在 `$DSH_HOME/qq-mail-notify.json` 里写好 `user` / `authCode` / `to`。

## 它怎么判断「工作结束」

只看真实事件，不猜状态：

1. `agent/turn-stopping` 说明这一轮已经不需要模型再回话了。插件在这一刻**只把这一轮记进当前批次**、重挂定时器，绝不拖慢回合。
2. **默认即时发送**：`idleDelayMs` 默认 `0`，所以这一轮一停就把邮件发出去，不用等。
3. 想要安静就把它调大——`idleDelayMs=600000` 会变成「停手 10 分钟才发」，连续对话期间批次一直攒着，最后合成一封汇总。此时还有两个上限防死等：累计超过 `maxBatchMs`（默认 30 分钟）或攒到 `maxBatchTurns`（默认 20 轮）就先发一封。
4. 发信前核对：会话还在、有用户消息、单轮够 `minTurnMs`（默认 `0`，不设门槛）、不在 `quietHours`（命中就顺延到时段结束，不丢）。
5. 邮件主题形如 `[DSH] 工作结束 · deep · 5 轮 · 42 分 10 秒`（攒批时）或 `[DSH] 工作结束 · deep`（单轮），正文按轮次分节，每节给请求、耗时、结束状态与摘要，摘要总量由 `previewChars` 按轮数均分。

子会话（subagent）默认跳过，避免一次委派刷一堆邮件。

## 邮件里写了什么

单轮一封时，正文是一条完整的时间线：

- 目录、会话 id、轮次；有值时还会带预设（`agentPreset`）、来源（`origin`）、父会话（子会话时）
- **开始与结束的绝对时间**（`YYYY-MM-DD HH:mm:ss`）、耗时、结束状态
- 工具调用总次数与失败次数、按调用次数排序的工具分布（最多列 12 个）、最后调用的工具、停在第几步
- Token 用量（输入 / 输出）
- 失败时的分类原因、原始消息、错误码 / HTTP 状态
- 请求原文（最多 800 字）、回复摘要

攒批时先给汇总（轮数、累计耗时、合计工具与 Token），再逐轮展开，每轮带自己的时间区间、状态、工具次数和摘要。HTML 版是同样的内容，外加表格和状态色块。

## 一轮跑太久会中途报进度

默认 `progressEveryMs = 2400000`（40 分钟）。一轮跑超这个时长，插件会先把当前状态发一封，不用对着屏幕干等：

- 主题形如 `[DSH] 工作继续 · deep · 已进行 40 分 20 秒`，正文开头直接说明「本轮还在跑，先报个进度」，后面跟当前的目录、轮次、开始时间、已耗时、工具调用、Token、请求原文，以及到目前为止产出的摘要；
- 只在 agent 处于 running 时计时；一旦回到 idle 或这一轮收尾，定时器立刻撤掉，绝不跟结束邮件抢；
- 子会话（subagent）一样跳过；
- 之后每隔同样时长再报一次。嫌频繁就调大，设 `0` 完全关掉；
- 收尾时的正式邮件照发，那封才有完整结论。

## 失败也发，而且先写原因

干到一半断掉的时候，人比平时更需要知道，所以失败走独立路径：

- `turn/end` 的 `reason.kind === 'error'`，或收到 `agent/error`，本轮就算失败；
- 失败通知**跳过静默窗口和 `minTurnMs` 门槛**，3 秒内就发——哪怕这轮只跑了几秒，额度没了也立刻告你；当前批次里已经攒下的轮次会并进这封邮件，不会连发两封；
- 主题直接点名原因：`[DSH] 工作失败 · deep · 额度或余额不足`；
- 正文顶部是红色失败块，包含中文原因、原始错误消息、错误码 / HTTP 状态，表格里补上停在第几步、最后调用的工具；
- 原因分类顺序匹配：额度或余额不足（402 / quota / balance）→ 鉴权失败（401 / invalid_api_key / 登录过期）→ 没有权限（403）→ 被限流（429）→ 上下文超窗 → 网络连接失败（timeout / ECONNRESET / fetch failed）→ 服务端错误（5xx），都没命中就回退到原始消息；
- 如果错误之后回合没能正常收尾（`agent/error` 后 5 秒仍没有回合边界事件，且 agent 已空闲），会补发一封；
- 被你自己或父会话中断（`aborted`）不算失败，默认不发；要收就设 `notifyOnAbort=true`。

## 每个对话单独设置

新开一个对话时，插件会把一张问题卡片弹出来问一次（`agent/created`、`source=startup`；提问是游离的，不会阻塞会话创建）：

- 即时（这一轮结束就发）— 默认
- 攒批（停手 10 分钟合并一封）
- 更安静（停手 30 分钟，且每小时最多一封）
- 这个对话不发

选择写进 `$DSH_HOME/qq-mail-notify-sessions.json`，按会话 id 存，只影响那个对话。`userQuestions` 服务不可用、或卡片没能弹出来时，同一份指令也写进了系统提示：模型处理本对话第一个请求前会用 `qq_mail_notify action=session` 查一次，没定过就问一句再写进去。两条路都生效时不会重复问——提问进行中，读取会返回 `pending=true`，模型据此直接继续。超过 120 秒没人回答，卡片作废，本对话按默认设置走。

想手动改当前对话：

```text
qq_mail_notify action=session                      # 读：decided / override / effective
qq_mail_notify action=session idleDelayMs=180000   # 写：只影响本对话
qq_mail_notify action=session enabled=false        # 这个对话不发
```

## 邮件里故意没有链接

早期版本给「打开会话」配了一个带 token 的地址，实践中没用：token 属于当前进程，DSH 一重启就换；端口每次启动也重新分配。等你忙完回来看邮件，那个链接早就打不开了。

所以现在不带任何链接，把信息全写进正文——目录、会话、轮次、开始与结束的绝对时间、耗时、结束状态、工具调用分布、最后动作、Token 用量、请求原文、回复摘要。看完邮件就知道发生了什么，不用再跳回界面。

需要知道当前地址时看 `qq_mail_notify action=status`；它返回配置来源与统计，不再拼链接。

## 配置

两条路，都不用改 profile 的 patch：

在会话里让 agent 调 `qq_mail_notify` 工具：

```text
action=configure, user=123456@qq.com, authCode=<授权码>, to=接收邮箱@qq.com
action=test        # 立刻发一封测试邮件
action=status      # 看配置、来源和统计
action=send        # 立刻把当前会话进度发一封
```

字段写入 `$DSH_HOME/qq-mail-notify.json`，优先于 `cordis.patch.yml` 里的同名空值。想让 patch 里的值压过文件，就让 patch 里的字段非空。

QQ 邮箱的授权码不是登录密码：网页版 QQ 邮箱「设置 → 账户 → POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV 服务」里开启 SMTP 服务，按提示发短信后拿到 16 位授权码。

这个插件为 QQ 邮箱优化，QQ 也是默认值：只要 `user` 是 QQ 邮箱，不填任何主机配置就连 `smtp.qq.com:465`。其他服务商在「主机仍是默认值」的前提下按地址自动识别——`@qq.com` / `@foxmail.com` / `@vip.qq.com`（QQ）、`@exmail.qq.com`（腾讯企业邮）、`@163.com`、`@126.com`、`@yeah.net`、`@gmail.com`、`@outlook.com` / `@hotmail.com` / `@live.com`。认不出的域名不猜，保持 QQ 默认，需要自己填 `smtpHost` / `smtpPort` / `secure`；显式填过的主机永远不会被推断覆盖。各家授权码获取方式不同：Gmail 要应用专用密码，Outlook 的 SMTP 是 587 + STARTTLS。

配置字段：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `user` | — | 发件邮箱地址（QQ 邮箱是主路径，也决定自动推断服务商） |
| `authCode` | — | SMTP 授权码 |
| `to` | 同 `user` | 收件人，多个用逗号分隔 |
| `smtpHost` / `smtpPort` / `secure` | 按 `user` 推断，QQ 即 `smtp.qq.com` / `465` / `true` | 465 隐式 TLS；587 配 `secure=false` 走 STARTTLS。显式填过就以你填的为准，推断不会覆盖 |
| `idleDelayMs` | `0` | 最后动作结束后静默多久才发。`0`＝**即时发送**（这一轮结束就发）；调大则攒批，如 `600000`（10 分钟）连续对话只收一封 |
| `progressEveryMs` | `2400000` | 一轮跑超 40 分钟就先发一封进度通报，之后每隔同样时长再报；`0` 关闭 |
| `approvalMailEnabled` | `false` | 工具停下来等你授权时发邮件，回信「允许」/「拒绝」即可决定。**必须同时安装 `dsh-mail-command`**，打开它会把会话切到 `workspace-write` |
| `approvalMailTimeoutMs` | `600000` | 审批邮件等回信的时长（10 分钟）。超时**交回界面**等你点，不会替你决定 |
| `maxBatchMs` | `1800000` | 攒批时一批最多攒 30 分钟就先发一封；`0` 表示不限 |
| `maxBatchTurns` | `20` | 攒批时一批最多攒 20 轮就先发一封 |
| `minTurnMs` | `0` | 单轮短于这个时长就不计入；默认不设门槛，调大可过滤掉一阵就结束的短轮；失败轮不受此限 |
| `skipSubagents` | `true` | 跳过子会话 |
| `notifyOnAbort` | `false` | 被中断时是否也发（失败始终发） |
| `quietHours` | 空 | 免打扰时段，如 `23:30-07:30` |
| `includePreview` / `previewChars` | `true` / `1200` | 摘要开关；`previewChars` 是整封邮件的摘要总量，按轮数均分 |
| `subjectPrefix` | `[DSH]` | 主题前缀 |
| `fromName` | `DeepSeek Harness` | 发件人显示名（收件箱里看到的名字） |
| `enabled` | `true` | 总开关 |

也认环境变量：`DSH_QQ_MAIL_USER`、`DSH_QQ_MAIL_AUTH_CODE`、`DSH_QQ_MAIL_TO`、`DSH_QQ_MAIL_HOST`、`DSH_QQ_MAIL_PORT`、`DSH_QQ_MAIL_SECURE`。

优先级：**会话覆盖（sessions 文件）** > Config（patch）> `qq-mail-notify.json` > 环境变量 > 默认值。`status` 会逐字段标出来源（`session` / `config` / `file` / `env` / `default`）。

## 在界面里调

装好重启后打开 **设置 → 邮件通知**，面板上能改：

- 发件邮箱、SMTP 授权码（**留空表示不修改**）、收件邮箱
- SMTP 服务器、端口、隐式 TLS 开关
- 发送节奏：即时（这一轮结束就发）／攒批（停手 N 分钟后合并一封）
- 长任务进度通报的间隔分钟数（`0` 关闭）
- 主题前缀
- 审批邮件开关 + 等回信时长（**只有同时装了 `dsh-mail-command` 才会出现**）

面板和 `qq_mail_notify action=configure` 改的是同一个文件 `$DSH_HOME/qq-mail-notify.json`，改完立刻生效、不用重启。底部会显示配置文件路径、关键项的来源（配置文件／默认值／环境变量）和当前统计。

三个按钮：**保存**（只提交改动过的字段，授权码留空表示不修改）、**发一封测试邮件**、**重新读取**。底部显示配置文件路径、关键项的来源（配置文件／默认值／环境变量）和当前统计。

设置页和工具改的是同一个配置文件，`qq_mail_notify action=configure` 与它完全等价；会话级覆盖（`action=session`）仍然走接口。

后端为此暴露三个同源校验的接口：`GET /dsh-qq-mail-notify/status`（脱敏快照，授权码只给打码值）、`POST /dsh-qq-mail-notify/config`（白名单字段写入，其余键忽略）、`POST /dsh-qq-mail-notify/test`。跨站请求一律 403。

## 实现要点

- `lib/index.js`：事件订阅、定时器、工具注册，没有硬依赖（`sessions`/`webApp`/`tools` 都按可选服务取用）。
- `lib/smtp.js`：自带 SMTP 客户端（`node:net` / `node:tls`），AUTH LOGIN + PLAIN 兜底，中文主题走 RFC 2047 编码字，正文 base64 分段，UTF-8 与 HTML alternative。
- `lib/report.js`：全部从 Session 事件推导（`turn/start`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`turn/end`），不编造内容。
- `lib/settings.js`：三层优先级合并、脱敏、持久化。

失败只记日志（`[qq-mail]` 前缀）并重试一次，不会把回合搞坏。

## 自检

```powershell
# PATH 里有 node 时
node scripts/selfcheck.mjs

# 没有 node 时用 DSH 自带的运行时（路径随安装位置变化）
& "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" scripts\selfcheck.mjs
```

脚本会起一个本地假 SMTP 服务器，真的走完 EHLO / AUTH LOGIN / MAIL / RCPT / DATA，再解码收到的邮件核对中文与结构。此外覆盖：摘要推导、失败分类、批量合并、配置优先级、服务商推断、报文结构（没有 HTML 时必须是单部分 `text/plain`）、邮件头防注入。一共 23 项，不需要真实授权码，也不联网。

`scripts/probe-smtp.mjs` 是排障用的：连 `smtp.qq.com` 的 465 / 587，只做 TLS 握手和 EHLO，打印服务器宣告的 AUTH 机制，不认证、不发信。

## 相关插件

- [dsh-mail-command](https://github.com/yashua233/dsh-mail-command) — 可选。装了它，本插件发出去的邮件才变成双向通道：回信能让任务继续或停止，开了审批邮件还能批准一次越界操作。不装就只是单向提醒。它的口令落盘、重启后仍有效。
- [dsh-restart-yashua](https://github.com/yashua233/dsh-restart-yashua) — 可选。侧栏一个「重启 Harness」按钮，点一下先就地确认再重启，不用每次都去关窗口。改完本插件的配置正好用它重启生效。

三者互不 `import`，都靠 cordis 服务协作。本插件不依赖另外任何一个，单独装就是完整的单向通知。

## 兼容性

- **只声明实测过的那个版本：`0.2.1-rc.5`**。`package.json` 里 `dshTarget` 和 `dsh.compatibility.dsh` 都是它，没有范围。
- 为什么不写成 `>=x <y`：DSH 还在开发者预览，官方明确说会有破坏性变更，**跨一个小版本（0.2.1 → 0.2.2）就可能装不上或行为不对**。写范围等于替你赌那些版本，我不赌。
- 想装在别的版本上：把 `dsh.compatibility.dsh` 改成你手上的版本再试。能跑是运气，跑不动是常态——反馈时请带上版本号。

## 遇到问题

先跑一遍自查，多数毛病它会直接指出是哪一项：

```powershell
# 用 DSH 自带的运行时，PATH 里没有 node 也能跑
& "$env:DSH_HOME\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
  scripts\selfcheck.mjs
```

它会在本地起一个假 SMTP 服务器，把 EHLO / AUTH / MAIL / RCPT / DATA 全走一遍，不联网、不用真实授权码，所以跑挂了也不会把你邮箱发脏。

自查也过、但邮件就是不来，那就提 issue：<https://github.com/yashua233/dsh-qq-mail-notify/issues>。请走 issue 而不是私信，后面遇到同样问题的人能搜到。

带上这几样，能省好几轮来回：

- DSH 版本（设置 → 关于里的那一串）；
- 本插件版本（仓库里 `package.json` 的 `version`）；
- `qq_mail_notify action=status` 的输出（授权码本身是打码的，可以直接贴）；
- 报错的原文或截图，以及「你做了什么、期望什么、实际是什么」。

**贴之前把授权码、完整邮箱地址、token 打码**。日志里出现这些的地方不止一处，扫一眼再发。

## 审批邮件（可选，默认关闭）

打开之后，**工具停下来等你授权时**会给你发一封邮件，回「允许」或「拒绝」就能决定，不用守着屏幕。三个约束是刻意设计的：

- **必须同时安装 [`dsh-mail-command`](https://github.com/yashua233/dsh-mail-command)**——没装的话设置面板里根本不会出现这个开关（它靠接收侧收信与验口令）；
- **打开开关会把当前会话切到 `workspace-write`**（沙箱限制在工作区 + 审批 `ask`）。这一步必须做：DSH 默认的 `danger-full-access` 让「写哪里」都在许可范围内，永远没有东西需要批准，邮件自然永远发不出来。切过去之后，只有**超出工作区**的操作（写外面、执行受限命令）才会停下来问你——那正是这个功能的意义。**关掉开关会自动还回 `danger-full-access`**；如果你平时用的是别的预设，用 `/permission` 再选回来即可。只影响开了开关的会话；
- 回信只认明确表态（允许/同意/ok/1，或 拒绝/no/2）。认不出来按「没回」处理；
- 等 `approvalMailTimeoutMs`（默认 10 分钟）还没回，**自动交回界面**等你点——不会替你决定，也不会因为邮件系统抖动把一次本该批准的操作判死。

安全上要说清楚：**这两条通道都在给 agent 授权，而且「继续」的范围并不比审批小**。

- 通知邮件的「继续」是**持续授权**：agent 按你信里写的要求接着干，一直干到下一次停下。它的上限是你当前选的沙箱——在完全访问模式下，任何拿到那封邮件的人写一句「继续，然后……」，就等于把整台机器交出去了。
- 审批放行是**单次授权**：只放行这一个操作，一次有效，超时即失效，而且只在沙箱真的拦住时才出现。

所以审批不是「更大的权限」，是**更细的闸门**——它把「随时可以指挥」收窄成「逐次确认」。这个功能默认关闭，因为要不要把邮箱变成控制通道，该由你决定；但真正决定风险上限的始终是那两件事：**你的邮箱安全等级**，和**你选的沙箱模式**。

## 隐私

插件不收集任何数据，也不向外发送除你的邮件之外的东西。SMTP 凭据只存在本机 `$DSH_HOME/qq-mail-notify.json`（或环境变量），不进日志：`status` 输出里的授权码是打码的。`scripts/selfcheck.mjs` 用本地起的假 SMTP 服务器跑完整 SMTP 会话，不联网、不需要真实授权码。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
