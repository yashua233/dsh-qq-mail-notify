// Turns finished turns into one notification payload: subject, plain text, and
// a small HTML alternative. Everything is derived from the session log, so a
// notification never invents facts the transcript does not contain.
//
// Two shapes are rendered:
//   - one turn  → the original "this turn ended" recap;
//   - many turns → a batch recap, used when the plugin deliberately waits for a
//     quiet window instead of mailing after every single turn.
//
// A failed turn is a first-class case in both shapes: the reason goes up front
// ("quota exhausted", "sign-in expired", "rate limited", ...), because a silent
// non-delivery is exactly what the user must not get when the model stops
// halfway.

const MAX_TOOL_NAMES = 12;

// Ordered: the first rule whose pattern matches the failure text wins.
const FAILURE_RULES = [
  {
    pattern: /(insufficient|quota|balance|credit|billing|payment|arrear|欠费|余额|额度|充值|402)/i,
    hint: '额度或余额不足',
  },
  {
    pattern: /(401|unauthori[sz]ed|invalid[ _-]?api[ _-]?key|invalid[ _-]?token|authentication[ _-]?failed|auth failed|sign[ _-]?in|登录|凭证|密钥)/i,
    hint: '鉴权失败（登录过期或密钥无效）',
  },
  {
    pattern: /(403|forbidden|permission[ _-]?denied|no[ _-]?permission|无权)/i,
    hint: '没有权限（403）',
  },
  {
    pattern: /(429|rate[ _-]?limit|too many requests|slow down|限流|频率|请求过多)/i,
    hint: '请求被限流（429）',
  },
  {
    pattern: /(context[ _-]?(length|window)|maximum[ _-]?context|too many tokens|prompt is too long|超出.{0,4}窗口|上下文)/i,
    hint: '上下文超出窗口',
  },
  {
    pattern: /(timeout|timed out|etimedout|econnreset|econnrefused|enotfound|socket hang up|fetch failed|network|dns|网络|连接失败|超时)/i,
    hint: '网络连接失败',
  },
  {
    pattern: /(5\d\d|internal[ _-]?server|server[ _-]?error|overload|unavailable|bad gateway|服务不可用|服务端)/i,
    hint: '服务端错误',
  },
];

function textOf(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

export function formatDuration(milliseconds) {
  const total = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours} 小时 ${minutes} 分`;
  if (minutes > 0) return `${minutes} 分 ${seconds} 秒`;
  return `${seconds} 秒`;
}

/** Human wording for the mail body; `endLabel` stays raw for data consumers. */
const END_LABELS = {
  completed: '正常结束',
  aborted: '被中断',
  error: '出错退出',
};

/**
 * Absolute wall-clock stamp, so a mail read hours later still says exactly when
 * this turn ran (duration alone can't be placed on a timeline).
 */
export function formatClock(milliseconds) {
  if (!milliseconds) return '(unknown)';
  const date = new Date(milliseconds);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function readField(value, key) {
  if (value && typeof value === 'object' && key in value) {
    const inner = value[key];
    if (inner !== undefined && inner !== null && inner !== '') return inner;
  }
  return undefined;
}

/** Digs message/code/status out of whatever `agent/error` or a turn end carries. */
export function extractFailureFields(input, depth = 0) {
  const empty = { message: '', code: '', status: '' };
  if (input === undefined || input === null) return empty;
  if (typeof input === 'string') return { message: input, code: '', status: '' };
  if (depth > 3) return { message: String(input), code: '', status: '' };

  if (input instanceof Error) {
    const deeper = extractFailureFields(input.cause, depth + 1);
    return {
      message: String(input.message || deeper.message || ''),
      code: String(readField(input, 'code') ?? deeper.code ?? ''),
      status: String(readField(input, 'status') ?? readField(input, 'statusCode') ?? deeper.status ?? ''),
    };
  }
  if (typeof input === 'object') {
    const deeper = extractFailureFields(
      readField(input, 'error') ?? readField(input, 'failure') ?? readField(input, 'cause'),
      depth + 1,
    );
    return {
      message: String(readField(input, 'message') ?? deeper.message ?? ''),
      code: String(readField(input, 'code') ?? deeper.code ?? ''),
      status: String(readField(input, 'status') ?? readField(input, 'statusCode') ?? deeper.status ?? ''),
    };
  }
  return { message: String(input), code: '', status: '' };
}

/** Normalizes a failure into `{ message, code, status, hint }` with a Chinese hint. */
export function classifyFailure(error) {
  const fields = extractFailureFields(error);
  const haystack = `${fields.code} ${fields.status} ${fields.message}`;
  let hint = '';
  for (const rule of FAILURE_RULES) {
    if (rule.pattern.test(haystack)) {
      hint = rule.hint;
      break;
    }
  }
  if (!hint) {
    const text = fields.message.trim();
    hint = text ? (text.length > 40 ? `${text.slice(0, 40)}…` : text) : (fields.code || '未知错误');
  }
  return { ...fields, hint };
}

function describeTurnEnd(kind, reason) {
  switch (kind) {
    case 'completed':
      return 'completed';
    case 'aborted': {
      const cause = reason?.reason?.kind ?? 'unknown';
      const detail = reason?.reason?.reason ? `: ${reason.reason.reason}` : '';
      return `aborted (${cause}${detail})`;
    }
    case 'error':
      return 'error';
    default:
      return String(kind ?? 'completed');
  }
}

function describeAbort(reason) {
  switch (reason?.reason?.kind) {
    case 'user':
      return '你中断了本轮';
    case 'parent':
      return '父会话中断了本轮';
    case 'hook':
      return reason?.reason?.reason ? `被取消: ${reason.reason.reason}` : '被 hook 取消';
    case 'disposed':
      return '会话被关闭';
    default:
      return '已中断';
  }
}

function dedupeFailures(failures) {
  const seen = new Set();
  const unique = [];
  for (const failure of failures) {
    const key = `${failure.message}|${failure.code}|${failure.hint}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(failure);
  }
  return unique;
}

