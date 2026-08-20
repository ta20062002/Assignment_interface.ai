import { randomUUID } from 'node:crypto';
import { AutomationError, assert, redactText } from './core.js';

function decodeHtml(value = '') {
  return value
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'");
}

function textContent(html = '') {
  return decodeHtml(html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

function attributes(source = '') {
  const result = {};
  const matcher = /([:\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of source.matchAll(matcher)) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function logicalKey({ name, label, text, href, risk }) {
  if (name === 'member_no' || /member number/i.test(label)) return 'member_number';
  if (/find member/i.test(text)) return 'find_member';
  if (/sub-account/i.test(text) || risk === 'irreversible') return 'open_sub_account';
  if (/member inquiry/i.test(text) || href === '/members') return 'member_inquiry';
  return (name || label || text || href || 'unknown').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function parseControls(html) {
  const labels = new Map();
  for (const match of html.matchAll(/<label\b([^>]*)>([\s\S]*?)<\/label>/gi)) {
    const attrs = attributes(match[1]);
    if (attrs.for) labels.set(attrs.for, textContent(match[2]));
  }

  const controls = [];
  for (const formMatch of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const formAttrs = attributes(formMatch[1]);
    const formAction = formAttrs.action || '/';
    const formMethod = (formAttrs.method || 'GET').toUpperCase();
    const formHtml = formMatch[2];
    for (const inputMatch of formHtml.matchAll(/<input\b([^>]*)>/gi)) {
      const attrs = attributes(inputMatch[1]);
      const label = labels.get(attrs.id) || attrs['aria-label'] || attrs.name || '';
      controls.push({
        key: logicalKey({ name: attrs.name, label }),
        role: attrs.type === 'hidden' ? 'hidden' : 'textbox',
        name: label,
        controlName: attrs.name,
        id: attrs.id,
        formAction,
        formMethod,
        risk: attrs['data-risk'] || 'safe',
        kind: 'input'
      });
    }
    for (const buttonMatch of formHtml.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
      const attrs = attributes(buttonMatch[1]);
      const name = attrs['aria-label'] || textContent(buttonMatch[2]);
      controls.push({
        key: logicalKey({ name: attrs.name, text: name, risk: attrs['data-risk'] }),
        role: 'button',
        name,
        controlName: attrs.name,
        id: attrs.id,
        formAction,
        formMethod,
        risk: attrs['data-risk'] || 'safe',
        kind: 'button'
      });
    }
  }
  for (const buttonMatch of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const attrs = attributes(buttonMatch[1]);
    const name = attrs['aria-label'] || textContent(buttonMatch[2]);
    const key = logicalKey({ name: attrs.name, text: name, risk: attrs['data-risk'] });
    if (!controls.some((control) => control.key === key && control.name === name)) {
      controls.push({
        key,
        role: 'button',
        name,
        controlName: attrs.name,
        id: attrs.id,
        formAction: null,
        formMethod: null,
        risk: attrs['data-risk'] || 'safe',
        kind: 'button'
      });
    }
  }
  for (const anchorMatch of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = attributes(anchorMatch[1]);
    const name = attrs['aria-label'] || textContent(anchorMatch[2]);
    controls.push({
      key: logicalKey({ text: name, href: attrs.href }),
      role: 'link',
      name,
      href: attrs.href,
      risk: 'safe',
      kind: 'link'
    });
  }
  return controls;
}

function parseTitle(html) {
  const found = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return found ? textContent(found[1]) : '';
}

function parseState(html) {
  const matches = [...html.matchAll(/data-system-state\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]);
  return matches.find((state) => state !== 'ready') || matches[0] || 'ready';
}

function cookieEntries(setCookie) {
  if (!setCookie) return [];
  const list = Array.isArray(setCookie) ? setCookie : [setCookie];
  return list.map((cookie) => cookie.split(';')[0]).filter(Boolean).map((entry) => {
    const divider = entry.indexOf('=');
    return [entry.slice(0, divider), entry.slice(divider + 1)];
  });
}

function locatorFor(control) {
  const candidates = [
    { strategy: 'accessibility', role: control.role, name: control.name }
  ];
  if (control.controlName || control.formAction) {
    candidates.push({ strategy: 'legacy_form_control', formAction: control.formAction, controlName: control.controlName, role: control.role });
  }
  if (control.name) candidates.push({ strategy: 'visible_text', text: control.name, role: control.role });
  return { logicalName: control.key, candidates };
}

function matchingControl(controls, candidate) {
  if (candidate.strategy === 'accessibility') {
    return controls.filter((control) => control.role === candidate.role && control.name === candidate.name);
  }
  if (candidate.strategy === 'legacy_form_control') {
    return controls.filter((control) => control.role === candidate.role && control.controlName === candidate.controlName && control.formAction === candidate.formAction);
  }
  if (candidate.strategy === 'visible_text') {
    return controls.filter((control) => control.role === candidate.role && control.name === candidate.text);
  }
  return [];
}

export class HttpLegacySurface {
  constructor(baseUrl) {
    this.baseUrl = baseUrl;
    this.origin = new URL(baseUrl).origin;
    this.currentUrl = null;
    this.html = '';
    this.controls = [];
    this.values = new Map();
    this.cookies = new Map();
    this.sessionId = `http-${randomUUID()}`;
    this.actionLog = [];
  }

  static async open(baseUrl) {
    const surface = new HttpLegacySurface(baseUrl);
    await surface.navigate('/');
    return surface;
  }

  _cookieHeader() {
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  async _request(url, { actor = 'automation', followRedirects = 0 } = {}) {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: this.cookies.size ? { cookie: this._cookieHeader() } : {}
    });
    const getSetCookie = response.headers.getSetCookie?.bind(response.headers);
    const setCookies = getSetCookie ? getSetCookie() : response.headers.get('set-cookie');
    for (const [key, value] of cookieEntries(setCookies)) this.cookies.set(key, value);
    if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
      assert(followRedirects < 5, 'TOO_MANY_REDIRECTS', 'Too many redirects on legacy surface.');
      return this._request(new URL(response.headers.get('location'), url).href, { actor, followRedirects: followRedirects + 1 });
    }
    this.currentUrl = response.url || url;
    this.html = await response.text();
    this.controls = parseControls(this.html);
    this.actionLog.push({ actor, action: 'navigate', url: this.currentUrl, status: response.status });
    return this.observe();
  }

  async navigate(routeOrUrl, { actor = 'automation' } = {}) {
    const destination = new URL(routeOrUrl, this.baseUrl).href;
    return this._request(destination, { actor });
  }

  async observe() {
    return {
      surface: 'legacy-http',
      sessionId: this.sessionId,
      url: this.currentUrl,
      title: parseTitle(this.html),
      state: parseState(this.html),
      text: textContent(this.html),
      controls: this.controls.map((control) => ({
        key: control.key,
        role: control.role,
        name: control.name,
        risk: control.risk,
        filled: this.values.has(control.key)
      }))
    };
  }

  resolveTarget(target) {
    const direct = this.controls.filter((control) => control.key === target.logicalName);
    if (direct.length === 1) return direct[0];
    for (const candidate of target.candidates ?? []) {
      const matches = matchingControl(this.controls, candidate);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) throw new AutomationError('AMBIGUOUS_TARGET', `Locator ${candidate.strategy} matched ${matches.length} controls.`, { target, candidate });
    }
    throw new AutomationError('TARGET_NOT_FOUND', `Could not resolve target ${target.logicalName}.`, { target, currentControls: this.controls });
  }

  getControlSpec(logicalName) {
    const control = this.controls.filter((item) => item.key === logicalName);
    assert(control.length === 1, 'TARGET_NOT_FOUND', `Could not record target ${logicalName}.`, { controls: this.controls });
    return locatorFor(control[0]);
  }

  getControlRisk(logicalName) {
    const control = this.controls.find((item) => item.key === logicalName);
    return control?.risk ?? 'safe';
  }

  getControlValue(logicalName) {
    return this.values.get(logicalName);
  }

  async type(target, value, { actor = 'automation' } = {}) {
    const control = typeof target === 'string' ? this.resolveTarget(this.getControlSpec(target)) : this.resolveTarget(target);
    assert(control.kind === 'input', 'INVALID_SURFACE_ACTION', `Target ${control.key} is not an input.`);
    this.values.set(control.key, String(value));
    this.actionLog.push({ actor, action: 'type', target: control.key, value: '[IN_MEMORY_ONLY]' });
    return this.observe();
  }

  async click(target, { actor = 'automation' } = {}) {
    const control = typeof target === 'string' ? this.resolveTarget(this.getControlSpec(target)) : this.resolveTarget(target);
    assert(control.kind === 'button' || control.kind === 'link', 'INVALID_SURFACE_ACTION', `Target ${control.key} is not clickable.`);
    this.actionLog.push({ actor, action: 'click', target: control.key });
    if (control.kind === 'link') return this.navigate(control.href, { actor });
    if (control.formAction) {
      const params = new URLSearchParams();
      for (const input of this.controls.filter((item) => item.kind === 'input' && item.formAction === control.formAction)) {
        params.set(input.controlName, this.values.get(input.key) ?? '');
      }
      return this.navigate(`${control.formAction}?${params.toString()}`, { actor });
    }
    throw new AutomationError('UNSUPPORTED_CLICK', `No safe action is defined for ${control.key}.`, { control });
  }

  async wait(delayMs = 20, { actor = 'automation' } = {}) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    this.actionLog.push({ actor, action: 'wait', delayMs });
    if (this.currentCondition() === 'transient_loading') return this.navigate(this.currentUrl, { actor });
    return this.observe();
  }

  currentCondition() {
    return parseState(this.html);
  }

  async captureEvidence() {
    return {
      kind: 'html_snapshot',
      contentType: 'text/html',
      content: this.html,
      currentUrl: this.currentUrl,
      state: this.currentCondition()
    };
  }

  async humanPerform(action) {
    if (action.type === 'navigate') return this.navigate(action.path, { actor: 'human' });
    if (action.type === 'type') return this.type(action.target, action.value, { actor: 'human' });
    if (action.type === 'click') return this.click(action.target, { actor: 'human' });
    if (action.type === 'wait') return this.wait(action.delayMs, { actor: 'human' });
    throw new AutomationError('UNSUPPORTED_HUMAN_ACTION', `Human action ${action.type} is unsupported.`);
  }

  async close() {}
}

export class PlaywrightSurface {
  static async launch(baseUrl, { headless = true } = {}) {
    let playwright;
    try {
      playwright = await import('playwright');
    } catch {
      throw new AutomationError('PLAYWRIGHT_NOT_INSTALLED', 'Install the optional playwright dependency and Chromium before using --surface=browser.');
    }
    const browser = await playwright.chromium.launch({ headless });
    const context = await browser.newContext();
    const page = await context.newPage();
    const surface = new PlaywrightSurface(baseUrl, { browser, context, page });
    await surface.navigate('/');
    return surface;
  }

  constructor(baseUrl, { browser, context, page }) {
    this.baseUrl = baseUrl;
    this.origin = new URL(baseUrl).origin;
    this.browser = browser;
    this.context = context;
    this.page = page;
    this.sessionId = `browser-${randomUUID()}`;
    this.controls = [];
    this.actionLog = [];
  }

  async _readControls() {
    this.controls = await this.page.locator('input, button, a').evaluateAll((nodes) => nodes.map((node) => {
      const label = node.getAttribute('aria-label') || (node.id ? document.querySelector(`label[for="${node.id}"]`)?.textContent?.trim() : '') || node.textContent?.trim() || node.getAttribute('name') || '';
      const role = node.tagName === 'A' ? 'link' : node.tagName === 'BUTTON' ? 'button' : 'textbox';
      const risk = node.getAttribute('data-risk') || 'safe';
      const name = node.getAttribute('name') || '';
      const key = name === 'member_no' || /member number/i.test(label)
        ? 'member_number'
        : /find member/i.test(label)
          ? 'find_member'
          : /sub-account/i.test(label) || risk === 'irreversible'
            ? 'open_sub_account'
            : /member inquiry/i.test(label) ? 'member_inquiry' : (name || label).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const form = node.closest('form');
      return { key, role, name: label, controlName: name, formAction: form?.getAttribute('action') || null, risk, kind: node.tagName.toLowerCase() };
    }));
  }

  async navigate(routeOrUrl, { actor = 'automation' } = {}) {
    const url = new URL(routeOrUrl, this.baseUrl).href;
    await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    await this._readControls();
    this.actionLog.push({ actor, action: 'navigate', url: this.page.url() });
    return this.observe();
  }

  async observe() {
    await this._readControls();
    const state = await this.page.locator('[data-system-state]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-system-state')).find((value) => value && value !== 'ready') || 'ready');
    return {
      surface: 'playwright',
      sessionId: this.sessionId,
      url: this.page.url(),
      title: await this.page.title(),
      state,
      text: await this.page.locator('body').innerText(),
      controls: this.controls.map(({ key, role, name, risk }) => ({ key, role, name, risk }))
    };
  }

  resolveTarget(target) {
    const direct = this.controls.filter((control) => control.key === target.logicalName);
    if (direct.length === 1) return direct[0];
    for (const candidate of target.candidates ?? []) {
      const found = matchingControl(this.controls, candidate);
      if (found.length === 1) return found[0];
      if (found.length > 1) throw new AutomationError('AMBIGUOUS_TARGET', `Locator ${candidate.strategy} was ambiguous.`, { target, candidate });
    }
    throw new AutomationError('TARGET_NOT_FOUND', `Could not resolve target ${target.logicalName}.`, { target });
  }

  getControlSpec(logicalName) {
    const control = this.controls.filter((item) => item.key === logicalName);
    assert(control.length === 1, 'TARGET_NOT_FOUND', `Could not record target ${logicalName}.`);
    return locatorFor(control[0]);
  }

  getControlRisk(logicalName) {
    return this.controls.find((control) => control.key === logicalName)?.risk ?? 'safe';
  }

  getControlValue() { return undefined; }

  _locator(control) {
    if (control.kind === 'input') return this.page.locator(`input[name="${control.controlName}"]`);
    if (control.kind === 'button') return this.page.getByRole('button', { name: control.name });
    return this.page.getByRole('link', { name: control.name });
  }

  async type(target, value, { actor = 'automation' } = {}) {
    const control = typeof target === 'string' ? this.resolveTarget(this.getControlSpec(target)) : this.resolveTarget(target);
    await this._locator(control).fill(String(value));
    this.actionLog.push({ actor, action: 'type', target: control.key, value: '[IN_MEMORY_ONLY]' });
    return this.observe();
  }

  async click(target, { actor = 'automation' } = {}) {
    const control = typeof target === 'string' ? this.resolveTarget(this.getControlSpec(target)) : this.resolveTarget(target);
    await Promise.all([this.page.waitForLoadState('domcontentloaded').catch(() => {}), this._locator(control).click()]);
    await this._readControls();
    this.actionLog.push({ actor, action: 'click', target: control.key });
    return this.observe();
  }

  async wait(delayMs = 20, { actor = 'automation' } = {}) {
    await this.page.waitForTimeout(delayMs);
    if ((await this.observe()).state === 'transient_loading') await this.page.reload({ waitUntil: 'domcontentloaded' });
    await this._readControls();
    this.actionLog.push({ actor, action: 'wait', delayMs });
    return this.observe();
  }

  currentCondition() { return 'ready'; }

  async captureEvidence() {
    const observation = await this.observe();
    return { kind: 'html_snapshot', contentType: 'text/html', content: await this.page.content(), currentUrl: observation.url, state: observation.state };
  }

  async humanPerform(action) {
    if (action.type === 'navigate') return this.navigate(action.path, { actor: 'human' });
    if (action.type === 'type') return this.type(action.target, action.value, { actor: 'human' });
    if (action.type === 'click') return this.click(action.target, { actor: 'human' });
    if (action.type === 'wait') return this.wait(action.delayMs, { actor: 'human' });
    throw new AutomationError('UNSUPPORTED_HUMAN_ACTION', `Human action ${action.type} is unsupported.`);
  }

  async close() {
    await this.context.close();
    await this.browser.close();
  }
}

export function redactedSnapshot(snapshot) {
  return redactText(snapshot.content)
    .replace(/data-sensitive="[^"]*">[^<]*/gi, (match) => match.replace(/>[^<]*$/, '>[REDACTED]'));
}
