// Minimal SMTP client: implicit TLS (465) and STARTTLS (587), AUTH LOGIN.
// Deliberately dependency-free so the plugin loads inside the Harness Host
// process without touching the asar or the profile's node_modules.
import net from 'node:net';
import tls from 'node:tls';

const CRLF = '\r\n';

export class SmtpError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'SmtpError';
    this.details = details;
  }
}

/** QQ Mail and most relays accept AUTH LOGIN; PLAIN remains a fallback. */
async function authenticate(session, user, authCode) {
  const login = await session.command('AUTH LOGIN', (r) => r.code === 334 || r.code === 235 || r.code === 504);
  if (login.code === 235) return;
  if (login.code === 334) {
    const userReply = await session.command(
      Buffer.from(user, 'utf8').toString('base64'),
      (r) => r.code === 334 || r.code === 535,
    );
    if (userReply.code !== 334) {
      throw new SmtpError(`SMTP authentication rejected the account: ${userReply.lines.join(' ')}`, userReply);
    }
    const reply = await session.command(
      Buffer.from(authCode, 'utf8').toString('base64'),
      (r) => r.code === 235 || r.code === 535,
    );
    if (reply.code !== 235) {
      throw new SmtpError(`SMTP authentication failed: ${reply.lines.join(' ')}`, reply);
    }
    return;
  }
  const plain = Buffer.from(`\u0000${user}\u0000${authCode}`, 'utf8').toString('base64');
  const reply = await session.command(`AUTH PLAIN ${plain}`, (r) => r.code === 235 || r.code === 535);
  if (reply.code !== 235) {
    throw new SmtpError(`SMTP authentication failed: ${reply.lines.join(' ')}`, reply);
  }
}

