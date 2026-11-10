// Feedback form of Ansible Flow Designer: a plain ES module, no build. It reads the URL
// parameters the extension passes, shows the in-use or the uninstall form, and posts the answer
// as JSON to the Worker once Cloudflare Turnstile is solved.

import {
  ISSUES_URL,
  RATE_URL_OPENVSX,
  RATE_URL_VSCODE,
  TURNSTILE_SITE_KEY,
  WORKER_URL,
} from './config.js';

const TURNSTILE_API = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const TURNSTILE_ONLOAD = 'afdFeedbackTurnstileReady';
const SEND_TIMEOUT_MS = 20000;
const TEXT_MAX = 4000;
const TEXT_WARN = 3800;

const SOURCES = ['prompt', 'command', 'uninstall'];
const EDITOR_NAMES = {
  vscode: 'VS Code',
  cursor: 'Cursor',
  kiro: 'Kiro',
  antigravity: 'Antigravity',
  windsurf: 'Windsurf',
  vscodium: 'VSCodium',
  other: '',
};
const VERSION_RE = /^[0-9][0-9A-Za-z.+-]{0,19}$/;
// The Worker's check (feedback/worker/src/answer.ts), stricter than type="email": no quotes,
// brackets or backticks, and a dot in the domain. maxlength="200" in index.html matches it too.
const EMAIL_RE = /^[^\s@<>()[\]"'`\\,;:]+@[^\s@<>()[\]"'`\\,;:]+\.[^\s@<>()[\]"'`\\,;:]+$/;
const RATING_WORDS = ['', 'Poor', 'Fair', 'Good', 'Very good', 'Excellent'];

/** The URL parameters, cut down to known values: they reach the Worker, so nothing free-form. */
function readParams(search) {
  const params = new URLSearchParams(search);
  const source = params.get('source');
  const version = params.get('version') ?? '';
  const editor = params.get('editor');
  return {
    source: SOURCES.includes(source) ? source : 'command',
    version: VERSION_RE.test(version) ? version : '',
    editor: editor !== null && Object.hasOwn(EDITOR_NAMES, editor) ? editor : 'other',
  };
}

const ctx = readParams(window.location.search);
const isUninstall = ctx.source === 'uninstall';

const $ = (id) => document.getElementById(id);
const form = $('form');
const text = $('text');
const email = $('email');
const send = $('send');
const sendHint = $('send-hint');
const status = $('status');
const failure = $('failure');
const stars = [...document.querySelectorAll('#stars .star')];

let token = '';
let widgetId = null;
let sending = false;
let hoverRating = 0;

function checkedValue(name) {
  return form.querySelector(`input[name="${name}"]:checked`)?.value ?? '';
}

function checkedValues(name) {
  return [...form.querySelectorAll(`input[name="${name}"]:checked`)].map((input) => input.value);
}

function hasAnswer() {
  if (text.value.trim() !== '') return true;
  if (isUninstall) return checkedValue('reason') !== '';
  return checkedValue('rating') !== '' || checkedValues('uses').length > 0;
}

function setStatus(message, kind = 'info') {
  status.textContent = message;
  status.dataset.kind = kind;
}

/** Enables Send once the captcha is solved and something is answered; says what is missing. */
function update() {
  const answered = hasAnswer();
  send.disabled = sending || !token || !answered;
  sendHint.hidden = sending || !send.disabled;
  if (!answered) {
    sendHint.textContent = token
      ? 'Answer at least one question to send.'
      : 'Answer at least one question and finish the spam check to send.';
  } else {
    sendHint.textContent = 'Finish the spam check to send.';
  }
  for (const button of form.querySelectorAll('[data-clear]')) {
    button.hidden = checkedValue(button.dataset.clear) === '';
  }
}

function paintStars() {
  const shown = hoverRating || Number(checkedValue('rating') || 0);
  stars.forEach((star, index) => {
    star.classList.toggle('on', index < shown);
  });
  $('rating-word').textContent = RATING_WORDS[shown] ?? '';
}

function updateCounter() {
  const counter = $('text-count');
  counter.textContent = `${text.value.length} / ${TEXT_MAX} characters`;
  counter.classList.toggle('near-limit', text.value.length >= TEXT_WARN);
}

function describeContext() {
  const editorName = EDITOR_NAMES[ctx.editor];
  let line = 'Ansible Flow Designer';
  if (ctx.version) line += ` ${ctx.version}`;
  if (editorName) line += ` in ${editorName}`;
  return line;
}

function labelOf(input) {
  return input.closest('label')?.textContent.trim() ?? input.value;
}

function buildPayload() {
  const payload = { source: ctx.source, version: ctx.version, editor: ctx.editor };
  if (isUninstall) {
    const reason = checkedValue('reason');
    if (reason) payload.reason = reason;
  } else {
    const rating = checkedValue('rating');
    if (rating) payload.rating = Number(rating);
    const uses = checkedValues('uses');
    if (uses.length > 0) payload.uses = uses;
  }
  const answer = text.value.trim();
  if (answer) payload.text = answer;
  const address = email.value.trim();
  if (address) payload.email = address;
  payload.turnstile = token;
  return payload;
}

/** The answer as plain text for a GitHub issue; the email stays out, since issues are public. */
function answerAsText() {
  const lines = [describeContext()];
  if (isUninstall) {
    const reason = form.querySelector('input[name="reason"]:checked');
    if (reason) lines.push(`Reason: ${labelOf(reason)}`);
  } else {
    const rating = checkedValue('rating');
    if (rating) lines.push(`Rating: ${rating} of 5`);
    const uses = [...form.querySelectorAll('input[name="uses"]:checked')].map(labelOf);
    if (uses.length > 0) lines.push(`Uses: ${uses.join(', ')}`);
  }
  const answer = text.value.trim();
  if (answer) lines.push('', answer);
  return lines.join('\n');
}

function resetCaptcha() {
  token = '';
  if (widgetId !== null && window.turnstile) window.turnstile.reset(widgetId);
}

function showFailure() {
  $('copy-text').value = answerAsText();
  $('copy-text').hidden = true;
  $('copy-note').textContent = '';
  failure.hidden = false;
}

function showDone() {
  form.hidden = true;
  const done = $('done');
  if (!isUninstall) {
    const onVsCode = ctx.editor === 'vscode';
    const link = $('rate-link');
    link.href = onVsCode ? RATE_URL_VSCODE : RATE_URL_OPENVSX;
    link.textContent = onVsCode
      ? 'Rate it on the Visual Studio Marketplace'
      : 'Rate it on Open VSX';
    $('rate').hidden = false;
  }
  done.hidden = false;
  done.focus();
}

async function postAnswer(payload) {
  try {
    const response = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    const body = await response.json().catch(() => null);
    if (response.ok && body?.ok === true) return 'ok';
    if (body?.error === 'captcha') return 'captcha';
    if (body?.error === 'invalid email') return 'email';
    return 'failed';
  } catch {
    return 'failed';
  }
}

function showEmailError() {
  email.setAttribute('aria-invalid', 'true');
  $('email-error').hidden = false;
  email.focus();
}

async function onSubmit(event) {
  event.preventDefault();
  if (send.disabled) return;
  const address = email.value.trim();
  email.value = address;
  if (address && !(email.checkValidity() && EMAIL_RE.test(address))) {
    showEmailError();
    return;
  }
  sending = true;
  send.textContent = 'Sending...';
  failure.hidden = true;
  setStatus('Sending your answer...');
  update();

  const outcome = await postAnswer(buildPayload());

  sending = false;
  send.textContent = 'Send';
  if (outcome === 'ok') {
    setStatus('');
    showDone();
    return;
  }
  // A token is single-use: whatever the Worker did with it, the next try needs a new one.
  resetCaptcha();
  if (outcome === 'captcha') {
    setStatus(
      'The spam check was not accepted. Please complete it again, then press Send.',
      'captcha',
    );
  } else if (outcome === 'email') {
    setStatus('');
    showEmailError();
  } else {
    setStatus('Your answer could not be sent.', 'error');
    showFailure();
  }
  update();
}

async function copyAnswer() {
  const area = $('copy-text');
  const note = $('copy-note');
  area.value = answerAsText();
  try {
    await navigator.clipboard.writeText(area.value);
    note.textContent = 'Copied.';
  } catch {
    // No clipboard access (an old browser, or a denied permission): select the text instead.
    area.hidden = false;
    area.focus();
    area.select();
    note.textContent = 'Press Ctrl+C (Cmd+C on a Mac) to copy the selected text.';
  }
}

function captchaProblem(message) {
  token = '';
  const note = $('captcha-note');
  note.textContent = message;
  note.classList.add('error');
  update();
}

function captchaOk() {
  const note = $('captcha-note');
  note.textContent = 'Spam check by Cloudflare Turnstile.';
  note.classList.remove('error');
  if (status.dataset.kind === 'captcha') {
    setStatus('Spam check passed. Press Send to try again.');
  }
}

function renderTurnstile() {
  widgetId = window.turnstile.render($('turnstile'), {
    sitekey: TURNSTILE_SITE_KEY,
    theme: 'auto',
    // Fills the column, at least 300 px wide: form.css keeps 300 px free on a 320 px phone.
    size: 'flexible',
    'response-field': false,
    callback: (value) => {
      token = value;
      captchaOk();
      update();
    },
    'expired-callback': () => {
      token = '';
      update();
    },
    'timeout-callback': () => {
      token = '';
      update();
    },
    'error-callback': () => {
      captchaProblem(
        'The spam check did not load. Reload the page, or use GitHub issues (link below).',
      );
      return true;
    },
  });
}

function loadTurnstile() {
  window[TURNSTILE_ONLOAD] = renderTurnstile;
  const script = document.createElement('script');
  script.src = `${TURNSTILE_API}?render=explicit&onload=${TURNSTILE_ONLOAD}`;
  script.async = true;
  script.onerror = () =>
    captchaProblem(
      'The spam check could not load (blocked or offline). You can still use GitHub issues (link below).',
    );
  document.head.append(script);
}

function warnAboutPlaceholders() {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname);
  if (local) return;
  if (TURNSTILE_SITE_KEY.startsWith('1x00000000')) {
    console.warn('feedback: config.js still has the Turnstile test site key');
  }
  if (WORKER_URL.includes('.example.')) {
    console.warn('feedback: config.js still has the placeholder WORKER_URL');
  }
}

function setUp() {
  $('product').textContent = describeContext();
  $('issues-link').href = ISSUES_URL;
  $('failure-issues').href = ISSUES_URL;
  if (isUninstall) {
    $('heading').textContent = 'Sorry to see you go. What happened?';
    $('text-label').textContent = 'What would bring you back?';
    $('in-use').hidden = true;
    $('uninstall').hidden = false;
  }

  form.addEventListener('input', update);
  form.addEventListener('change', () => {
    paintStars();
    update();
  });
  form.addEventListener('submit', onSubmit);
  text.addEventListener('input', updateCounter);
  email.addEventListener('input', () => {
    email.removeAttribute('aria-invalid');
    $('email-error').hidden = true;
  });
  $('copy').addEventListener('click', copyAnswer);

  stars.forEach((star, index) => {
    star.addEventListener('pointerenter', (event) => {
      if (event.pointerType !== 'mouse') return;
      hoverRating = index + 1;
      paintStars();
    });
    star.addEventListener('pointerleave', () => {
      hoverRating = 0;
      paintStars();
    });
  });

  for (const button of form.querySelectorAll('[data-clear]')) {
    button.addEventListener('click', () => {
      const inputs = form.querySelectorAll(`input[name="${button.dataset.clear}"]`);
      for (const input of inputs) input.checked = false;
      paintStars();
      update();
      inputs[0]?.focus();
    });
  }

  form.hidden = false;
  update();
  warnAboutPlaceholders();
  loadTurnstile();
}

setUp();