/** Collects the facts of one turn from the session's own event log. */
export function collectReport(session, turn, options = {}) {
  const { previewChars = 1_200, errorInfo, startedAt, endedAt = Date.now() } = options;
  const events = session?.ownEvents?.() ?? [];

  let targetTurn = turn;
  if (targetTurn === undefined || targetTurn === null) {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event?.type === 'turn/start') {
        targetTurn = event.data?.turn;
        break;
      }
    }
    if (targetTurn === undefined || targetTurn === null) targetTurn = 0;
  }

  let turnStartIndex = -1;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type === 'turn/start' && event.data?.turn === targetTurn) {
      turnStartIndex = index;
      break;
    }
  }
  if (turnStartIndex < 0) turnStartIndex = Math.max(0, events.length - 1);

  const turnStartTime = events[turnStartIndex]?.time ?? startedAt;
  const assistantTexts = [];
  const toolNames = new Map();
  const failures = [];
  let toolCalls = 0;
  let toolFailures = 0;
  let usage;
  let requestText = '';
  let endKind = 'completed';
  let endReason;
  let hasTurnEnd = false;
  let lastStep;
  let lastToolName;

  // 请求原文只取最近一条 user/message：倒序找，不必为它把整个会话从头扫一遍。
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== 'user/message') continue;
    const text = textOf(event.data?.content);
    if (text) {
      requestText = text;
      break;
    }
  }

  // 其余统计只跑本 turn 的事件段：会话越长，全量扫的代价越明显。
  for (let index = turnStartIndex; index < events.length; index += 1) {
    const event = events[index];
    if (!event) continue;
    const data = event.data ?? {};

    if (event.type === 'turn/end' && data.turn === targetTurn) {
      hasTurnEnd = true;
      endKind = data.reason?.kind ?? 'completed';
      endReason = data.reason;
      continue;
    }

    if (event.type === 'step/end' && data.turn === targetTurn) {
      lastStep = data.step;
      continue;
    }
    if (event.type === 'assistant/message' && data.turn === targetTurn) {
      const text = textOf(data.message?.content);
      if (text) assistantTexts.push(text);
      if (data.usage) {
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + (data.usage.inputTokens ?? 0),
          outputTokens: (usage?.outputTokens ?? 0) + (data.usage.outputTokens ?? 0),
        };
      }
      continue;
    }
    if (event.type === 'tool/call' && data.turn === targetTurn) {
      toolCalls += 1;
      lastToolName = String(data.name ?? 'tool');
      toolNames.set(lastToolName, (toolNames.get(lastToolName) ?? 0) + 1);
      continue;
    }
    if (event.type === 'tool/result' && data.turn === targetTurn) {
      if (data.error || data.message?.isError) toolFailures += 1;
      continue;
    }
  }

  if (endKind === 'error' && endReason?.error) {
    failures.push({ source: 'turn', ...classifyFailure(endReason.error) });
  }
  // An error observed mid-turn only means the turn ended badly when no closing
  // event exists; a retry that eventually completed is a warning, not a failure.
  const warnings = [];
  if (errorInfo !== undefined && errorInfo !== null && endKind !== 'error') {
    const classified = { source: 'agent', ...classifyFailure(errorInfo) };
    if (hasTurnEnd) warnings.push(classified);
    else failures.push(classified);
  }

  const uniqueFailures = dedupeFailures(failures);
  const aborted = endKind === 'aborted';
  const failed = endKind === 'error' || uniqueFailures.length > 0;

  const header = session?.header ?? {};
  const previewSource = assistantTexts.join('\n\n');
  const previewText = previewSource.length > previewChars
    ? `${previewSource.slice(0, previewChars)}…`
    : previewSource;
  const begin = startedAt ?? turnStartTime;
  const endLabel = describeTurnEnd(endKind, endReason);

  return {
    sessionId: String(header.id ?? session?.id ?? ''),
    cwd: header.cwd ?? '',
    agentPreset: header.agentPreset ?? '',
    origin: header.origin ?? '',
    parentSession: header.parentSession ? String(header.parentSession) : '',
    turn: targetTurn,
    startedAt: begin,
    endedAt,
    durationMs: begin ? endedAt - begin : 0,
    endKind,
    endLabel,
    reason: endLabel,
    aborted,
    abortReason: aborted ? describeAbort(endReason) : '',
    failed,
    failures: uniqueFailures,
    primaryFailure: uniqueFailures[0],
    warnings,
    requestText,
    previewText,
    toolCalls,
    toolFailures,
    toolNames: [...toolNames.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_TOOL_NAMES)
      .map(([name, count]) => ({ name, count })),
    lastStep,
    lastToolName,
    usage,
  };
}

