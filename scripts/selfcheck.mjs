// Offline self-check: runs the real SMTP client against a local fake server,
// then verifies the report/notification/settings layers. No network, no real
// authorization code.
//
//   node scripts/selfcheck.mjs
import net from 'node:net';
import assert from 'node:assert/strict';
import { sendMail, __testing } from '../lib/smtp.js';
import {
  buildNotification, classifyFailure, collectReport, formatDuration, summarizeReports,
} from '../lib/report.js';
import { resolveSettings, maskSecret } from '../lib/settings.js';

const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}

function withTimeout(promise, milliseconds, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout: ${label}`)), milliseconds)),
  ]);
}

function startFakeSmtp() {
  return new Promise((resolve) => {
    const received = { commands: [], auth: {}, mailFrom: null, rcpt: [], message: null };
    let resolveQueued;
    const queued = new Promise((done) => {
      resolveQueued = done;
    });
    const server = net.createServer((socket) => {
      socket.setEncoding('utf8');
      socket.write('220 fake-smtp.local ESMTP ready\r\n');
      let buffer = '';
      let mode = 'command';
      let authStage = 0;
      let dataLines = [];
      socket.on('data', (chunk) => {
        buffer += chunk;
        for (;;) {
          const index = buffer.indexOf('\r\n');
          if (index < 0) break;
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          if (mode === 'data') {
            if (line === '.') {
              mode = 'command';
              received.message = dataLines.join('\r\n');
              dataLines = [];
              socket.write('250 2.0.0 Ok: queued as FAKE1\r\n');
              resolveQueued(received);
            } else {
              dataLines.push(line);
            }
            continue;
          }
          received.commands.push(line);
          if (/^EHLO/i.test(line)) {
            socket.write('250-fake-smtp.local\r\n250-AUTH LOGIN PLAIN\r\n250 8BITMIME\r\n');
            continue;
          }
          if (/^AUTH LOGIN/i.test(line)) {
            authStage = 1;
            socket.write('334 VXNlcm5hbWU6\r\n');
            continue;
          }
          if (authStage === 1) {
            received.auth.user = Buffer.from(line, 'base64').toString('utf8');
            authStage = 2;
            socket.write('334 UGFzc3dvcmQ6\r\n');
            continue;
          }
          if (authStage === 2) {
            received.auth.pass = Buffer.from(line, 'base64').toString('utf8');
            authStage = 0;
            socket.write('235 2.7.0 Authentication successful\r\n');
            continue;
          }
          if (/^MAIL FROM:/i.test(line)) {
            received.mailFrom = line;
            socket.write('250 2.1.0 Ok\r\n');
            continue;
          }
          if (/^RCPT TO:/i.test(line)) {
            received.rcpt.push(line);
            socket.write('250 2.1.5 Ok\r\n');
            continue;
          }
          if (/^DATA$/i.test(line)) {
            mode = 'data';
            socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
            continue;
          }
          if (/^QUIT/i.test(line)) {
            socket.write('221 2.0.0 Bye\r\n');
            socket.end();
            continue;
          }
          socket.write('500 5.5.1 Unrecognised command\r\n');
        }
      });
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, received, queued });
    });
  });
}

function decodeSubject(message) {
  const match = /^Subject: (.*(?:\r\n[ \t].*)*)$/m.exec(message);
  if (!match) return '';
  return match[1]
    .replace(/\r\n[ \t]/g, '')
    .replace(/=\?UTF-8\?B\?([^?]*)\?=/gi, (_, payload) => Buffer.from(payload, 'base64').toString('utf8'));
}

function decodeParts(message) {
  const boundaryMatch = /boundary="([^"]+)"/.exec(message);
  if (!boundaryMatch) return [];
  return message
    .split(`--${boundaryMatch[1]}`)
    .map((chunk) => {
      const split = chunk.indexOf('\r\n\r\n');
      if (split < 0) return null;
      const head = chunk.slice(0, split);
      if (!/Content-Transfer-Encoding: base64/i.test(head)) return null;
      const body = chunk.slice(split + 4).replace(/\r\n/g, '');
      if (!body) return null;
      return Buffer.from(body, 'base64').toString('utf8');
    })
    .filter(Boolean);
}

const sampleEvents = [
  { type: 'turn/start', seq: 1, time: 1_700_000_000_000, data: { turn: 3 } },
  {
    type: 'user/message',
    seq: 2,
    time: 1_700_000_001_000,
    data: { role: 'user', content: [{ type: 'text', text: '写一个工作结束qq邮箱通知的插件' }] },
  },
  {
    type: 'assistant/message',
    seq: 3,
    time: 1_700_000_300_000,
    data: {
      turn: 3,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '插件已经装好并验证通过。' }] },
      usage: { inputTokens: 12_345, outputTokens: 2_345 },
    },
  },
  { type: 'tool/call', seq: 4, time: 1_700_000_310_000, data: { turn: 3, step: 2, callId: 'c1', name: 'write', arguments: '{}' } },
  { type: 'tool/result', seq: 5, time: 1_700_000_320_000, data: { turn: 3, step: 2, message: { role: 'tool', isError: false } } },
  { type: 'tool/call', seq: 6, time: 1_700_000_330_000, data: { turn: 3, step: 2, callId: 'c2', name: 'pwsh', arguments: '{}' } },
  { type: 'tool/result', seq: 7, time: 1_700_000_340_000, data: { turn: 3, step: 2, message: { role: 'tool', isError: true }, error: { name: 'PwshError', code: 'EXIT_1' } } },
  { type: 'turn/end', seq: 8, time: 1_700_000_754_000, data: { turn: 3, reason: { kind: 'completed' } } },
];

const fakeSession = {
  id: 'session-abc',
  header: { id: 'session-abc', cwd: '/work', agentPreset: 'default' },
  ownEvents: () => sampleEvents,
};

const failedEvents = [
  { type: 'turn/start', seq: 1, time: 1_700_000_000_000, data: { turn: 1 } },
  {
    type: 'user/message',
    seq: 2,
    time: 1_700_000_001_000,
    data: { role: 'user', content: [{ type: 'text', text: '把整本书重译一遍' }] },
  },
  { type: 'tool/call', seq: 3, time: 1_700_000_030_000, data: { turn: 1, step: 2, callId: 'c9', name: 'write', arguments: '{}' } },
  { type: 'tool/result', seq: 4, time: 1_700_000_031_000, data: { turn: 1, step: 2, message: { role: 'tool', isError: false } } },
  { type: 'step/end', seq: 5, time: 1_700_000_060_000, data: { turn: 1, step: 3 } },
  {
    type: 'turn/end',
    seq: 6,
    time: 1_700_000_062_000,
    data: {
      turn: 1,
      reason: {
        kind: 'error',
        error: { message: 'insufficient_quota: 余额不足', code: 'insufficient_quota', status: 402 },
      },
    },
  },
];

const failedSession = {
  id: 'session-fail',
  header: { id: 'session-fail', cwd: '/work' },
  ownEvents: () => failedEvents,
};

const abortedEvents = [
  { type: 'turn/start', seq: 1, time: 1_700_000_000_000, data: { turn: 2 } },
  { type: 'user/message', seq: 2, time: 1_700_000_001_000, data: { role: 'user', content: [{ type: 'text', text: '跑个长任务' }] } },
  {
    type: 'turn/end',
    seq: 3,
    time: 1_700_000_040_000,
    data: { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } },
  },
];

const abortedSession = {
  id: 'session-abort',
  header: { id: 'session-abort', cwd: '/work' },
  ownEvents: () => abortedEvents,
};

const secondEvents = [
  { type: 'turn/start', seq: 1, time: 1_700_002_000_000, data: { turn: 4 } },
  {
    type: 'user/message',
    seq: 2,
    time: 1_700_002_001_000,
    data: { role: 'user', content: [{ type: 'text', text: '顺便把索引也更新了' }] },
  },
  {
    type: 'assistant/message',
    seq: 3,
    time: 1_700_002_200_000,
    data: {
      turn: 4,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '索引已更新。' }] },
      usage: { inputTokens: 100, outputTokens: 50 },
    },
  },
  { type: 'turn/end', seq: 4, time: 1_700_002_240_000, data: { turn: 4, reason: { kind: 'completed' } } },
];

const secondSession = {
  id: 'session-abc',
  header: { id: 'session-abc', cwd: '/work' },
  ownEvents: () => secondEvents,
};

const noEndSession = {
  id: 'session-noend',
  header: { id: 'session-noend', cwd: '/work' },
  ownEvents: () => [
    { type: 'turn/start', seq: 1, time: 1_700_000_000_000, data: { turn: 7 } },
    {
      type: 'user/message',
      seq: 2,
      time: 1_700_000_001_000,
      data: { role: 'user', content: [{ type: 'text', text: '开始跑' }] },
    },
  ],
};

check('SMTP：EHLO / AUTH LOGIN / MAIL / RCPT / DATA 走完整流程', async () => {
  const { server, port, received, queued } = await startFakeSmtp();
  try {
    await sendMail({
      host: '127.0.0.1',
      port,
      secure: false,
      requireTls: false,
      user: '123456@qq.com',
      authCode: 'sampleauthcode00',
      to: 'target@qq.com',
      fromName: 'DSH 通知',
      subject: '[DSH] 工作结束 · 测试',
      text: '纯文本正文 中文',
      html: '<p>HTML 正文 中文</p>',
      timeoutMs: 5_000,
    });
    await withTimeout(queued, 5_000, 'fake smtp queued');
    assert.equal(received.auth.user, '123456@qq.com');
    assert.equal(received.auth.pass, 'sampleauthcode00');
    assert.match(received.mailFrom, /<123456@qq\.com>/);
    assert.match(received.rcpt[0], /<target@qq\.com>/);
    assert.equal(decodeSubject(received.message), '[DSH] 工作结束 · 测试');
    const parts = decodeParts(received.message);
    assert.equal(parts.length, 2, 'expected text + html parts');
    assert.ok(parts[0].includes('纯文本正文 中文'), 'plain part must keep Chinese');
    assert.ok(parts[1].includes('HTML 正文 中文'), 'html part must keep Chinese');
  } finally {
    server.close();
  }
});

check('SMTP：多个收件人拆成多条 RCPT TO', async () => {
  const { server, port, received, queued } = await startFakeSmtp();
  try {
    await sendMail({
      host: '127.0.0.1',
      port,
      secure: false,
      requireTls: false,
      user: 'sender@qq.com',
      authCode: 'x'.repeat(16),
      to: 'a@qq.com, b@qq.com',
      subject: 'multi',
      text: 'body',
      html: '<p>body</p>',
      timeoutMs: 5_000,
    });
    await withTimeout(queued, 5_000, 'fake smtp queued');
    assert.equal(received.rcpt.length, 2);
    assert.match(received.rcpt[1], /<b@qq\.com>/);
  } finally {
    server.close();
  }
});

check('SMTP：认证被拒时报错而不是静默成功', async () => {
  const server = net.createServer((socket) => {
    socket.setEncoding('utf8');
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      for (const line of chunk.split('\r\n').filter(Boolean)) {
        if (/^EHLO/i.test(line)) socket.write('250-fake\r\n250 AUTH LOGIN\r\n');
        else if (/^AUTH LOGIN/i.test(line)) socket.write('334 VXNlcm5hbWU6\r\n');
        else if (/^\S+$/.test(line)) socket.write('535 5.7.8 Authentication failed\r\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  try {
    await assert.rejects(
      () => sendMail({
        host: '127.0.0.1',
        port: server.address().port,
        secure: false,
        requireTls: false,
        user: 'sender@qq.com',
        authCode: 'wrong',
        subject: 'x',
        text: 'x',
        html: '<p>x</p>',
        timeoutMs: 5_000,
      }),
      /authentication/i,
    );
  } finally {
    server.close();
  }
});

check('摘要：从会话事件推导耗时 / 工具 / Token / 请求', () => {
  const report = collectReport(fakeSession, 3, { endedAt: 1_700_000_800_000 });
  assert.equal(report.requestText, '写一个工作结束qq邮箱通知的插件');
  assert.equal(report.toolCalls, 2);
  assert.equal(report.toolFailures, 1);
  assert.equal(report.reason, 'completed');
  assert.equal(report.usage.inputTokens, 12_345);
  assert.equal(report.usage.outputTokens, 2_345);
  assert.equal(report.durationMs, 800_000);
  assert.deepEqual(report.toolNames.map((item) => item.name).sort(), ['pwsh', 'write']);
  assert.ok(report.previewText.includes('插件已经装好'));
  assert.equal(formatDuration(report.durationMs), '13 分 20 秒');
});

check('摘要：turn 省略时取最后一次 turn', () => {
  const report = collectReport(fakeSession, undefined, { endedAt: 1_700_000_800_000 });
  assert.equal(report.turn, 3);
});

check('通知：主题与正文包含关键事实并正确转义', () => {
  const report = collectReport(fakeSession, 3, { endedAt: 1_700_000_800_000 });
  const { subject, text, html } = buildNotification(report, {
    subjectPrefix: '[DSH]',
    includePreview: true,
    previewChars: 1_200,
    webUrl: 'http://127.0.0.1:10346',
  });
  assert.equal(subject, '[DSH] 工作结束 · work · 13 分 20 秒');
  assert.ok(text.includes('目录: /work'));
  assert.ok(text.includes('工具: 2 次调用 (1 次失败)'));
  assert.ok(text.includes('> 写一个工作结束qq邮箱通知的插件'));
  // 邮件里不再带链接：令牌随进程失效，点了打不开，留着只会误导
  assert.ok(!text.includes('打开:'));
  assert.ok(!html.includes('127.0.0.1:10346'));
  assert.ok(!html.includes('打开会话'));
  // 正文改成写清楚：绝对时间、状态、可选来源
  assert.ok(/^开始: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/m.test(text));
  assert.ok(/^结束: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/m.test(text));
  assert.ok(text.includes('状态:'));
  assert.ok(html.includes('本轮工作已结束'));
});

check('进行中渲染：不写结束时间，标题与状态都是进行中', () => {
  const report = collectReport(fakeSession, 3, { endedAt: 1_700_000_800_000 });
  const base = { subjectPrefix: '[DSH]', includePreview: true, previewChars: 1_200 };
  const live = buildNotification(report, { ...base, inProgress: true });
  assert.ok(live.subject.includes('工作继续'));
  assert.ok(!live.subject.includes('工作结束'));
  assert.ok(live.text.includes('状态: 进行中'));
  assert.ok(!/^结束: /m.test(live.text));
  assert.ok(live.html.includes('本轮还在跑'));
  assert.ok(!live.html.includes('本轮工作已结束'));
  assert.ok(!live.html.includes('>结束<'));
  assert.ok(live.html.includes('已进行'));
  // 收尾版本必须保持原样：主题是结束、HTML 有结束行
  const done = buildNotification(report, { ...base, inProgress: false });
  assert.ok(done.subject.includes('工作结束'));
  assert.ok(done.html.includes('本轮工作已结束'));
  assert.ok(done.html.includes('>结束<'));
});

check('配置：patch > 文件 > 环境变量 > 默认值', () => {
  const { settings, sources } = resolveSettings({
    config: { user: 'patch@qq.com', smtpPort: '587', secure: 'false' },
    stored: { user: 'file@qq.com', authCode: 'code-from-file' },
    env: { DSH_QQ_MAIL_TO: 'env@qq.com', DSH_QQ_MAIL_AUTH_CODE: 'env-code' },
  });
  assert.equal(settings.user, 'patch@qq.com');
  assert.equal(sources.user, 'config');
  assert.equal(settings.authCode, 'code-from-file');
  assert.equal(sources.authCode, 'file');
  assert.equal(settings.to, 'env@qq.com');
  assert.equal(sources.to, 'env');
  assert.equal(settings.smtpPort, 587);
  assert.equal(typeof settings.smtpPort, 'number');
  assert.equal(settings.secure, false);
  assert.equal(settings.smtpHost, 'smtp.qq.com');
  assert.equal(sources.smtpHost, 'default');
});

check('服务商预设：QQ 仍是默认，其他域名只在主机没指定时才替换', () => {
  // 主路径：QQ 自己的域名推断回 QQ，与默认值相同，零配置行为不变
  const qq = resolveSettings({ config: { user: 'someone@qq.com' }, env: {} });
  assert.equal(qq.settings.smtpHost, 'smtp.qq.com');
  assert.equal(qq.sources.smtpHost, 'default');
  assert.equal(resolveSettings({ config: { user: 'someone@foxmail.com' }, env: {} }).settings.smtpHost, 'smtp.qq.com');
  assert.equal(resolveSettings({ config: { user: 'someone@vip.qq.com' }, env: {} }).settings.smtpHost, 'smtp.qq.com');

  // 别家地址：主机还是默认值时换成那家的端点，并标明来源
  const net163 = resolveSettings({ config: { user: 'someone@163.com' }, env: {} });
  assert.equal(net163.settings.smtpHost, 'smtp.163.com');
  assert.equal(net163.settings.smtpPort, 465);
  assert.equal(net163.sources.smtpHost, 'preset:163');
  assert.equal(resolveSettings({ config: { user: 'a@gmail.com' }, env: {} }).settings.smtpHost, 'smtp.gmail.com');

  // Outlook 的 SMTP 是 587 + STARTTLS，端口和 secure 要跟着预设一起走
  const outlook = resolveSettings({ config: { user: 'a@outlook.com' }, env: {} }).settings;
  assert.equal(outlook.smtpHost, 'smtp.office365.com');
  assert.equal(outlook.smtpPort, 587);
  assert.equal(outlook.secure, false);

  // 显式指定过主机就不许被推断覆盖
  const explicit = resolveSettings({
    config: { user: 'someone@163.com', smtpHost: 'mail.example.com', smtpPort: 2525 },
    env: {},
  }).settings;
  assert.equal(explicit.smtpHost, 'mail.example.com');
  assert.equal(explicit.smtpPort, 2525);

  // 认不出的域名不猜，保持 QQ 默认
  assert.equal(resolveSettings({ config: { user: 'someone@corp.example' }, env: {} }).settings.smtpHost, 'smtp.qq.com');
});

check('配置：to 缺省回落到 user，授权码脱敏', () => {
  const { settings } = resolveSettings({ config: { user: 'me@qq.com' }, env: {} });
  assert.equal(settings.to, 'me@qq.com');
  assert.equal(maskSecret('sampleauthcode00'), 'samp***00');
  assert.equal(maskSecret(''), '');
});

check('报文：没有 HTML 时发单部分纯文本，不抛错也不带 undefined', () => {
  // 审批邮件只给纯文本。以前这里无条件走 multipart，html 为空会让报文里出现
  // "undefined" 或者直接抛错——审批链路就是在这静默断掉的。
  const raw = __testing.buildMessage({
    user: 'a@qq.com',
    fromName: 'DSH',
    recipients: ['b@qq.com'],
    subject: '纯文本测试',
    text: 'hello',
    html: undefined,
  });
  assert.ok(raw.includes('Content-Type: text/plain'), '应当声明 text/plain');
  assert.ok(!raw.includes('multipart'), '没有 html 就不该声明 multipart');
  assert.ok(!raw.includes('undefined'), '正文里不该出现 undefined');

  // 有 html 时仍然走 multipart 两部分
  const withHtml = __testing.buildMessage({
    user: 'a@qq.com',
    fromName: 'DSH',
    recipients: ['b@qq.com'],
    subject: '带 HTML',
    text: 'hello',
    html: '<p>hello</p>',
  });
  assert.ok(withHtml.includes('multipart/alternative'), '有 html 时要走 multipart');
});

check('报文：头字段不因裸换行被注入额外头', () => {
  // 邮件头注入的经典形态：某个字段里塞 \r\n，后面就能伪造任意头（Bcc、Reply-To…）
  const raw = __testing.buildMessage({
    user: 'a@qq.com\r\nBcc: evil@example.com',
    fromName: 'DSH\r\nBcc: evil@example.com',
    recipients: ['b@qq.com\r\nBcc: evil@example.com'],
    subject: '主题\r\nBcc: evil@example.com',
    text: 'hello',
  });
  const headerBlock = raw.split('\r\n\r\n')[0];
  assert.ok(!/^Bcc:/imu.test(headerBlock), `头区不该出现注入的 Bcc：\n${headerBlock}`);
  assert.equal(headerBlock.split('\r\n').filter((line) => /^Bcc:/iu.test(line)).length, 0);
});

check('失败分类：额度 / 鉴权 / 限流 / 权限 / 网络 / 服务端', () => {
  assert.equal(
    classifyFailure({ code: 'insufficient_quota', message: 'insufficient_quota', status: 402 }).hint,
    '额度或余额不足',
  );
  assert.equal(classifyFailure({ message: '余额不足，请充值' }).hint, '额度或余额不足');
  assert.equal(
    classifyFailure({ message: 'Unauthorized', code: 'invalid_api_key', status: 401 }).hint,
    '鉴权失败（登录过期或密钥无效）',
  );
  assert.equal(classifyFailure({ message: 'Forbidden', status: 403 }).hint, '没有权限（403）');
  assert.equal(classifyFailure({ message: 'Too Many Requests', status: 429 }).hint, '请求被限流（429）');
  assert.equal(
    classifyFailure(new Error('fetch failed', { cause: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) })).hint,
    '网络连接失败',
  );
  assert.equal(classifyFailure({ message: 'internal server error', status: 503 }).hint, '服务端错误');
  assert.equal(classifyFailure({ message: 'boom' }).hint, 'boom');
  assert.equal(classifyFailure(undefined).hint, '未知错误');
});

check('失败摘要：turn/end reason=error 被识别并保留错误码', () => {
  const report = collectReport(failedSession, 1, { endedAt: 1_700_000_062_000 });
  assert.equal(report.failed, true);
  assert.equal(report.endKind, 'error');
  assert.equal(report.primaryFailure.hint, '额度或余额不足');
  assert.equal(report.primaryFailure.code, 'insufficient_quota');
  assert.equal(report.primaryFailure.status, '402');
  assert.equal(report.lastStep, 3);
  assert.equal(report.lastToolName, 'write');
  assert.equal(report.durationMs, 62_000);
});

check('失败摘要：turn 正常收尾时中途错误只算告警', () => {
  const report = collectReport(fakeSession, 3, {
    endedAt: 1_700_000_800_000,
    errorInfo: { message: 'invalid_api_key', status: 401 },
  });
  assert.equal(report.failed, false);
  assert.equal(report.endKind, 'completed');
  assert.equal(report.warnings.length, 1);
  assert.equal(report.warnings[0].hint, '鉴权失败（登录过期或密钥无效）');
});

check('失败摘要：没有收尾事件的错误算失败', () => {
  const report = collectReport(noEndSession, 7, {
    endedAt: 1_700_000_030_000,
    errorInfo: { message: 'internal server error', status: 500 },
  });
  assert.equal(report.failed, true);
  assert.equal(report.primaryFailure.hint, '服务端错误');
});

check('失败通知：主题点明原因，正文与 HTML 都突出失败块', () => {
  const report = collectReport(failedSession, 1, { endedAt: 1_700_000_062_000 });
  const { subject, text, html } = buildNotification(report, {
    subjectPrefix: '[DSH]', includePreview: true, previewChars: 1_200,
  });
  assert.equal(subject, '[DSH] 工作失败 · work · 额度或余额不足');
  assert.ok(text.startsWith('本轮工作失败。'));
  assert.ok(text.includes('原因: 额度或余额不足'));
  assert.ok(text.includes('错误码: insufficient_quota / HTTP 402'));
  assert.ok(text.includes('步骤: 停在第 3 步'));
  assert.ok(text.includes('最后动作: write'));
  assert.ok(html.includes('失败原因'));
  assert.ok(html.includes('#d4380d'));
  assert.ok(html.includes('本轮工作失败'));
});

check('中断摘要：区分中断原因，不当作失败', () => {
  const report = collectReport(abortedSession, 2, { endedAt: 1_700_000_040_000 });
  assert.equal(report.aborted, true);
  assert.equal(report.failed, false);
  assert.equal(report.abortReason, '你中断了本轮');
  const { subject, text } = buildNotification(report, {
    subjectPrefix: '[DSH]', includePreview: true, previewChars: 1_200,
  });
  assert.ok(subject.includes('工作中断'));
  assert.ok(text.includes('原因: 你中断了本轮'));
});

check('批量：多轮合并成一封，主题给轮数与累计耗时', () => {
  const first = collectReport(fakeSession, 3, { endedAt: 1_700_000_800_000 });
  const second = collectReport(secondSession, 4, { endedAt: 1_700_002_240_000 });
  const summary = summarizeReports([first, second]);
  assert.equal(summary.count, 2);
  assert.equal(summary.totalDuration, 1_040_000);
  assert.deepEqual(summary.turns, [3, 4]);
  assert.equal(formatDuration(summary.totalDuration), '17 分 20 秒');

  const { subject, text, html } = buildNotification([first, second], {
    subjectPrefix: '[DSH]', includePreview: true, previewChars: 1_200,
  });
  assert.equal(subject, '[DSH] 工作结束 · work · 2 轮 · 17 分 20 秒');
  assert.ok(text.includes('这一批工作已结束（2 轮，累计 17 分 20 秒）'));
  assert.ok(text.includes('轮次: 3, 4'));
  assert.ok(text.includes('[1] 第 3 轮'));
  assert.ok(text.includes('[2] 第 4 轮'));
  assert.ok(html.includes('这一批工作已结束'));
  assert.ok(html.includes('2 轮'));
});

check('批量：有失败轮时主题点名失败与原因', () => {
  const ok = collectReport(fakeSession, 3, { endedAt: 1_700_000_800_000 });
  const bad = collectReport(failedSession, 1, { endedAt: 1_700_000_062_000 });
  const summary = summarizeReports([ok, bad]);
  assert.equal(summary.failed, true);
  assert.equal(summary.failedCount, 1);
  const { subject, text } = buildNotification([ok, bad], {
    subjectPrefix: '[DSH]', includePreview: true, previewChars: 1_200,
  });
  assert.ok(subject.startsWith('[DSH] 工作失败 · work · 1 轮失败'));
  assert.ok(subject.includes('额度或余额不足'));
  assert.ok(text.includes('这段时间有 1 轮失败（共 2 轮）'));
  assert.ok(text.includes('第 1 轮: 额度或余额不足'));
});

check('会话覆盖：session 压过 config 与文件', () => {
  const { settings, sources } = resolveSettings({
    config: { user: 'patch@qq.com', idleDelayMs: 30_000 },
    stored: { idleDelayMs: 60_000 },
    env: {},
    session: { idleDelayMs: 180_000, enabled: false },
  });
  assert.equal(settings.idleDelayMs, 180_000);
  assert.equal(sources.idleDelayMs, 'session');
  assert.equal(settings.enabled, false);
  assert.equal(sources.enabled, 'session');
  assert.equal(settings.user, 'patch@qq.com');
  assert.equal(sources.user, 'config');
});

check('默认值：完成即发送（idleDelayMs=0 / minTurnMs=0）', () => {
  const base = resolveSettings({ config: {}, stored: {}, env: {}, session: {} });
  assert.equal(base.settings.idleDelayMs, 0);
  assert.equal(base.sources.idleDelayMs, 'default');
  assert.equal(base.settings.minTurnMs, 0);
  assert.equal(base.sources.minTurnMs, 'default');
  // 0 必须被当成"显式设置"，不能被合并逻辑当空值丢掉
  const explicit = resolveSettings({ config: { idleDelayMs: 0 }, stored: {}, env: {}, session: {} });
  assert.equal(explicit.settings.idleDelayMs, 0);
  assert.equal(explicit.sources.idleDelayMs, 'config');
  // 攒批仍然可以显式打开
  const batched = resolveSettings({ config: {}, stored: { idleDelayMs: 600_000 }, env: {}, session: {} });
  assert.equal(batched.settings.idleDelayMs, 600_000);
  assert.equal(batched.sources.idleDelayMs, 'file');
});

check('进度通报：默认 40 分钟一次，0 表示关闭', () => {
  const base = resolveSettings({ config: {}, stored: {}, env: {}, session: {} });
  assert.equal(base.settings.progressEveryMs, 2_400_000);
  assert.equal(base.sources.progressEveryMs, 'default');
  const off = resolveSettings({ config: { progressEveryMs: 0 }, stored: {}, env: {}, session: {} });
  assert.equal(off.settings.progressEveryMs, 0);
  assert.equal(off.sources.progressEveryMs, 'config');
});

let failed = 0;
for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${error?.message ?? error}`);
  }
}
console.log(failed === 0 ? `\n全部通过（${checks.length} 项）` : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