/** Reads one complete (possibly multi-line) SMTP reply from a socket. */
function readReply(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const collected = [];
    const timer = setTimeout(() => {
      cleanup();
      reject(new SmtpError(`SMTP reply timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        collected.push(line);
        // "250-foo" continues, "250 foo" terminates the reply.
        if (/^\d{3}( |$)/.test(line)) {
          cleanup();
          resolve({ code: Number(line.slice(0, 3)), lines: collected.slice() });
          return;
        }
      }
    };
    const onError = (error) => {
      cleanup();
      reject(error instanceof SmtpError ? error : new SmtpError(`SMTP socket error: ${error.message}`));
    };
    const onClose = () => {
      cleanup();
      reject(new SmtpError('SMTP connection closed by server'));
    };
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    }
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

class Session {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.capabilities = [];
  }

  write(line) {
    this.socket.write(`${line}${CRLF}`);
  }

  async command(line, expectation) {
    this.write(line);
    const reply = await readReply(this.socket, this.timeoutMs);
    if (expectation !== undefined && !expectation(reply)) {
      throw new SmtpError(
        `Unexpected SMTP reply to ${line.split(' ')[0]} (${reply.code}): ${reply.lines.join(' ')}`,
        reply,
      );
    }
    return reply;
  }

  async greet() {
    const greeting = await readReply(this.socket, this.timeoutMs);
    if (greeting.code !== 220) {
      throw new SmtpError(`SMTP greeting rejected (${greeting.code}): ${greeting.lines.join(' ')}`, greeting);
    }
    const ehlo = await this.command('EHLO dsh-qq-mail-notify');
    this.capabilities = ehlo.lines.map((line) => line.slice(4).trim().toUpperCase());
  }

  advertisesStartTls() {
    return this.capabilities.some((line) => line.startsWith('STARTTLS'));
  }

  async upgrade() {
    const reply = await this.command('STARTTLS', (r) => r.code === 220);
    if (reply.code !== 220) throw new SmtpError('STARTTLS rejected', reply);
    const socket = this.socket;
    socket.removeAllListeners('data');
    this.socket = await new Promise((resolve, reject) => {
      const secured = tls.connect(
        { socket, servername: this.host, rejectUnauthorized: this.rejectUnauthorized !== false },
        () => resolve(secured),
      );
      secured.once('error', reject);
    });
    const ehlo = await this.command('EHLO dsh-qq-mail-notify');
    this.capabilities = ehlo.lines.map((line) => line.slice(4).trim().toUpperCase());
  }
}

function dotStuff(text) {
  // RFC 5321 transparency: a line starting with "." is sent doubled.
  return text.replace(/\r?\n/g, CRLF).replace(/^\./gm, '..');
}

/**
 * Sends one multipart/alternative message.
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {boolean} options.secure implicit TLS on connect (465) vs STARTTLS (587)
 * @param {string} options.user envelope sender / auth user
 * @param {string} options.authCode SMTP password (QQ Mail authorization code)
 * @param {string} options.to
 * @param {string} [options.fromName]
 * @param {string} options.subject
 * @param {string} options.text
 * @param {string} options.html
 * @param {number} [options.timeoutMs]
 * @param {(line: string) => void} [options.trace]
 */
export async function sendMail(options) {
  const {
    host = 'smtp.qq.com',
    port = 465,
    secure = true,
    user,
    authCode,
    to,
    fromName = 'DeepSeek Harness',
    subject,
    text,
    html,
    timeoutMs = 25_000,
    requireTls = true,
    trace,
  } = options;

  if (!user) throw new SmtpError('missing SMTP user (sender address)');
  if (!authCode) throw new SmtpError('missing SMTP authorization code');
  const recipients = String(to || user)
    .split(/[,;]/)
    .map((item) => item.trim())
    .filter(Boolean);

  const raw =
    secure
      ? await new Promise((resolve, reject) => {
          const socket = tls.connect(
            { host, port, servername: host, rejectUnauthorized: true },
            () => resolve(socket),
          );
          socket.once('error', reject);
          socket.setTimeout(timeoutMs, () => reject(new SmtpError('SMTP connect timeout')));
        })
      : await new Promise((resolve, reject) => {
          const socket = net.connect({ host, port }, () => resolve(socket));
          socket.once('error', reject);
          socket.setTimeout(timeoutMs, () => reject(new SmtpError('SMTP connect timeout')));
        });

  const session = new Session(raw, timeoutMs);
  session.host = host;
  const log = (line) => trace?.(line);

  try {
    raw.setNoDelay?.(true);
    await session.greet();
    if (!secure) {
      if (session.advertisesStartTls()) {
        await session.upgrade();
      } else if (requireTls) {
        throw new SmtpError(
          'Server does not advertise STARTTLS; refusing to send the authorization code in clear text. '
          + 'Use port 465 with secure=true, or pass requireTls=false for a trusted local relay.',
        );
      }
    }
    log('connected');

    await authenticate(session, user, authCode);
    log('authenticated');

    await session.command(`MAIL FROM:<${user}>`, (r) => r.code === 250);
    for (const recipient of recipients) {
      await session.command(`RCPT TO:<${recipient}>`, (r) => r.code === 250 || r.code === 251);
    }
    await session.command('DATA', (r) => r.code === 354);

    const payload = dotStuff(buildMessage({ user, fromName, recipients, subject, text, html }));
    session.write(`${payload.endsWith(CRLF) ? payload : payload + CRLF}.${CRLF}`);
    const accepted = await readReply(session.socket, timeoutMs);
    if (accepted.code !== 250) {
      throw new SmtpError(`Message rejected (${accepted.code}): ${accepted.lines.join(' ')}`, accepted);
    }
    log('accepted');
    try {
      session.write('QUIT');
    } catch {
      /* the server may already have closed the socket */
    }
    return { accepted: accepted.lines.join(' '), recipients };
  } finally {
    try {
      raw.destroy();
    } catch {
      /* ignore */
    }
  }
}

function rfc5322Date(date = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (value) => String(value).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  return `${days[date.getDay()]}, ${pad(date.getDate())} ${months[date.getMonth()]} ${date.getFullYear()} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} `
    + `${sign}${pad(Math.floor(absolute / 60))}${pad(absolute % 60)}`;
}

function encodeWord(value) {
  // Encoded-word chunks must stay under 75 chars; split on code points.
  // 另加长度上限：头行硬限制 998 字符，超了整封会被服务器拒，而主题里塞着工具名。
  let text = String(value).replace(/[\r\n]+/g, ' ');
  if (text.length > 160) text = `${text.slice(0, 160)}…`;
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const chunks = [];
  let current = '';
  for (const char of text) {
    if (Buffer.byteLength(current + char, 'utf8') > 45) {
      chunks.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((chunk) => `=?UTF-8?B?${Buffer.from(chunk, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function encodeBody(value) {
  const base64 = Buffer.from(String(value), 'utf8').toString('base64');
  return base64.replace(/.{76}/g, '$&\r\n').replace(/\r\n$/, '');
}

/** 头字段里绝不能出现裸换行：一个 \r\n 就能把后面变成额外的邮件头（头注入）。 */
function headerSafe(value) {
  return String(value ?? '').replace(/[\r\n]+/gu, ' ').trim();
}

function quoteAddress(name, address) {
  const safeName = headerSafe(name).replace(/["\\]/gu, '');
  const safeAddress = headerSafe(address).replace(/[<>\s]/gu, '');
  return safeName ? `"${encodeWord(safeName)}" <${safeAddress}>` : `<${safeAddress}>`;
}

function buildMessage({ user, fromName, recipients, subject, text, html }) {
  const messageId = `<${Date.now().toString(36)}.${Math.random().toString(36).slice(2, 12)}@qq-mail-notify>`;
  const baseHeaders = [
    `From: ${quoteAddress(fromName, user)}`,
    `To: ${recipients.map((item) => headerSafe(item)).join(', ')}`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${rfc5322Date()}`,
    `Message-ID: ${messageId}`,
    'MIME-Version: 1.0',
  ];

  // 只有纯文本时发单部分邮件。以前这里无条件走 multipart，html 为空就会让
  // Buffer.from(undefined) 抛 TypeError——审批邮件正是这么一直发不出去的。
  if (!html) {
    return [
      ...baseHeaders,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      encodeBody(text),
    ].join('\r\n');
  }

  const boundary = `dsh-qq-mail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const headers = [...baseHeaders, `Content-Type: multipart/alternative; boundary="${boundary}"`];
  const parts = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    encodeBody(html),
    `--${boundary}--`,
    '',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${parts.join('\r\n')}`;
}

export const __testing = { buildMessage, rfc5322Date, encodeWord, dotStuff };