/** Aggregates several turn reports into the numbers a batch mail leads with. */
export function summarizeReports(reports) {
  const list = (Array.isArray(reports) ? reports : [reports]).filter(Boolean);
  const failedReports = list.filter((report) => report.failed);
  const abortedReports = list.filter((report) => report.aborted);
  const toolNames = new Map();
  let totalDuration = 0;
  let toolCalls = 0;
  let toolFailures = 0;
  let usage;

  for (const report of list) {
    totalDuration += report.durationMs || 0;
    toolCalls += report.toolCalls || 0;
    toolFailures += report.toolFailures || 0;
    if (report.usage) {
      usage = {
        inputTokens: (usage?.inputTokens ?? 0) + (report.usage.inputTokens || 0),
        outputTokens: (usage?.outputTokens ?? 0) + (report.usage.outputTokens || 0),
      };
    }
    for (const item of report.toolNames ?? []) {
      toolNames.set(item.name, (toolNames.get(item.name) ?? 0) + item.count);
    }
  }

  const first = list[0] ?? {};
  return {
    count: list.length,
    cwd: first.cwd ?? '',
    sessionId: first.sessionId ?? '',
    turns: list.map((report) => report.turn),
    totalDuration,
    toolCalls,
    toolFailures,
    usage,
    failed: failedReports.length > 0,
    failedCount: failedReports.length,
    aborted: abortedReports.length > 0 && failedReports.length === 0,
    primaryFailure: failedReports[0]?.primaryFailure,
    toolNames: [...toolNames.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, MAX_TOOL_NAMES)
      .map(([name, count]) => ({ name, count })),
    startedAt: list.length ? Math.min(...list.map((report) => report.startedAt || report.endedAt)) : Date.now(),
    endedAt: list.length ? Math.max(...list.map((report) => report.endedAt || Date.now())) : Date.now(),
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function shortSessionId(sessionId) {
  const parts = String(sessionId).split('-');
  return parts.length > 1 ? `${parts[0]}-${parts[parts.length - 1].slice(0, 8)}` : String(sessionId);
}

function oneLine(value, limit) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function headlineOf(summary) {
  const cwdName = summary.cwd ? summary.cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '';
  return cwdName || shortSessionId(summary.sessionId);
}

function toolLine(toolCalls, toolFailures, toolNames) {
  if (!toolCalls) return '工具: 未调用';
  const details = toolNames?.length
    ? ` — ${toolNames.map((item) => `${item.name}×${item.count}`).join(', ')}`
    : '';
  return `工具: ${toolCalls} 次调用${toolFailures ? ` (${toolFailures} 次失败)` : ''}${details}`;
}

function tokenLine(usage) {
  return usage
    ? `Token: 输入 ${usage.inputTokens.toLocaleString('en-US')} / 输出 ${usage.outputTokens.toLocaleString('en-US')}`
    : '';
}

function failureLine(failure) {
  const codeStatus = [failure?.code, failure?.status ? `HTTP ${failure.status}` : ''].filter(Boolean).join(' / ');
  return codeStatus ? `错误码: ${codeStatus}` : '';
}

/**
 * 一条错误的单行描述。分类器没命中时 hint 就是 message 的截断，
 * 这时只输出一次，别再拼成「截断: 全文」。
 */
function failureText(failure, limit = 160) {
  if (!failure) return '未知错误';
  const hint = String(failure.hint ?? '').trim();
  if (!failure.message) return hint || '未知错误';
  const message = oneLine(String(failure.message), limit);
  const bare = hint.replace(/…$/, '');
  if (bare && message.startsWith(bare)) return message;
  return hint ? `${hint}: ${message}` : message;
}

function turnHeading(report, live = false) {
  const state = live ? '进行中' : report.failed ? '失败' : report.aborted ? '中断' : '完成';
  return `第 ${report.turn} 轮 · ${formatDuration(report.durationMs)} · ${state}`;
}

function turnStateText(report) {
  return report.failed
    ? (report.primaryFailure?.hint ?? '未知错误')
    : report.aborted
      ? report.abortReason
      : formatDuration(report.durationMs);
}

function renderSingle(report, settings) {
  const summary = summarizeReports([report]);
  const prefix = settings.subjectPrefix ? `${settings.subjectPrefix} ` : '';
  const headline = headlineOf(summary);
  const failure = report.primaryFailure;
  const stateLabel = report.failed
    ? '工作失败'
    : report.aborted
      ? '工作中断'
      : settings.inProgress ? '工作继续' : '工作结束';
  const subject = report.failed
    ? `${prefix}${stateLabel} · ${headline} · ${oneLine(failure?.hint || '未知错误', 48)}`
    : `${prefix}${stateLabel} · ${headline} · ${formatDuration(report.durationMs)}`;

  const lines = [];
  if (report.failed) {
    lines.push('本轮工作失败。', '');
    lines.push(`原因: ${failure?.hint ?? '未知错误'}`);
    if (failure?.message) lines.push(`详情: ${oneLine(failure.message, 300)}`);
  } else if (report.aborted) {
    lines.push('本轮工作被中断。', '', `原因: ${report.abortReason}`);
  } else {
    lines.push(settings.inProgress
      ? `本轮还在跑，先报个进度（已进行 ${formatDuration(report.durationMs)}）。`
      : '本轮工作已结束。');
  }
  lines.push('');
  lines.push(`目录: ${report.cwd || '(unknown)'}`);
  lines.push(`会话: ${report.sessionId}`);
  if (report.agentPreset) lines.push(`预设: ${report.agentPreset}`);
  if (report.origin) lines.push(`来源: ${report.origin}`);
  if (report.parentSession) lines.push(`父会话: ${report.parentSession}`);
  lines.push(`轮次: ${report.turn}`);
  if (report.lastStep !== undefined) lines.push(`步骤: 停在第 ${report.lastStep} 步`);
  lines.push(`开始: ${formatClock(report.startedAt)}`);
  // 进行中的进度通报没有"结束"，写成结束时间会和"还在跑"自相矛盾
  if (!settings.inProgress) lines.push(`结束: ${formatClock(report.endedAt)}`);
  lines.push(`耗时: ${formatDuration(report.durationMs)}`);
  lines.push(`状态: ${settings.inProgress ? '进行中' : (END_LABELS[report.endKind] ?? report.endLabel)}`);
  lines.push(toolLine(report.toolCalls, report.toolFailures, report.toolNames));
  if (report.lastToolName) lines.push(`最后动作: ${report.lastToolName}`);
  const tokens = tokenLine(report.usage);
  if (tokens) lines.push(tokens);
  lines.push(failureLine(failure));
  if (report.warnings?.length) {
    lines.push('', `过程中出现过 ${report.warnings.length} 次错误，已自动恢复:`);
    for (const item of report.warnings) {
      lines.push(`- ${failureText(item)}`);
    }
  }
  const others = (report.failures ?? []).slice(1);
  if (others.length) {
    lines.push('', '其它错误:');
    for (const item of others) lines.push(`- ${failureText(item, 200)}`);
  }
  if (report.requestText) lines.push('', '请求:', `> ${oneLine(report.requestText, 800)}`);
  if (settings.includePreview && report.previewText) {
    lines.push('', report.failed ? '失败前的输出:' : '回复摘要:', report.previewText);
  }

  return { subject, text: lines.filter(Boolean).join('\n'), html: renderHtml([report], summary, settings) };
}

function renderBatch(reports, summary, settings) {
  const prefix = settings.subjectPrefix ? `${settings.subjectPrefix} ` : '';
  const headline = headlineOf(summary);
  const stateLabel = summary.failed
    ? '工作失败'
    : summary.aborted
      ? '工作中断'
      : settings.inProgress ? '工作继续' : '工作结束';
  const subject = summary.failed
    ? `${prefix}${stateLabel} · ${headline} · ${summary.failedCount} 轮失败 · ${oneLine(summary.primaryFailure?.hint || '未知错误', 32)}`
    : `${prefix}${stateLabel} · ${headline} · ${summary.count} 轮 · ${formatDuration(summary.totalDuration)}`;

  const lines = [];
  if (summary.failed) {
    lines.push(`这段时间有 ${summary.failedCount} 轮失败（共 ${summary.count} 轮）。`, '');
    const failed = reports.filter((report) => report.failed).slice(0, 4);
    for (const report of failed) {
      lines.push(`- 第 ${report.turn} 轮: ${report.primaryFailure?.hint ?? '未知错误'}`);
      if (report.primaryFailure?.message) lines.push(`  ${oneLine(report.primaryFailure.message, 200)}`);
    }
  } else if (summary.aborted) {
    lines.push(`这一批工作已中断（${summary.count} 轮）。`);
  } else {
    lines.push(settings.inProgress
      ? `这一批还在继续（已完成 ${summary.count} 轮，累计 ${formatDuration(summary.totalDuration)}）。`
      : `这一批工作已结束（${summary.count} 轮，累计 ${formatDuration(summary.totalDuration)}）。`);
  }
  lines.push('');
  lines.push(`目录: ${summary.cwd || '(unknown)'}`);
  lines.push(`会话: ${summary.sessionId}`);
  lines.push(`轮次: ${summary.turns.join(', ')}`);
  lines.push(toolLine(summary.toolCalls, summary.toolFailures, summary.toolNames));
  const tokens = tokenLine(summary.usage);
  if (tokens) lines.push(tokens);

  const perTurnLimit = Math.max(160, Math.min(600, Math.floor((settings.previewChars || 1_200) / Math.max(1, summary.count))));
  reports.forEach((report, index) => {
    // 进度通报里最后一轮还在跑：没有结束时间，状态也不能写"完成"
    const live = Boolean(settings.inProgress) && index === reports.length - 1;
    lines.push('', `[${index + 1}] ${turnHeading(report, live)}`);
    lines.push(live
      ? `时间: ${formatClock(report.startedAt)} 起 · 已进行 ${formatDuration(report.durationMs)}`
      : `时间: ${formatClock(report.startedAt)} → ${formatClock(report.endedAt)}`);
    if (report.requestText) lines.push(`请求: ${oneLine(report.requestText, 300)}`);
    if (report.failed) {
      lines.push(`原因: ${report.primaryFailure?.hint ?? '未知错误'}`);
      const extra = failureLine(report.primaryFailure);
      if (extra) lines.push(extra);
      if (report.primaryFailure?.message) lines.push(`详情: ${oneLine(report.primaryFailure.message, 300)}`);
    } else if (report.aborted) {
      lines.push(`原因: ${report.abortReason}`);
    }
    // 中途出错又自动恢复的轮次：不算失败，但得让人知道中途摔过
    if (report.warnings?.length) {
      lines.push(`过程中有 ${report.warnings.length} 次错误已自动恢复:`);
      for (const item of report.warnings.slice(0, 3)) {
        lines.push(`  - ${failureText(item)}`);
      }
    }
    if (settings.includePreview && report.previewText) {
      const body = report.previewText.length > perTurnLimit
        ? `${report.previewText.slice(0, perTurnLimit)}…`
        : report.previewText;
      lines.push(report.failed ? `失败前输出: ${body}` : `摘要: ${body}`);
    }
  });

  return { subject, text: lines.filter(Boolean).join('\n'), html: renderHtml(reports, summary, settings) };
}

function renderHtml(reports, summary, settings) {
  const failed = summary.failed;
  const aborted = summary.aborted;
  const accent = failed ? '#d4380d' : aborted ? '#ad6800' : '#1a1c20';
  const headline = headlineOf(summary);
  const batch = summary.count > 1;
  const title = failed
    ? (batch ? '这一批工作有失败' : '本轮工作失败')
    : aborted
      ? (batch ? '这一批工作被中断' : '本轮工作被中断')
      : settings.inProgress
        ? (batch ? '这一批还在跑' : '本轮还在跑')
        : (batch ? '这一批工作已结束' : '本轮工作已结束');
  const banner = failed
    ? `<div style="margin-top:16px;padding:12px 14px;background:#fff1f0;border-left:3px solid #d4380d;border-radius:6px">
<div style="font-size:13px;font-weight:600;color:#a8071a">失败原因：${escapeHtml(summary.primaryFailure?.hint ?? '未知错误')}</div>
${summary.primaryFailure?.message ? `<div style="margin-top:6px;font-size:12px;color:#5c0011;word-break:break-all;white-space:pre-wrap">${escapeHtml(oneLine(summary.primaryFailure.message, 600))}</div>` : ''}
${[summary.primaryFailure?.code, summary.primaryFailure?.status ? `HTTP ${summary.primaryFailure.status}` : ''].filter(Boolean).length
    ? `<div style="margin-top:6px;font-size:12px;color:#8f959e">${escapeHtml([summary.primaryFailure?.code, summary.primaryFailure?.status ? `HTTP ${summary.primaryFailure.status}` : ''].filter(Boolean).join(' / '))}</div>`
    : ''}
</div>`
    : aborted
      ? '<div style="margin-top:16px;padding:12px 14px;background:#fffbe6;border-left:3px solid #d4b106;border-radius:6px;font-size:13px;color:#613400">这一批工作被中断</div>'
      : '';

  const rows = [['目录', summary.cwd || '(unknown)'], ['会话', summary.sessionId], ['轮次', summary.turns.join(', ')]];
  if (summary.count > 1) rows.push(['批量', `${summary.count} 轮`]);
  rows.push(['开始', formatClock(summary.startedAt)]);
  // 进行中的进度通报没有"结束"，写了会和"还在跑"自相矛盾
  if (!settings.inProgress) rows.push(['结束', formatClock(summary.endedAt)]);
  rows.push([settings.inProgress ? '已进行' : '累计耗时', formatDuration(summary.totalDuration)]);
  rows.push(['工具', summary.toolCalls
    ? `${summary.toolCalls} 次${summary.toolFailures ? ` / ${summary.toolFailures} 失败` : ''}`
    : '未调用']);
  if (summary.usage) {
    rows.push(['Token', `${summary.usage.inputTokens.toLocaleString('en-US')} in / ${summary.usage.outputTokens.toLocaleString('en-US')} out`]);
  }

  const perTurnLimit = Math.max(160, Math.min(600, Math.floor((settings.previewChars || 1_200) / Math.max(1, summary.count))));
  const turnCards = summary.count > 1
    ? reports.map((report, index) => {
      const badge = report.failed ? '#d4380d' : report.aborted ? '#ad6800' : '#2ea121';
      const body = settings.includePreview && report.previewText
        ? `<div style="margin-top:6px;font-size:12px;line-height:1.6;color:#4e5969;white-space:pre-wrap">${escapeHtml(
          report.previewText.length > perTurnLimit ? `${report.previewText.slice(0, perTurnLimit)}…` : report.previewText,
        )}</div>`
        : '';
      const reason = report.failed
        ? `<div style="margin-top:4px;font-size:12px;color:#a8071a">${escapeHtml(report.primaryFailure?.hint ?? '未知错误')}</div>`
        : report.aborted
          ? `<div style="margin-top:4px;font-size:12px;color:#613400">${escapeHtml(report.abortReason)}</div>`
          : '';
      const warnLine = report.warnings?.length
        ? `<div style="margin-top:4px;font-size:12px;color:#ad6800">过程中有 ${report.warnings.length} 次错误已自动恢复：${escapeHtml(report.warnings[0].hint)}</div>`
        : '';
      const cardLive = Boolean(settings.inProgress) && index === reports.length - 1;
      const metaLine = `<div style="margin-top:4px;font-size:11px;color:#8f959e">${cardLive
        ? `${escapeHtml(formatClock(report.startedAt))} 起 · 已进行 ${escapeHtml(formatDuration(report.durationMs))}`
        : `${escapeHtml(formatClock(report.startedAt))} → ${escapeHtml(formatClock(report.endedAt))} · ${escapeHtml(formatDuration(report.durationMs))}`}${
        report.toolCalls ? ` · 工具 ${report.toolCalls} 次${report.toolFailures ? `（${report.toolFailures} 次失败）` : ''}` : ''
      }${report.lastStep !== undefined ? ` · 停在第 ${report.lastStep} 步` : ''}</div>`;
      return `<div style="padding:12px 14px;border:1px solid #e5e6eb;border-radius:8px;margin-bottom:10px">
<div style="font-size:13px;font-weight:600">[${index + 1}] ${escapeHtml(turnHeading(report, cardLive))}
<span style="display:inline-block;margin-left:8px;padding:1px 8px;border-radius:10px;background:${badge};color:#fff;font-size:11px;font-weight:500">${escapeHtml(turnStateText(report))}</span></div>
${metaLine}
${report.requestText ? `<div style="margin-top:6px;font-size:12px;color:#646a73">请求：${escapeHtml(oneLine(report.requestText, 300))}</div>` : ''}
${reason}${warnLine}${body}</div>`;
    }).join('')
    : '';

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f5f6f8;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;color:#1f2329">
<div style="max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e5e6eb;border-radius:12px;overflow:hidden">
<div style="padding:20px 24px;background:${accent};color:#ffffff">
<div style="font-size:13px;opacity:.7;letter-spacing:.08em">DEEPSEEK HARNESS</div>
<div style="font-size:20px;font-weight:600;margin-top:6px">${escapeHtml(title)}</div>
<div style="font-size:13px;opacity:.75;margin-top:4px">${escapeHtml(headline)} · ${
    summary.count > 1 ? `${summary.count} 轮 · ` : ''
  }${escapeHtml(formatDuration(summary.totalDuration))}</div>
${settings.inProgress ? `<div style="font-size:12px;opacity:.85;margin-top:4px">${batch ? '这一批' : '本轮'}还在继续，先报个进度</div>` : ''}
</div>
<div style="padding:20px 24px">
${banner}
<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:8px">
${rows.map(([label, value]) => `<tr><td style="padding:6px 0;color:#646a73;width:80px;vertical-align:top">${escapeHtml(label)}</td><td style="padding:6px 0;word-break:break-all">${escapeHtml(value)}</td></tr>`).join('\n')}
</table>
${turnCards ? `<div style="margin-top:18px">${turnCards}</div>` : ''}
${summary.count === 1 && settings.includePreview && reports[0]?.previewText
    ? `<div style="margin-top:18px"><div style="font-size:12px;color:#646a73;margin-bottom:6px">${failed ? '失败前的输出' : '回复摘要'}</div><div style="font-size:13px;line-height:1.6;white-space:pre-wrap">${escapeHtml(reports[0].previewText)}</div></div>`
    : ''}
</div>
<div style="padding:14px 24px;border-top:1px solid #f0f1f3;font-size:12px;color:#8f959e">由 dsh-qq-mail-notify 自动发送 · ${escapeHtml(new Date(summary.endedAt).toLocaleString('zh-CN'))}</div>
</div>
</body></html>`;

  return html;
}

/**
 * Renders one mail for one turn or for a whole batch.
 * @param {object|object[]} input a single report or the batch of reports
 * @param {object} settings resolved plugin settings
 */
export function buildNotification(input, settings) {
  const reports = (Array.isArray(input) ? input : [input]).filter(Boolean);
  if (reports.length === 0) throw new Error('buildNotification: no report to render');
  if (reports.length === 1) return renderSingle(reports[0], settings);
  return renderBatch(reports, summarizeReports(reports), settings);
}
