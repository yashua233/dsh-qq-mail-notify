// Diagnostic: connects to QQ Mail's SMTP endpoints and prints the advertised
// capabilities (no credentials, no message). Use it when a notification never
// arrives and the guesswork would otherwise be about the relay.
//
//   node scripts/probe-smtp.mjs [host]
import tls from 'node:tls';
import net from 'node:net';

const host = process.argv[2] || 'smtp.qq.com';

function readReply(socket, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const collected = [];
    const timer = setTimeout(() => reject(new Error('reply timeout')), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        collected.push(line);
        if (/^\d{3}( |$)/.test(line)) {
          clearTimeout(timer);
          socket.removeListener('data', onData);
          resolve({ code: Number(line.slice(0, 3)), lines: collected.slice() });
          return;
        }
      }
    };
    socket.on('data', onData);
  });
}

async function probe({ port, secure }) {
  const label = `${host}:${port} ${secure ? 'implicit TLS' : 'STARTTLS'}`;
  let socket;
  try {
    socket = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('connect timeout')), 10_000);
      const created = secure
        ? tls.connect({ host, port, servername: host }, () => {
          clearTimeout(timer);
          resolve(created);
        })
        : net.connect({ host, port }, () => {
          clearTimeout(timer);
          resolve(created);
        });
      created.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    const greeting = await readReply(socket);
    socket.write('EHLO dsh-qq-mail-notify\r\n');
    const ehlo = await readReply(socket);
    const lines = ehlo.lines.join(' | ');
    console.log(`[ok]   ${label}`);
    console.log(`       greeting ${greeting.code}; EHLO ${ehlo.code}: ${lines}`);
    const authLine = ehlo.lines.find((line) => /\bAUTH\b/i.test(line));
    console.log(`       mechanisms: ${authLine ? authLine.replace(/^250[- ]/i, '').trim() : '(not advertised)'}`);
    if (!secure) {
      const canUpgrade = ehlo.lines.some((line) => /STARTTLS/i.test(line));
      console.log(`       STARTTLS advertised: ${canUpgrade}`);
      if (canUpgrade) {
        socket.write('STARTTLS\r\n');
        const started = await readReply(socket);
        console.log(`       STARTTLS reply: ${started.code}`);
        const upgraded = await new Promise((resolve, reject) => {
          socket.removeAllListeners('data');
          const next = tls.connect({ socket, servername: host }, () => resolve(next));
          next.once('error', reject);
        });
        upgraded.write('EHLO dsh-qq-mail-notify\r\n');
        const again = await readReply(upgraded);
        console.log(`       post-TLS EHLO ${again.code}`);
        upgraded.destroy();
      }
    }
    socket.destroy();
    return true;
  } catch (error) {
    console.log(`[fail] ${label}: ${error?.message ?? error}`);
    try {
      socket?.destroy();
    } catch {
      /* ignore */
    }
    return false;
  }
}

const results = [
  await probe({ port: 465, secure: true }),
  await probe({ port: 587, secure: false }),
];
process.exit(results.some(Boolean) ? 0 : 1);
