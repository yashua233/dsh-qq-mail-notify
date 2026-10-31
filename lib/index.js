// dsh-qq-mail-notify — Host half.
//
// Observes the turn boundary of every agent and only mails once the work has
// really stopped: turns are collected into a batch and one mail goes out after
// an idle window (or a hard cap), so a long conversation produces one message
// instead of one per turn. A failed turn bypasses the wait and is mailed at
// once, because that is the case where the user must learn about the quota or
// the expired sign-in.
//
// The turn itself is never delayed: `agent/turn-stopping` only arms a timer and
// the SMTP conversation happens after the turn closed.
import { sendMail } from './smtp.js';
import {
  DEFAULTS, describeSettings, maskSecret, readSessions, readStored, resolveSettings, sessionsFile, settingsFile,
  writeSessionOverride, writeStored,
} from './settings.js';
import { buildNotification, collectReport, summarizeReports } from './report.js';

export const name = 'dsh-qq-mail-notify';
export const inject = [];

const TOOL_NAME = 'qq_mail_notify';
const TOOL_ACTIONS = ['status', 'configure', 'session', 'test', 'send'];
const RETRY_DELAY_MS = 2_000;
const URGENT_DELAY_MS = 3_000;
const SESSION_PROMPT_TIMEOUT_MS = 120_000;
const SESSION_QUESTION_ID = 'qq-mail-session';
// Labels double as the answer keys written back into the per-session file.
const SESSION_PRESETS = [
  { label: '即时（这一轮结束就发）', description: '每轮工作停下立刻发一封，不用等', patch: {} },
  { label: '攒批（停手 10 分钟合并一封）', description: '连续对话只收一封，安静一些', patch: { idleDelayMs: 600_000 } },
  {
    label: '更安静（停手 30 分钟）',
    description: '半小时没动作才发，且每小时最多一封',
    patch: { idleDelayMs: 1_800_000, maxBatchMs: 3_600_000, maxBatchTurns: 50 },
  },
  { label: '这个对话不发', description: '只影响本对话，其它对话照旧', patch: { enabled: false } },
];
const SESSION_PROMPT_TEXT = '[QQ 邮箱通知] 处理本对话的第一个请求前，先调用 qq_mail_notify（action=session）确认通知设置；'
  + '若返回 decided=false，先用 ask_user_question 问一次「这个对话的工作结束通知怎么发」（即时 / 攒批 / 更安静 / 本对话不发），'
  + '再用 qq_mail_notify（action=session）把选择写进去；若已是 decided=true 或 pending=true，直接继续，不要再问。';

function hostLog(ctx, level, message) {
  try {
    const logger = ctx?.logger;
    if (logger && typeof logger[level] === 'function') logger[level](`[qq-mail] ${message}`);
  } catch {
    /* logging must never disturb a turn */
  }
}

/** Milliseconds until the quiet window ends, or 0 when outside it. */
function quietRemainingMs(range, now = new Date()) {
  const match = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(String(range ?? '').trim());
  if (!match) return 0;
  const minutes = (hour, minute) => (Number(hour) % 24) * 60 + Number(minute);
  const start = minutes(match[1], match[2]);
  const end = minutes(match[3], match[4]);
  const current = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const inWindow = start <= end ? current >= start && current < end : current >= start || current < end;
  if (!inWindow) return 0;
  // Minutes from now until `end`, wrapping past midnight when necessary.
  const delta = ((end - current) % 1440 + 1440) % 1440;
  return Math.max(1_000, Math.round(delta * 60_000));
}

