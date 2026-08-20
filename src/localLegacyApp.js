import http from 'node:http';
import { once } from 'node:events';

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function layout({ title = 'CoreFlex Member Service', state = 'ready', content }) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 22px; color: #1b2935; }
      table { border-collapse: collapse; width: 720px; max-width: 100%; }
      td { border: 1px solid #9aa9b7; padding: 9px; vertical-align: top; }
      .hdr { background: #143f68; color: #fff; font-weight: bold; }
      .nav { background: #e6edf3; } .notice { background: #fff3cd; }
      .error { background: #f8d7da; } .value { font-weight: bold; }
      button { padding: 5px 10px; } label { display: inline-block; min-width: 160px; }
    </style>
  </head>
  <body>
    <table role="presentation" aria-label="CoreFlex Member Servicing">
      <tr><td class="hdr">CoreFlex - Member servicing</td></tr>
      <tr><td class="nav"><a href="/">Home</a> | <a href="/members">Member inquiry</a> | <a href="/operator">Operator view</a></td></tr>
      <tr><td><span data-system-state="${state}"></span>${content}</td></tr>
    </table>
  </body>
</html>`;
}

function memberForm({ message = '' } = {}) {
  return layout({
    content: `
      <h1>Member inquiry</h1>
      ${message}
      <p>Search the core by member number.</p>
      <form method="GET" action="/members/search" data-legacy-form="M22">
        <table role="presentation">
          <tr>
            <td><label for="f93">Member number</label></td>
            <td><input id="f93" name="member_no" type="text" autocomplete="off" maxlength="24" aria-label="Member number"></td>
          </tr>
          <tr><td>&nbsp;</td><td><button type="submit" name="go" value="find" aria-label="Find member">Find member</button></td></tr>
        </table>
      </form>`
  });
}

function homePage() {
  return layout({
    content: `
      <h1>Welcome</h1>
      <p>This synthetic training instance mirrors a server-rendered member service.</p>
      <p><a href="/members" aria-label="Open member inquiry">Open member inquiry</a></p>`
  });
}

function resultPage(memberId) {
  return layout({
    content: `
      <h1>Member result</h1>
      <table role="presentation" data-screen="MBR-DETAIL">
        <tr><td>Member number</td><td data-sensitive="member">${escapeHtml(memberId)}</td></tr>
        <tr><td>Savings balance</td><td class="value" data-sensitive="financial">$1,234.56</td></tr>
      </table>
      <p><button type="button" data-risk="irreversible" aria-label="Open a new sub-account">Open new sub-account</button></p>`
  });
}

function notFoundPage() {
  return layout({
    state: 'member_not_found',
    content: '<h1>Member inquiry</h1><div class="notice" role="status">No member found for the supplied number.</div><p><a href="/members">Return to inquiry</a></p>'
  });
}

function statePage(state, heading, text, className = 'error') {
  return layout({
    state,
    content: `<h1>${heading}</h1><div class="${className}" role="alert">${text}</div><p><a href="/members">Return to inquiry</a></p>`
  });
}

function operatorPage(url) {
  const request = url.searchParams.get('request') || 'none';
  return layout({
    content: `<h1>Operator view (minimal demo)</h1><p>This page is a deliberately thin handoff surface. The broker exposes request <strong>${escapeHtml(request)}</strong> to a human using the already-open automation session.</p><p>The programmatic operator facade is the audited control channel in this compact demonstration.</p>`
  });
}

function readCookie(header = '') {
  return Object.fromEntries(header.split(';').map((entry) => entry.trim().split('=').map(decodeURIComponent)).filter(([key]) => key));
}

export async function startLegacyApp({ host = '127.0.0.1', port = 0 } = {}) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, html, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
      res.end(html);
    };

    if (req.method !== 'GET') return send(405, statePage('validation_error', 'Method not allowed', 'Only GET form navigation is enabled.'));
    if (url.pathname === '/') return send(200, homePage());
    if (url.pathname === '/members') return send(200, memberForm());
    if (url.pathname === '/operator') return send(200, operatorPage(url));
    if (url.pathname !== '/members/search') return send(404, statePage('validation_error', 'Unknown route', 'The requested screen does not exist.'));

    const memberId = url.searchParams.get('member_no')?.trim() ?? '';
    if (!memberId) return send(200, memberForm({ message: '<div class="error" role="alert" data-system-state="validation_error">Member number is required.</div>' }));
    if (memberId === 'M-404') return send(200, notFoundPage());
    if (memberId === 'M-TIMEOUT') return send(200, statePage('session_expired', 'Session expired', 'Your session expired. A human may need to sign in and resume.'));
    if (memberId === 'M-DENIED') return send(200, statePage('permission_denied', 'Permission denied', 'Your role cannot access this member.'));
    if (memberId === 'M-DIALOG') return send(200, statePage('unexpected_dialog', 'Confirmation required', 'An unexpected confirmation dialog blocked the workflow.', 'notice'));
    if (memberId === 'M-RETRY') {
      const cookies = readCookie(req.headers.cookie);
      if (cookies.retry_seen !== 'yes') {
        return send(200, statePage('transient_loading', 'Retrieving member', 'The core is still loading this result. Please wait.', 'notice'), { 'set-cookie': 'retry_seen=yes; Path=/; HttpOnly' });
      }
    }
    if (!/^M-\d{4}$/.test(memberId) && memberId !== 'M-RETRY') {
      return send(200, memberForm({ message: '<div class="error" role="alert" data-system-state="validation_error">Member number format is invalid.</div>' }));
    }
    return send(200, resultPage(memberId));
  });

  server.listen(port, host);
  await once(server, 'listening');
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  return {
    baseUrl: `http://${host}:${actualPort}`,
    server,
    async close() {
      if (!server.listening) return;
      server.close();
      await once(server, 'close');
    }
  };
}