function textResult(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

export function apply(ctx, config = {}) {
  const log = (message) => hostLog(ctx, 'info', message);
  const warn = (message) => hostLog(ctx, 'warn', message);

  const state = {
    config: { ...config },
    merged: undefined,
    stored: undefined,
    sessionOverrides: {},
    pending: new Map(),
    timers: new Set(),
    running: new Set(),
    progress: new Map(),
    prompting: new Set(),
    errors: new Map(),
    disposed: false,
    /** 存活 agent，按 sessionId 索引：收件触发「继续」时用它注入消息。 */
    agents: new Map(),
    /** 一次性口令 → { sessionId, at }，命中即删。 */
    continueTokens: new Map(),
    /** 收件轮询的 UID 水位，避免同一封未读被反复处理。 */
    imapWatermark: 0,
    /** 收件轮询器实例。 */
    mailbox: null,
    stats: {
      turnStoppings: 0,
      sent: 0,
      approvalMails: 0,
      progressSent: 0,
      skipped: 0,
      failed: 0,
      failureNotices: 0,
      sessionPrompts: 0,
      sessionAnswers: 0,
      promptSection: null,
      lastTurnStopping: null,
      lastSend: null,
      lastSkip: null,
      lastError: null,
      lastAgentError: null,
      lastSessionPrompt: null,
      /** 最近一次审批邮件失败的原因——这条链路出事时只会静默降级，得留个痕迹。 */
      lastApprovalError: null,
    },
  };

  const sessions = () => ctx.get?.('sessions');



  const baseSettings = () =>
    state.merged?.settings ?? resolveSettings({ config: state.config }).settings;

  /** Effective settings for one session: its overrides win over every shared layer. */
  function settingsFor(sessionId) {
    const override = state.sessionOverrides?.[String(sessionId ?? '')];
    if (!override) return baseSettings();
    return resolveSettings({
      config: state.config,
      stored: state.stored ?? {},
      session: override,
    }).settings;
  }

  let loading;
  const reload = () => {
    loading ??= Promise.all([readStored(), readSessions()])
      .then(([stored, sessions]) => {
        state.stored = stored;
        state.sessionOverrides = sessions;
        state.merged = resolveSettings({ config: state.config, stored });
        return state.merged;
      })
      .catch((error) => {
        warn(`读取配置文件失败: ${error?.message ?? error}`);
        state.merged = resolveSettings({ config: state.config });
        return state.merged;
      })
      .finally(() => {
        loading = undefined;
      });
    return loading;
  };
  void reload();

  function noteSkip(reason, entry) {
    state.stats.skipped += 1;
    state.stats.lastSkip = {
      at: Date.now(),
      reason,
      sessionId: entry?.sessionId,
      turns: entry?.turns ? [...entry.turns.keys()] : [],
    };
    return { ok: false, skipped: reason };
  }

  function arm(entry, delay) {
    if (entry.timer) {
      clearTimeout(entry.timer);
      state.timers.delete(entry.timer);
    }
    entry.timer = setTimeout(() => {
      state.timers.delete(entry.timer);
      state.pending.delete(entry.sessionId);
      deliver(entry).catch((error) => warn(`通知流程异常: ${error?.message ?? error}`));
    }, delay);
    entry.timer.unref?.();
    state.timers.add(entry.timer);
    state.pending.set(entry.sessionId, entry);
  }

  // --- 长任务进度通报 -------------------------------------------------------
  // 一轮跑太久时先发一封当前快照，别让人干等。定时器只在 agent 处于 running
  // 时挂；回到 idle 或轮次收尾立刻撤掉，绝不跟结束邮件抢。

  function cancelProgress(sessionId) {
    const record = state.progress.get(sessionId);
    if (!record) return;
    if (record.timer) {
      clearTimeout(record.timer);
      state.timers.delete(record.timer);
    }
    state.progress.delete(sessionId);
  }

  async function sendProgress(sessionId) {
    if (state.disposed || !state.running.has(sessionId)) return;
    const settings = settingsFor(sessionId);
    if (!settings.enabled) return;
    if (Math.max(0, Number(settings.progressEveryMs) || 0) <= 0) return;
    const session = sessions()?.get?.(sessionId);
    if (!session) return;
    const header = session.header ?? {};
    if (header.origin === 'subagent' || header.parentSession) return;
    try {
      const report = collectReport(session, undefined, { endedAt: Date.now() });
      if (!report.turn && !report.toolCalls) return;
      const message = buildNotification(report, { ...settings, inProgress: true });
      // 进度邮件也带口令：正在跑的时候用户就能回「停止」把它叫停。
      attachCommandBlock(message, settings, sessionId);
      await sendComposed(settings, message);
      state.stats.progressSent += 1;
      state.stats.lastProgress = { at: Date.now(), sessionId, subject: message.subject };
      log(`已发送进度通报: ${message.subject} → ${settings.to || settings.user}`);
    } catch (error) {
      warn(`进度通报发送失败: ${error?.message ?? error}`);
    }
  }

  function armProgress(sessionId) {
    const settings = settingsFor(sessionId);
    const every = Math.max(0, Number(settings.progressEveryMs) || 0);
    if (!every || !settings.enabled) {
      cancelProgress(sessionId);
      return;
    }
    cancelProgress(sessionId);
    const record = { startedAt: Date.now(), timer: null };
    state.progress.set(sessionId, record);
    record.timer = setTimeout(() => {
      state.timers.delete(record.timer);
      sendProgress(sessionId).finally(() => {
        if (!state.disposed && state.running.has(sessionId)) armProgress(sessionId);
      });
    }, every);
    record.timer.unref?.();
    state.timers.add(record.timer);
  }

  /**
   * Adds one finished turn to the session's batch and re-arms the idle timer.
   * @param {string} sessionId
   * @param {number|undefined} turn
   * @param {{ urgent?: boolean, error?: unknown }} [options]
   */
  function schedule(sessionId, turn, options = {}) {
    const id = String(sessionId ?? '');
    if (!id) return;
    const now = Date.now();
    const entry = state.pending.get(id) ?? {
      sessionId: id,
      turns: new Map(),
      firstAt: now,
      lastAt: now,
      timer: null,
      urgent: false,
    };

    const key = String(turn ?? 'latest');
    const existing = entry.turns.get(key);
    if (existing) {
      existing.at = now;
      if (options.error !== undefined) existing.error = options.error;
    } else {
      entry.turns.set(key, { turn, at: now, error: options.error });
    }
    entry.urgent = entry.urgent || Boolean(options.urgent);
    entry.lastAt = now;

    const settings = settingsFor(id);
    const idle = Math.max(0, Number(settings.idleDelayMs) || 0);
    const cap = Math.max(0, Number(settings.maxBatchMs) || 0);
    const maxTurns = Math.max(1, Number(settings.maxBatchTurns) || 20);

    let delay = entry.urgent ? URGENT_DELAY_MS : idle;
    // Flush early when the batch grew too old or too large to keep waiting.
    if (cap > 0 && now - entry.firstAt >= cap) delay = 0;
    if (entry.turns.size >= maxTurns) delay = 0;

    arm(entry, delay);
  }

  function cancel(sessionId) {
    const id = String(sessionId ?? '');
    if (!id) return;
    const entry = state.pending.get(id);
    if (!entry) return;
    // Never drop a batch that carries a failure: the user has to hear about it.
    if (entry.urgent) return;
    if (entry.timer) {
      clearTimeout(entry.timer);
      state.timers.delete(entry.timer);
    }
    state.pending.delete(id);
  }

  /** Milliseconds to wait before another attempt while the agent is busy. */
  function retryDelayFor(entry, settings) {
    if (entry.urgent) return URGENT_DELAY_MS;
    const idle = Number(settings.idleDelayMs) || 30_000;
    return Math.max(5_000, Math.min(60_000, idle));
  }

  /** True once the batch has waited longer than `maxBatchMs`, so it may be mailed mid-work. */
  function overBatchCap(entry, settings) {
    const cap = Number(settings.maxBatchMs) || 0;
    return cap > 0 && Date.now() - entry.firstAt >= cap;
  }

  function collectEntryReports(session, items, settings, options = {}) {
    const reports = [];
    for (const item of items) {
      const report = collectReport(session, item.turn, {
        previewChars: settings.previewChars,
        errorInfo: item.error,
        endedAt: item.at,
      });
      if (!report.requestText) continue;
      if (options.force) {
        reports.push(report);
        continue;
      }
      if (report.failed) {
        reports.push(report);
        continue;
      }
      if (report.aborted && !settings.notifyOnAbort) continue;
      if (report.durationMs < (Number(settings.minTurnMs) || 0)) continue;
      reports.push(report);
    }
    return reports;
  }

  function compose(reports, settings, options = {}) {
    const message = buildNotification(reports, {
      ...settings,
      inProgress: Boolean(options.inProgress),
    });
    return { summary: summarizeReports(reports), message };
  }

  async function sendComposed(settings, message) {
    return sendMail({
      host: settings.smtpHost,
      port: settings.smtpPort,
      secure: settings.secure,
      user: settings.user,
      authCode: settings.authCode,
      to: settings.to || settings.user,
      fromName: settings.fromName,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  }

  /**
   * 审批邮件的正文。刻意写成一句话能看懂的信，而不是表单——用户在手机上看，
   * 一眼就该知道回什么。纯文本与 HTML 两版内容一致，HTML 只是好读一点。
   */
  function buildApprovalMail({ toolName, reason, sessionId, token, minutes }) {
    const esc = (value) =>
      String(value ?? '').replace(/[&<>"]/gu, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
    const subject = `[DSH] 需要你确认 · ${toolName} [CONT:${token}]`;
    const text = [
      '有一个操作停下来等你授权。',
      '',
      `工具：${toolName}`,
      `原因：${reason}`,
      `会话：${sessionId}`,
      '',
      '直接回复本邮件即可（主题里的 [CONT:...] 别删）：',
      '  · 回「允许」→ 这一次放行',
      '  · 回「拒绝」→ 这一次拒绝',
      `  · ${minutes} 分钟内没有回信 → 交回电脑界面等你点，不会替你决定`,
      '',
      '回信里认不出明确表态时按「没回」处理，所以请只回这两个词之一。',
    ].join('\n');

    const html = [
      '<!doctype html><html><body style="margin:0;padding:24px;background:#f7f8fa;'
        + 'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;color:#1f2328">',
      '<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:24px;'
        + 'box-shadow:0 1px 3px rgba(0,0,0,.06)">',
      '<h2 style="margin:0 0 4px;font-size:18px">需要你确认</h2>',
      '<p style="margin:0 0 18px;color:#646a73;font-size:13px">有一个操作停下来等你授权。</p>',
      '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:18px">',
      `<tr><td style="padding:6px 0;color:#646a73;width:64px;vertical-align:top">工具</td><td style="padding:6px 0;word-break:break-all">${esc(toolName)}</td></tr>`,
      `<tr><td style="padding:6px 0;color:#646a73;vertical-align:top">原因</td><td style="padding:6px 0;word-break:break-all">${esc(reason)}</td></tr>`,
      `<tr><td style="padding:6px 0;color:#646a73;vertical-align:top">会话</td><td style="padding:6px 0;word-break:break-all">${esc(sessionId)}</td></tr>`,
      '</table>',
      '<div style="background:#f2f4f7;border-radius:8px;padding:12px 14px;font-size:13px;line-height:1.9">',
      '<div style="font-weight:600;margin-bottom:4px">直接回复本邮件即可</div>',
      '<div>回「<b>允许</b>」→ 这一次放行</div>',
      '<div>回「<b>拒绝</b>」→ 这一次拒绝</div>',
      '</div>',
      `<p style="margin:16px 0 0;color:#8f959e;font-size:12px">${minutes} 分钟内没有回信 → 交回电脑界面等你点，不会替你决定。`
        + '主题里的 [CONT:...] 请保留。</p>',
      '</div></body></html>',
    ].join('');

    return { subject, text, html };
  }

  /**
   * 把会话切到「需要授权」的权限模式。
   *
   * 只把 approval 改成 ask 是没用的：审批的触发条件是**操作超出沙箱允许范围**。
   * 默认的 danger-full-access 预设让写哪里都在许可内，于是永远没有东西需要批准，
   * 审批邮件也就永远发不出来（这一版一开始就踩了：策略切成 ask、邮件一封没发）。
   * 所以必须连沙箱一起收——这正是 workspace-write 预设的含义：沙箱限制在工作区 +
   * 审批 ask。
   *
   * 优先走 permissionPresets.apply()，它内部保证两个旋钮一起变、顺序正确；拿不到
   * 那个服务（老宿主 / 没装该插件）时退回只设审批，至少不比不动更糟。
   *
   * 关掉开关不会自动切回去——权限是用户的东西，我们只在"他要审批"时替他立起来。
   */
  function ensureApprovalPreset(agent) {
    if (!agent) return;
    if (!baseSettings().approvalMailEnabled) return;
    const approval = ctx.get?.('approval');
    const presets = ctx.get?.('permissionPresets');
    try {
      if (presets && typeof presets.apply === 'function' && agent.session) {
        presets.apply(agent.session, 'workspace-write', (policy) => {
          try {
            approval?.setPolicy?.(agent, policy);
          } catch {
            /* 单个 agent 设不上不影响其它 */
          }
        });
        log(`已切到 workspace-write（沙箱限工作区 + 审批 ask）：${agent.id ?? '?'}`);
        return;
      }
      approval?.setPolicy?.(agent, 'ask');
      log(`已只切审批策略到 ask（没找到 permissionPresets 服务）：${agent.id ?? '?'}`);
    } catch (error) {
      warn(`切换权限预设失败：${error?.message ?? error}（审批邮件不会触发）`);
    }
  }

  /** 开关刚被打开时，对已经活着的 agent 立刻生效。 */
  function applyApprovalPolicyToAgents() {
    for (const agent of state.agents.values()) ensureApprovalPreset(agent);
  }

  /**
   * 关掉开关时把预设还回去。
   *
   * 打开开关会把会话切到 workspace-write（沙箱限制在工作区），关掉之后如果继续留在
   * 那个档位，用户会莫名其妙发现写工作区外要审批——那不是他关开关时想要的。
   * 所以关掉的瞬间还原：默认还到 danger-full-access；如果你平时用的是别的预设，
   * 用 `/permission` 再选回来即可。
   */
  function restorePresetsForAgents() {
    const presets = ctx.get?.('permissionPresets');
    const approval = ctx.get?.('approval');
    if (!presets || typeof presets.apply !== 'function') return;
    for (const agent of state.agents.values()) {
      if (!agent?.session) continue;
      try {
        presets.apply(agent.session, 'danger-full-access', (policy) => {
          try {
            approval?.setPolicy?.(agent, policy);
          } catch {
            /* ignore */
          }
        });
        log(`审批邮件已关闭，权限预设还原为 danger-full-access（${agent.id ?? '?'}）`);
      } catch (error) {
        warn(`还原权限预设失败：${error?.message ?? error}（可以自己用 /permission 切回）`);
      }
    }
  }

  /**
   * 把「工具在等你授权」转发到邮箱。
   *
   * 这是 approval/request 的 waterfall：返回 'allowed-once' / 'rejected' 就等于替
   * 用户作答，不接就 next()，界面照常接手。只有全部条件满足才接管——开关打开、
   * 发件凭据齐全、接收侧装了、会话认得出；任何一条不满足都原样交回界面。
   *
   * 超时和"回信看不懂"都不替用户做决定，一律交回界面：邮件通道是加速器，
   * 不是唯一的裁决者。它的抖动不该让一次本该被批准的操作失败。
   */
  function installApprovalRelay() {
    if (typeof ctx.on !== 'function') return;

    // 记住活着的 agent：切审批策略、以及「开关刚打开就生效」都要用它。
    ctx.on('agent/created', (payload) => {
      const agent = payload?.agent ?? payload;
      if (!agent?.id) return;
      state.agents.set(String(agent.id), agent);
      ensureApprovalPreset(agent);
    });
    ctx.on('agent/disposed', (payload) => {
      const agent = payload?.agent ?? payload;
      if (agent?.id) state.agents.delete(String(agent.id));
    });

    ctx.on('approval/request', async (request, next) => {
      const settings = baseSettings();
      if (!settings.approvalMailEnabled) return next();
      if (!settings.user || !settings.authCode) return next();
      const service = ctx.get?.('mailCommand');
      if (!service || typeof service.beginMailDecision !== 'function') return next();

      const agent = request?.agent;
      const sessionId = String(agent?.session?.id ?? agent?.id ?? '');
      if (!sessionId) return next();

      const toolName = String(request?.toolName ?? '工具');
      const reason = String(request?.displayReason ?? request?.reason ?? '未说明原因');
      const timeoutMs = Math.max(60_000, Number(settings.approvalMailTimeoutMs) || 600_000);

      let pending;
      try {
        pending = service.beginMailDecision({ sessionId, summary: `${toolName}: ${reason}`, timeoutMs, signal: request?.signal });
      } catch (error) {
        warn(`审批邮件：申请口令失败（${error?.message ?? error}），交回界面`);
        return next();
      }
      if (!pending) return next();

      try {
        await sendComposed(
          settings,
          buildApprovalMail({ toolName, reason, sessionId, token: pending.token, minutes: Math.round(timeoutMs / 60000) }),
        );
        state.stats.approvalMails += 1;
        log(`审批邮件已发出：${toolName}（口令 ${pending.token}）`);
      } catch (error) {
        // 邮件都没发出去，就别干等：立刻释放这次等待，交回界面
        state.stats.lastApprovalError = String(error?.message ?? error);
        warn(`审批邮件发送失败（${error?.message ?? error}），立刻交回界面`);
        pending.cancel?.();
        return next();
      }

      const outcome = await pending.decision;
      if (outcome === 'allow') {
        log(`审批邮件放行：${toolName}（会话 ${sessionId}）`);
        return 'allowed-once';
      }
      if (outcome === 'deny') {
        log(`审批邮件拒绝：${toolName}（会话 ${sessionId}）`);
        return 'rejected';
      }
      log(`审批邮件未给结论（超时或看不懂），交回界面：${toolName}`);
      return next();
    });
  }

  function noteSent(entry, summary, message, settings, extra = {}) {
    state.stats.sent += 1;
    if (summary.failed) state.stats.failureNotices += 1;
    state.errors.delete(entry.sessionId);
    state.stats.lastSend = {
      at: Date.now(),
      sessionId: entry.sessionId,
      turns: summary.turns,
      count: summary.count,
      to: settings.to || settings.user,
      subject: message.subject,
      durationMs: summary.totalDuration,
      failed: summary.failed,
      failure: summary.primaryFailure?.hint,
      ...extra,
    };
  }

  /**
   * 给一封要发出的邮件挂上口令与「可用指令」清单。
   * 每一封都挂：结束、失败、进度都一样。口令由接收侧按会话复用，
   * 所以同一会话的邮件带的是同一个口令，回哪一封都行。
   */
  function attachCommandBlock(message, settings, sessionId) {
    // 口令由附属插件 dsh-mail-command 统一签发：它负责校验与注入，
    // 本插件只负责把口令拼进邮件。没装那个插件时就没有口令，邮件仍照常发。
    const service = ctx.get?.('mailCommand');
    if (!service || typeof service.issueToken !== 'function') return undefined;
    let token;
    try {
      if (typeof service.isEnabled === 'function' && !service.isEnabled()) return undefined;
      token = service.issueToken(sessionId);
    } catch (error) {
      warn(`申请口令失败: ${error && error.message ? error.message : error}`);
      return undefined;
    }
    if (!token) return undefined;
    message.subject = `${message.subject} [CONT:${token}]`;
    const lines = [
      '',
      '---',
      `可用指令（直接回复本邮件，保留主题里的 [CONT:${token}]）：`,
      '  · 继续 —— 正文写要继续做的事；只写「继续」就按原计划接着干',
      '  · 停止 —— 正文写「停止」或 stop，立刻中断当前这一轮',
    ];
    message.text = `${message.text}\n${lines.join('\n')}`;
    if (typeof message.html === 'string' && message.html.includes('</body>')) {
      const htmlBlock = [
        `<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e6eb;font-size:12px;color:#8f959e;line-height:1.8">`,
        `可用指令（直接回复本邮件，保留主题里的口令 <b>${token}</b>）：<br>`,
        `· <b>继续</b> —— 正文写要继续做的事；只写「继续」就按原计划接着干<br>`,
        `· <b>停止</b> —— 正文写「停止」或 stop，立刻中断当前这一轮`,
        `</div></body>`,
      ].join('');
      message.html = message.html.replace('</body>', htmlBlock);
    }
    return token;
  }

  /** Sends the batch, retrying once; returns a result for manual callers. */
  async function deliverBatch(entry, reports, settings, options = {}) {
    const { summary, message } = compose(reports, settings, options);
    // 每封邮件都带口令与指令清单（不再只限失败）：用户回复任意一封都能继续或停止。
    attachCommandBlock(message, settings, entry.sessionId);
    try {
      await sendComposed(settings, message);
      noteSent(entry, summary, message, settings);
      log(`已发送通知: ${message.subject} → ${settings.to || settings.user}`);
      return { ok: true, subject: message.subject };
    } catch (error) {
      const detail = error?.message ?? String(error);
      state.stats.failed += 1;
      state.stats.lastError = { at: Date.now(), message: detail };
      warn(`发送失败: ${detail}`);
      if (state.disposed) return { ok: false, error: detail };
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      if (state.disposed) return { ok: false, error: detail };
      try {
        await sendComposed(settings, message);
        noteSent(entry, summary, message, settings, { retried: true });
        return { ok: true, subject: message.subject, retried: true };
      } catch (again) {
        const againDetail = again?.message ?? String(again);
        state.stats.lastError = { at: Date.now(), message: againDetail };
        warn(`重试仍失败: ${againDetail}`);
        return { ok: false, error: againDetail };
      }
    }
  }

  async function deliver(entry) {
    if (state.disposed) return;
    if (!state.merged) await reload();
    const settings = settingsFor(entry.sessionId);
    if (!settings.enabled) return noteSkip('disabled', entry);

    const session = sessions()?.get?.(entry.sessionId);
    if (!session) return noteSkip('session-missing', entry);

    const header = session.header ?? {};
    if (settings.skipSubagents && (header.origin === 'subagent' || header.parentSession)) {
      return noteSkip('subagent', entry);
    }
    if (state.running.has(entry.sessionId) && !overBatchCap(entry, settings)) {
      // Still working and the batch is young: keep it and retry later.
      arm(entry, retryDelayFor(entry, settings));
      return { ok: false, deferred: true };
    }
    // Past `maxBatchMs` the batch is mailed even mid-work, otherwise a long
    // session would never report anything at all.
    const midWork = state.running.has(entry.sessionId);
    // Quiet hours defer a normal recap instead of dropping it; a failure still
    // goes out, because it needs a human decision.
    const quiet = quietRemainingMs(settings.quietHours);
    if (quiet > 0 && !entry.urgent && !midWork) {
      arm(entry, quiet + 5_000);
      state.stats.lastSkip = { at: Date.now(), reason: 'quiet-hours-deferred', sessionId: entry.sessionId };
      return { ok: false, deferred: true };
    }

    const items = [...entry.turns.values()];
    if (items.length === 0) return noteSkip('empty', entry);
    const reports = collectEntryReports(session, items, settings);
    if (reports.length === 0) return noteSkip('too-short', entry);

    if (!settings.user || !settings.authCode) {
      warn('SMTP 账号或授权码未配置，跳过通知（可用 qq_mail_notify configure 写入）');
      return noteSkip('not-configured', entry);
    }

    return deliverBatch(entry, reports, settings, { inProgress: midWork });
  }

  /**
   * Asks the user, once per new conversation, how that conversation reports
   * back. Runs detached: conversation creation must never wait for a human.
   */
  async function promptForSession(agent) {
    const sessionId = String(agent.id);
    const settings = settingsFor(sessionId);
    if (!settings.enabled) return;
    if (state.sessionOverrides?.[sessionId]) return;

    const questions = ctx.get?.('userQuestions');
    if (!questions?.ask) {
      state.stats.lastSessionPrompt = { at: Date.now(), sessionId, ok: false, reason: 'userQuestions 服务不可用' };
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SESSION_PROMPT_TIMEOUT_MS);
    timer.unref?.();
    state.stats.sessionPrompts += 1;
    state.prompting.add(sessionId);
    try {
      const answer = await questions.ask({
        agent,
        signal: controller.signal,
        questions: [{
          id: SESSION_QUESTION_ID,
          header: '邮件通知',
          question: '这个对话的工作结束通知怎么发？',
          detail: '默认：每轮工作停下立刻发一封到 QQ 邮箱。想安静些可以选攒批。只影响本对话。',
          options: SESSION_PRESETS.map(({ label, description }) => ({ label, description })),
        }],
      });
      const item = answer?.answers?.find((entry) => entry.id === SESSION_QUESTION_ID);
      const choice = item?.selected?.[0] ?? item?.custom ?? SESSION_PRESETS[0].label;
      const preset = SESSION_PRESETS.find((candidate) => candidate.label === choice) ?? SESSION_PRESETS[0];
      const saved = await writeSessionOverride(sessionId, preset.patch);
      state.sessionOverrides[sessionId] = saved;
      state.stats.sessionAnswers += 1;
      state.stats.lastSessionPrompt = { at: Date.now(), sessionId, ok: true, choice: preset.label };
      log(`会话通知设置: ${sessionId} → ${preset.label}`);
    } catch (error) {
      state.stats.lastSessionPrompt = {
        at: Date.now(), sessionId, ok: false, reason: error?.message ?? String(error),
      };
    } finally {
      clearTimeout(timer);
      state.prompting.delete(sessionId);
    }
  }

  const onAgentCreated = (payload) => {
    const agent = payload?.agent;
    if (!agent) return;
    // Only a brand-new conversation asks; resume/compact/clear keep their state.
    if (payload?.source !== 'startup') return;
    const session = sessions()?.get?.(agent.id);
    const header = session?.header ?? {};
    if (header.origin === 'subagent' || header.parentSession) return;
    if (state.disposed) return;
    void promptForSession(agent).catch((error) => warn(`会话通知提问失败: ${error?.message ?? error}`));
  };

  const onTurnStopping = (payload) => {
    const agent = payload?.agent;
    if (!agent) return;
    const sessionId = String(agent.id);
    state.stats.turnStoppings += 1;
    state.stats.lastTurnStopping = {
      at: Date.now(),
      sessionId,
      turn: payload?.turn ?? null,
    };
    try {
      cancelProgress(sessionId);
      schedule(sessionId, payload?.turn);
    } catch (error) {
      warn(`安排通知失败: ${error?.message ?? error}`);
    }
  };

  const onStatus = (payload) => {
    const agent = payload?.agent;
    if (!agent) return;
    const sessionId = String(agent.id);
    if (payload.status === 'running') {
      // Work resumed. Keep the batch: its timer will defer while the agent is
      // busy, so turns already collected are never thrown away.
      state.running.add(sessionId);
      armProgress(sessionId);
      return;
    }
    if (payload.status === 'idle') {
      cancelProgress(sessionId);
      const wasRunning = state.running.delete(sessionId);
      if (!wasRunning) return;
      if (state.pending.has(sessionId)) return;
      // Fallback: covers compositions where the turn boundary event is not
      // delivered to the plugin's own scope.
      try {
        schedule(sessionId, undefined);
      } catch (error) {
        warn(`安排通知失败: ${error?.message ?? error}`);
      }
    }
  };

  const onError = (payload) => {
    const sessionId = String(payload?.agent?.id ?? '');
    if (!sessionId) return;
    const record = {
      at: Date.now(),
      turn: payload?.turn,
      step: payload?.step,
      error: payload?.error,
    };
    state.errors.set(sessionId, record);
    state.stats.lastAgentError = {
      at: record.at, sessionId, turn: record.turn, step: record.step,
    };
    // A failure is urgent: skip the idle window so the reason reaches the user
    // immediately, including whatever the batch already collected.
    try {
      schedule(sessionId, record.turn, { urgent: true, error: record.error });
    } catch (error) {
      warn(`安排失败通知失败: ${error?.message ?? error}`);
    }
  };

  const onDisposed = (payload) => {
    const sessionId = String(payload?.agent?.id ?? '');
    if (!sessionId) return;
    state.running.delete(sessionId);
    state.errors.delete(sessionId);
    const entry = state.pending.get(sessionId);
    if (entry) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        state.timers.delete(entry.timer);
      }
      state.pending.delete(sessionId);
      // A conversation closing must not swallow what it already collected: try
      // one last delivery instead of dropping the batch silently.
      deliver(entry).catch((error) => warn(`关闭前补发失败: ${error?.message ?? error}`));
    }
  };

  const disposers = [];
  const listen = (event, handler) => {
    try {
      const dispose = ctx.on?.(event, handler);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      warn(`监听 ${event} 失败: ${error?.message ?? error}`);
    }
  };
  listen('agent/created', onAgentCreated);
  listen('agent/turn-stopping', onTurnStopping);
  listen('agent/status', onStatus);
  listen('agent/error', onError);
  listen('agent/disposed', onDisposed);

  // Also settle this conversation's setting through the model, which covers UIs
  // where the proactive question card cannot be presented.
  function registerPromptSection(service) {
    if (!service || typeof service.section !== 'function') return;
    try {
      const dispose = service.section({
        name: 'qq-mail-notify/session-setup',
        order: 6000,
        text: SESSION_PROMPT_TEXT,
      });
      if (typeof dispose === 'function') disposers.push(dispose);
      state.stats.promptSection = true;
    } catch (error) {
      state.stats.promptSection = false;
      warn(`注册系统提示片段失败: ${error?.message ?? error}`);
    }
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['systemPrompt'], (scope) => {
        registerPromptSection(scope?.systemPrompt ?? ctx.get?.('systemPrompt'));
      });
    } catch (error) {
      warn(`注入 systemPrompt 服务失败: ${error?.message ?? error}`);
    }
  } else {
    registerPromptSection(ctx.get?.('systemPrompt'));
  }

  // ---- 设置界面（Web）------------------------------------------------------
  // 只做三件事：把当前配置交给设置页、把设置页的改动写回文件、发一封测试邮件。
  // 全部同源校验；授权码只回传打码后的值，明文永远不出这个进程。

  function sendJson(response, status, payload) {
    response.writeHead(status, {
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
    });
    response.end(JSON.stringify(payload));
  }

  function headerOf(request, name) {
    const value = request.headers?.[name];
    if (Array.isArray(value)) return String(value[0] ?? '');
    return value === undefined ? '' : String(value);
  }

  /** 改配置等同于改凭据，跨站请求一律不接。 */
  function sameOrigin(request, response) {
    if (headerOf(request, 'sec-fetch-site').toLowerCase() === 'cross-site') {
      sendJson(response, 403, { ok: false, error: 'cross-origin blocked' });
      return false;
    }
    const origin = headerOf(request, 'origin').trim();
    if (!origin) return true;
    if (origin === 'null') {
      sendJson(response, 403, { ok: false, error: 'cross-origin blocked' });
      return false;
    }
    if (origin.startsWith('dsh-app:')) return true;
    const host = headerOf(request, 'host').trim();
    try {
      if (!host || new URL(origin).host.toLowerCase() === host.toLowerCase()) return true;
    } catch {
      /* fall through to the rejection below */
    }
    sendJson(response, 403, { ok: false, error: 'cross-origin blocked' });
    return false;
  }

  async function readJsonBody(request, maxBytes = 64 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new Error('request body too large');
      chunks.push(buffer);
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    return raw ? JSON.parse(raw) : {};
  }

  /** 设置页能写的字段白名单，其余键一律忽略。 */
  const EDITABLE_KEYS = Object.freeze([
    'enabled', 'smtpHost', 'smtpPort', 'secure', 'user', 'authCode', 'to', 'fromName',
    'subjectPrefix', 'idleDelayMs', 'progressEveryMs', 'maxBatchMs', 'maxBatchTurns',
    'minTurnMs', 'skipSubagents', 'notifyOnAbort', 'quietHours', 'includePreview', 'previewChars',
    'approvalMailEnabled', 'approvalMailTimeoutMs',
  ]);

  /** 当前会话的权限预设名；宿主没有该服务、或取不到时返回 undefined。 */
  function currentPresetName() {
    const presets = ctx.get?.('permissionPresets');
    if (!presets || typeof presets.current !== 'function') return undefined;
    for (const agent of state.agents.values()) {
      try {
        const name = presets.current(agent.session);
        if (name) return String(name);
      } catch {
        /* 单个 agent 取不到就试下一个 */
      }
    }
    return undefined;
  }

  async function settingsSnapshot() {
    const merged = state.merged ?? (await reload());
    const described = describeSettings(merged);
    const settings = described.settings ?? {};
    return {
      ok: true,
      ready: described.ready,
      missing: described.missing ?? [],
      file: settingsFile(),
      settings: { ...settings, authCode: settings.authCode ? maskSecret(settings.authCode) : '' },
      sources: described.sources ?? {},
      defaults: DEFAULTS,
      /**
       * 接收侧是否在场。审批邮件必须两个插件都装才有意义，设置面板据此决定
       * 要不要显示那个开关——单独装通知插件时它根本不该出现。
       */
      commandAvailable: typeof ctx.get?.('mailCommand')?.beginMailDecision === 'function',
      /** 审批要能触发，会话必须处在 workspace-write（沙箱限工作区 + 审批 ask）。 */
      currentPreset: currentPresetName() ?? null,
      approvalPolicyReady: currentPresetName() === 'workspace-write',
      stats: {
        sent: state.stats.sent,
        approvalMails: state.stats.approvalMails,
        lastApprovalError: state.stats.lastApprovalError,
        progressSent: state.stats.progressSent,
        failed: state.stats.failed,
        skipped: state.stats.skipped,
        pending: state.pending.size,
        running: [...state.running],
      },
    };
  }

  function registerWebSettings(host) {
    const offs = [];
    const add = (path, method, handler) => {
      try {
        const off = host.register({
          kind: 'exact',
          path,
          handler: async (request, response) => {
            if (!sameOrigin(request, response)) return;
            if (request.method !== method) {
              response.writeHead(405, { allow: method });
              response.end();
              return;
            }
            try {
              await handler(request, response);
            } catch (error) {
              sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
            }
          },
        });
        if (typeof off === 'function') offs.push(off);
      } catch (error) {
        warn(`注册设置页接口失败 (${path}): ${error?.message ?? error}`);
      }
    };

    add('/dsh-qq-mail-notify/status', 'GET', async (request, response) => {
      sendJson(response, 200, await settingsSnapshot());
    });

    add('/dsh-qq-mail-notify/config', 'POST', async (request, response) => {
      const body = await readJsonBody(request).catch(() => ({}));
      const patch = {};
      for (const key of EDITABLE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
      }
      if (Object.keys(patch).length === 0) {
        sendJson(response, 400, { ok: false, error: '没有可写入的字段' });
        return;
      }
      const wasEnabled = state.merged?.settings?.approvalMailEnabled === true;
      await writeStored(patch);
      await reload();
      // 开关翻转：打开就立刻立起审批，关闭就把预设还回去
      if (state.merged?.settings?.approvalMailEnabled === true) applyApprovalPolicyToAgents();
      else if (wasEnabled) restorePresetsForAgents();
      log(`设置页更新配置: ${Object.keys(patch).join(', ')}`);
      sendJson(response, 200, await settingsSnapshot());
    });

    add('/dsh-qq-mail-notify/test', 'POST', async (request, response) => {
      const result = await testPayload();
      sendJson(response, result?.ok ? 200 : 500, result);
    });

    return () => {
      for (const off of offs) {
        try {
          off();
        } catch {
          /* ignore */
        }
      }
    };
  }

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scope) => {
        const host = scope?.webServer ?? ctx.get?.('webServer');
        if (!host || typeof host.register !== 'function') return;
        const dispose = registerWebSettings(host);
        if (typeof ctx.effect === 'function') ctx.effect(() => dispose);
      });
    } catch (error) {
      warn(`注入 webServer 服务失败: ${error?.message ?? error}`);
    }
  }

  // ---- tool -------------------------------------------------------------

  async function statusPayload(args) {
    const merged = state.merged ?? (await reload());
    const described = describeSettings(merged);
    return {
      ok: true,
      ready: described.ready,
      missing: described.missing,
      file: described.file,
      settings: described.settings,
      sources: described.sources,
      stats: {
        ...state.stats,
        pending: [...state.pending.values()].map((entry) => ({
          sessionId: entry.sessionId,
          turns: [...entry.turns.keys()],
          waitedMs: Date.now() - entry.lastAt,
          batchAgeMs: Date.now() - entry.firstAt,
          urgent: entry.urgent,
        })),
        activeTimers: state.timers.size,
        running: [...state.running],
        trackedErrors: [...state.errors.entries()].map(([sessionId, record]) => ({
          sessionId, turn: record.turn, step: record.step, at: record.at,
        })),
      },
      actions: TOOL_ACTIONS,
      sessions: {
        file: sessionsFile(),
        tracked: Object.keys(state.sessionOverrides ?? {}).length,
        presets: SESSION_PRESETS.map((preset) => preset.label),
      },
    };
  }

  async function configurePayload(args) {
    const patch = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (args?.[key] !== undefined && args?.[key] !== null) patch[key] = args[key];
    }
    if (args?.email && patch.user === undefined) patch.user = String(args.email);
    if (Object.keys(patch).length === 0) {
      return { ok: false, error: '没有可写入的字段', writable: Object.keys(DEFAULTS) };
    }
    try {
      const wasEnabled = state.merged?.settings?.approvalMailEnabled === true;
      const stored = await writeStored(patch);
      state.merged = resolveSettings({ config: state.config, stored });
      // 开关翻转：打开就立刻立起审批，关闭就把预设还回去
      if (state.merged?.settings?.approvalMailEnabled === true) applyApprovalPolicyToAgents();
      else if (wasEnabled) restorePresetsForAgents();
      const described = describeSettings(state.merged);
      return {
        ok: true,
        file: described.file,
        written: Object.keys(patch),
        ready: described.ready,
        missing: described.missing,
        settings: described.settings,
        sources: described.sources,
      };
    } catch (error) {
      return { ok: false, error: `写配置失败: ${error?.message ?? error}` };
    }
  }

  async function testPayload() {
    const merged = state.merged ?? (await reload());
    const { settings } = merged;
    if (!settings.user || !settings.authCode) {
      return { ok: false, error: '缺少发件邮箱或授权码', missing: ['user', 'authCode'].filter((key) => !settings[key]) };
    }
    const prefix = settings.subjectPrefix ? `${settings.subjectPrefix} ` : '';
    const subject = `${prefix}QQ 邮箱通知测试`;
    const now = new Date().toLocaleString('zh-CN');
    const cadence = Number(settings.idleDelayMs) > 0
      ? `攒批（停手 ${Math.round(Number(settings.idleDelayMs) / 1000)} 秒后汇总）`
      : '即时（每轮结束就发）';
    const recipients = settings.to || settings.user;
    const rows = [
      ['发送时间', now],
      ['工作目录', process.cwd()],
      ['SMTP 服务器', `${settings.smtpHost}:${settings.smtpPort}（${settings.secure ? '隐式 TLS' : 'STARTTLS'}）`],
      ['发件人', settings.user],
      ['收件人', recipients],
      ['发送节奏', cadence],
    ];
    const text = [
      '这是一封来自 DeepSeek Harness 的测试邮件。',
      '',
      ...rows.map(([label, value]) => `${label}: ${value}`),
      '',
      '收到这封邮件说明「工作结束通知」已经可以正常投递。',
    ].join('\n');
    const html = `<div style="font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.7">
<p>这是一封来自 <strong>DeepSeek Harness</strong> 的测试邮件。</p>
<table style="border-collapse:collapse;font-size:13px;margin:12px 0">
${rows.map(([label, value]) => `<tr><td style="padding:4px 12px 4px 0;color:#646a73;white-space:nowrap">${label}</td><td style="padding:4px 0;word-break:break-all">${value}</td></tr>`).join('\n')}
</table>
<p>收到这封邮件说明「工作结束通知」已经可以正常投递。</p></div>`;
    try {
      const result = await sendComposed(settings, { subject, text, html });
      state.stats.sent += 1;
      state.stats.lastSend = { at: Date.now(), test: true, subject, to: settings.to || settings.user };
      return { ok: true, to: settings.to || settings.user, accepted: result.accepted };
    } catch (error) {
      const detail = error?.message ?? String(error);
      state.stats.failed += 1;
      state.stats.lastError = { at: Date.now(), message: detail };
      return { ok: false, error: detail };
    }
  }

  async function sendNowPayload(agent) {
    const sessionId = String(agent?.id ?? '');
    if (!sessionId) return { ok: false, error: '当前调用没有 agent 上下文，无法定位会话' };
    const session = sessions()?.get?.(sessionId);
    if (!session) return { ok: false, error: `找不到会话 ${sessionId}` };
    if (!state.merged) await reload();
    const settings = settingsFor(sessionId);
    if (!settings.user || !settings.authCode) {
      return { ok: false, error: '缺少发件邮箱或授权码', missing: ['user', 'authCode'].filter((key) => !settings[key]) };
    }

    const entry = state.pending.get(sessionId) ?? {
      sessionId,
      turns: new Map([['latest', { turn: undefined, at: Date.now() }]]),
      firstAt: Date.now(),
      lastAt: Date.now(),
      timer: null,
      urgent: false,
    };
    const items = [...entry.turns.values()];
    const reports = collectEntryReports(session, items, settings, { force: true });
    if (reports.length === 0) return { ok: false, error: '当前会话还没有可用内容' };

    // 工作还在跑就按"进行中"渲染（不给结束时间、状态写进行中），
    // 已经停了才按正常收尾渲染——否则手动发的进度邮件会写着"已结束"。
    const result = await deliverBatch(entry, reports, settings, { inProgress: state.running.has(sessionId) });
    if (result.ok) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        state.timers.delete(entry.timer);
      }
      state.pending.delete(sessionId);
      const summary = summarizeReports(reports);
      return {
        ok: true,
        to: settings.to || settings.user,
        subject: result.subject,
        turns: summary.turns,
        failed: summary.failed,
      };
    }
    return result;
  }

  /** Reads or writes the current conversation's notification overrides. */
  async function sessionPayload(agent, args) {
    const sessionId = String(agent?.id ?? '');
    if (!sessionId) return { ok: false, error: '当前调用没有 agent 上下文，无法定位会话' };

    const fields = {};
    for (const key of Object.keys(DEFAULTS)) {
      if (args?.[key] !== undefined && args?.[key] !== null) fields[key] = args[key];
    }

    if (Object.keys(fields).length === 0) {
      const override = state.sessionOverrides?.[sessionId];
      const settings = settingsFor(sessionId);
      if (state.prompting.has(sessionId)) {
        return {
          ok: true,
          sessionId,
          decided: true,
          pending: true,
          effective: { enabled: settings.enabled, idleDelayMs: settings.idleDelayMs },
          hint: '通知设置的问题卡片已经弹出，等用户选一下；本轮直接继续，不要重复提问。',
        };
      }
      return {
        ok: true,
        sessionId,
        decided: Boolean(override),
        override: override ?? null,
        effective: {
          enabled: settings.enabled,
          idleDelayMs: settings.idleDelayMs,
          maxBatchMs: settings.maxBatchMs,
          maxBatchTurns: settings.maxBatchTurns,
          minTurnMs: settings.minTurnMs,
          quietHours: settings.quietHours,
        },
        presets: SESSION_PRESETS.map((preset) => ({ label: preset.label, description: preset.description })),
        file: sessionsFile(),
        hint: override
          ? '本对话已经有设置；再写一次字段即可修改，不会再提问。'
          : '本对话还没有设置：先用 ask_user_question 问一次，或直接写入字段。',
      };
    }

    try {
      const saved = await writeSessionOverride(sessionId, fields);
      state.sessionOverrides[sessionId] = saved;
      const settings = settingsFor(sessionId);
      return {
        ok: true,
        sessionId,
        decided: true,
        written: Object.keys(fields),
        override: saved,
        effective: {
          enabled: settings.enabled,
          idleDelayMs: settings.idleDelayMs,
          maxBatchMs: settings.maxBatchMs,
        },
      };
    } catch (error) {
      return { ok: false, error: `写会话设置失败: ${error?.message ?? error}` };
    }
  }

  const tool = {
    name: TOOL_NAME,
    description:
      '配置或触发「工作结束 QQ 邮箱通知」：每轮工作停下后把摘要发一封邮件到 QQ 邮箱。'
      + '默认即时发送（这一轮结束就发）；把 idleDelayMs 调大可以攒批，连续对话只收到一封，累计超过 30 分钟或 20 轮也会强制先发一封。'
      + '工作失败（额度/余额不足、鉴权失效、限流、网络错误、服务端错误等）时不受等待限制，立刻发并写明原因与错误码。'
      + 'action=status 查看配置与统计；action=configure 写入全局配置（发件邮箱、SMTP 授权码、收件人、等待时长等，'
      + '保存到 $DSH_HOME/qq-mail-notify.json）；action=session 读写「本对话」的覆盖设置'
      + '（不带字段=读取，返回 decided 表示这个对话是否已定过；带字段=写入，只影响本对话）；'
      + 'action=test 立刻发一封测试邮件；action=send 立刻把当前会话攒着的进度发一封。'
      + 'QQ 邮箱需要先在「设置 → 账户」开启 SMTP 服务并生成 16 位授权码。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: TOOL_ACTIONS,
          description: 'status | configure | test | send。默认 status。',
        },
        email: { type: 'string', description: '发件邮箱地址，等价于 user，如 123456@qq.com（QQ 是主路径，其他服务商也支持）。' },
        user: { type: 'string', description: '发件邮箱地址（SMTP 账号）；它的域名决定默认用哪家服务商。' },
        authCode: { type: 'string', description: 'SMTP 授权码／应用专用密码（QQ 是 16 位授权码，不是登录密码）。' },
        to: { type: 'string', description: '收件人地址，缺省与发件邮箱相同；多个用逗号分隔。' },
        approvalMailEnabled: { type: 'boolean', description: '把「工具在等你授权」转发到邮箱，回信决定允许或拒绝。默认 false；必须同时安装 dsh-mail-command 才有意义。' },
        approvalMailTimeoutMs: { type: 'integer', description: '审批邮件等回信的时长（毫秒），默认 600000（10 分钟）。超时后交回界面等你点，不会替你拒绝。' },
        smtpHost: { type: 'string', description: 'SMTP 服务器。不填时按邮箱域名推断，QQ 邮箱就是 smtp.qq.com；显式填了不会被覆盖。' },
        smtpPort: { type: 'integer', description: '端口。不填按服务商推断（多数是 465 隐式 TLS，Outlook 是 587）。' },
        secure: { type: 'boolean', description: 'true 用隐式 TLS(465)，false 用 STARTTLS(587)。不填按服务商推断。' },
        fromName: { type: 'string', description: '发件人显示名。' },
        subjectPrefix: { type: 'string', description: '邮件主题前缀，默认 [DSH]。' },
        idleDelayMs: {
          type: 'integer',
          description: '最后动作结束后静默多久才发（毫秒）。默认 0＝即时发送（这一轮结束就发）；调大则攒批，连续对话只收一封。',
        },
        progressEveryMs: {
          type: 'integer',
          description: '一轮跑超过这个时长就先发一封进度通报（毫秒），默认 2400000（40 分钟）；0 关闭。',
        },
        maxBatchMs: {
          type: 'integer',
          description: '一批最多攒多久就必须先发一封（毫秒），默认 1800000（30 分钟）；0 表示不限。',
        },
        maxBatchTurns: { type: 'integer', description: '一批最多攒多少轮就必须先发一封，默认 20。' },
        minTurnMs: { type: 'integer', description: '单轮至少持续多久才计入（毫秒），默认 0（不设门槛）；失败轮不受此限。' },
        skipSubagents: { type: 'boolean', description: '跳过子会话（subagent），默认 true。' },
        notifyOnAbort: { type: 'boolean', description: '被用户或父会话中断时是否也通知，默认 false（失败始终通知）。' },
        quietHours: { type: 'string', description: '免打扰时段，如 23:30-07:30；普通汇总顺延到时段结束再发，失败通知照发。' },
        includePreview: { type: 'boolean', description: '是否在邮件里附带回复摘要，默认 true。' },
        previewChars: { type: 'integer', description: '全部轮次的摘总量上限，默认 1200，会按轮数均分。' },
        enabled: { type: 'boolean', description: '总开关。' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { content: { type: 'array', items: {} } },
        required: ['content'],
        additionalProperties: false,
      },
      render(_args, value) {
        const texts = (value?.content ?? [])
          .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
          .map((part) => part.text);
        return [{ type: 'text', text: texts.join('\n') }];
      },
    },
    async execute(args, exec) {
      const action = String(args?.action ?? 'status').toLowerCase();
      try {
        if (action === 'status') return textResult(await statusPayload(args));
        if (action === 'configure') return textResult(await configurePayload(args));
        if (action === 'session') return textResult(await sessionPayload(exec?.agent, args));
        if (action === 'test') return textResult(await testPayload());
        if (action === 'send') return textResult(await sendNowPayload(exec?.agent));
        return textResult({ ok: false, error: `未知 action: ${action}`, actions: TOOL_ACTIONS });
      } catch (error) {
        return textResult({ ok: false, error: error?.message ?? String(error) });
      }
    },
  };

  const registerTool = (registry) => {
    try {
      const dispose = registry.register(tool);
      if (typeof dispose === 'function') disposers.push(dispose);
      log(`已注册工具 ${TOOL_NAME}`);
    } catch (error) {
      warn(`注册工具失败: ${error?.message ?? error}`);
    }
  };

  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['tools'], (scope) => {
        const registry = scope?.tools ?? ctx.tools;
        if (registry?.register) registerTool(registry);
      });
    } catch (error) {
      warn(`注入 tools 服务失败: ${error?.message ?? error}`);
    }
  } else {
    const registry = ctx.get?.('tools');
    if (registry?.register) registerTool(registry);
    else warn('tools 服务不可用，通知仍会工作，但 qq_mail_notify 工具未注册');
  }

  // 审批邮件：把「等你授权」转发到邮箱。内部自己判断开关、接收侧是否就绪，
  // 任何一条不满足都会原样把请求交回界面。
  installApprovalRelay();

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    state.disposed = true;
    for (const timer of state.timers) clearTimeout(timer);
    state.timers.clear();
    state.pending.clear();
    state.running.clear();
    state.prompting.clear();
    state.errors.clear();
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* already gone */
      }
    }
    disposers.length = 0;
  };
  // cordis 4 never emits a `dispose` event: a listener registered through
  // ctx.on('dispose') is never called, so timers and registrations survive the
  // Host teardown and the desktop update handshake times out. ctx.effect is the
  // hook whose disposer actually runs when this fiber unloads.
  try {
    if (typeof ctx.effect === 'function') ctx.effect(() => cleanup);
    else ctx.on?.('dispose', cleanup);
  } catch {
    /* ignore */
  }

  log(`已激活；配置文件 ${settingsFile()}`);
}

export default { name, inject, apply };
