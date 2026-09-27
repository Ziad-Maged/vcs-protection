/**
 * The studio page: one HTML document with inlined CSS and JS (the CLI is a single bundled file,
 * so there are no asset files; it also has to work offline). Both are tagged with a per-response
 * nonce for the Content-Security-Policy. All repository data (branch names, commit subjects, …)
 * is inserted as DOM text nodes, never as HTML.
 */

const CSS = String.raw`
:root {
  --bg: #f7f7f5; --panel: #ffffff; --text: #1d1d1f; --muted: #6b6b70; --border: #e2e2e0;
  --accent: #2f5bd3; --accent-text: #ffffff; --ok: #1f7a3f; --bad: #b3261e; --warn: #9a6200;
  --ok-bg: #e7f4ec; --bad-bg: #fbeaea; --warn-bg: #fdf3e0; --code: #f0f0ee;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151517; --panel: #1e1e21; --text: #ececef; --muted: #a0a0a8; --border: #33333a;
    --accent: #7c9cff; --accent-text: #0e0e10; --ok: #6fcf97; --bad: #ff8a80; --warn: #f5c26b;
    --ok-bg: #1d3326; --bad-bg: #3a1f1f; --warn-bg: #3a2e17; --code: #26262b;
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
body { margin: 0; font: 14px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--bg); color: var(--text); }
header { display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 12px 20px; border-bottom: 1px solid var(--border); background: var(--panel); }
header h1 { font-size: 16px; margin: 0 8px 0 0; }
.layout { display: grid; grid-template-columns: 200px 1fr; min-height: calc(100vh - 53px); }
nav { border-right: 1px solid var(--border); padding: 12px 8px; background: var(--panel); }
nav button { display: block; width: 100%; text-align: left; border: 0; background: none; color: var(--text); padding: 8px 12px; border-radius: 6px; font: inherit; cursor: pointer; }
nav button:hover { background: var(--code); }
nav button.active { background: var(--accent); color: var(--accent-text); }
main { padding: 20px; max-width: 1100px; width: 100%; }
h2 { font-size: 18px; margin: 0 0 12px; }
h3 { font-size: 15px; margin: 0 0 8px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; margin-bottom: 16px; }
.stat { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.stat .label { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.stat .value { font-size: 20px; font-weight: 600; margin-top: 2px; }
.muted { color: var(--muted); }
.chip { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; border: 1px solid var(--border); background: var(--code); white-space: nowrap; }
.chip.ok { background: var(--ok-bg); color: var(--ok); border-color: transparent; }
.chip.bad { background: var(--bad-bg); color: var(--bad); border-color: transparent; }
.chip.warn { background: var(--warn-bg); color: var(--warn); border-color: transparent; }
.notice { padding: 10px 12px; border-radius: 8px; background: var(--warn-bg); color: var(--warn); margin-bottom: 12px; }
.notice.info { background: var(--code); color: var(--text); }
table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
td.actions { text-align: right; white-space: nowrap; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
code { background: var(--code); padding: 1px 5px; border-radius: 4px; }
.ok-text { color: var(--ok); } .bad-text { color: var(--bad); } .warn-text { color: var(--warn); }
form, .form { display: grid; gap: 10px; }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
label.field { display: grid; gap: 4px; min-width: 160px; flex: 1; }
label.field > span { font-size: 12px; color: var(--muted); }
label.check { display: flex; gap: 8px; align-items: center; }
input[type=text], input[type=number], select { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; width: 100%; }
button.btn { font: inherit; border: 1px solid var(--border); background: var(--panel); color: var(--text); border-radius: 6px; padding: 6px 12px; cursor: pointer; }
button.btn.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
button.btn.danger { color: var(--bad); }
button.btn:disabled { opacity: .5; cursor: not-allowed; }
.hint { font-size: 12px; color: var(--muted); }
a { color: var(--accent); }
dialog { border: 1px solid var(--border); border-radius: 12px; background: var(--panel); color: var(--text); padding: 0; width: min(760px, calc(100vw - 32px)); }
dialog::backdrop { background: rgba(0,0,0,.4); }
dialog .head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
dialog .body { padding: 12px 16px; max-height: 60vh; overflow: auto; }
dialog .foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
pre.output { margin: 0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12.5px; }
pre.output .warn { color: var(--warn); } pre.output .error { color: var(--bad); }
.spinner { display: inline-block; width: 12px; height: 12px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin .8s linear infinite; vertical-align: -2px; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (max-width: 720px) {
  .layout { grid-template-columns: 1fr; }
  nav { display: flex; overflow-x: auto; border-right: 0; border-bottom: 1px solid var(--border); padding: 8px; }
  nav button { width: auto; white-space: nowrap; }
  main { padding: 12px; }
  td.actions { white-space: normal; }
}
`;

/** Client code. No backticks or template placeholders in here: it is embedded as a raw string. */
const CLIENT = String.raw`
'use strict';
history.replaceState(null, '', location.pathname);

var SECTIONS = [
  ['overview', 'Overview'], ['rules', 'Rules'], ['settings', 'Guard settings'], ['hooks', 'Hooks'],
  ['github', 'GitHub guard'], ['audit', 'Audit'], ['machine', 'Machine']
];
var S = null, doctor = null, bypasses = null, auditResult = null, busy = false;
var shareMode = 'pr'; // remembered across re-renders
var section = (location.hash || '#overview').slice(1);

// ---- DOM helpers (text only: nothing from the repository is ever parsed as HTML)
function h(tag, props) {
  var el = document.createElement(tag);
  if (props) Object.keys(props).forEach(function (k) {
    var v = props[k];
    if (v === null || v === undefined || v === false) return;
    if (k === 'class') el.className = v;
    else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  });
  append(el, Array.prototype.slice.call(arguments, 2));
  return el;
}
function append(el, kids) {
  kids.forEach(function (c) {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  });
}
/** Replace an element's children, skipping null/false entries (replaceChildren would print "null"). */
function setKids(el, kids) { el.replaceChildren(); append(el, [].concat(kids)); }
function chip(text, kind) { return h('span', { class: 'chip ' + (kind || '') }, text); }
function card(title) { return h('div', { class: 'card' }, title ? h('h3', null, title) : null, Array.prototype.slice.call(arguments, 1)); }
function field(label, input, hint) { return h('label', { class: 'field' }, h('span', null, label), input, hint ? h('span', { class: 'hint' }, hint) : null); }
function check(label, input) { return h('label', { class: 'check' }, input, label); }
function btn(label, onclick, kind) { return h('button', { class: 'btn ' + (kind || ''), type: 'button', onclick: onclick, disabled: busy }, label); }
function table(headers, rows) {
  return h('table', null, h('thead', null, h('tr', null, headers.map(function (x) { return h('th', null, x); }))),
    h('tbody', null, rows));
}
function link(text, href) { return href ? h('a', { href: href, target: '_blank', rel: 'noreferrer noopener' }, text) : text; }
function commitLink(sha) {
  var gh = S && S.repo && S.repo.remote.github;
  return h('span', { class: 'mono' }, link(sha.slice(0, 7), gh ? gh.web + '/commit/' + sha : null));
}
function shareSelect() {
  var sel = h('select', { onchange: function () { shareMode = sel.value; } },
    h('option', { value: 'pr' }, 'Commit on a branch, push and open a pull request'),
    h('option', { value: 'commit' }, 'Commit on a branch only (no push)'),
    h('option', { value: 'file' }, 'Only edit .vcs-protection.json'));
  sel.value = shareMode;
  return sel;
}
function list(text) { return text.split(',').map(function (x) { return x.trim(); }).filter(Boolean); }

// ---- API
function api(path, body) {
  var init = { method: body ? 'POST' : 'GET', headers: { 'X-Studio-Token': TOKEN } };
  if (body) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
  return fetch(path, init).then(function (res) {
    return res.json().catch(function () { return { error: res.status + ' ' + res.statusText }; }).then(function (data) {
      if (!res.ok) { var e = new Error(data.error || res.statusText); e.data = data; e.status = res.status; throw e; }
      return data;
    });
  });
}

function refresh() {
  return api('/api/state').then(function (st) {
    S = st;
    if (!S.repo && section !== 'machine') section = 'overview';
    return S.repo ? api('/api/doctor').then(function (d) { doctor = d; }) : null;
  }).then(render).catch(function (e) {
    setKids(document.getElementById('main'), h('div', { class: 'notice' },
      'Lost contact with the studio (' + e.message + '). Is it still running? Restart it and open the new link.'));
  });
}

// ---- Dialogs
function confirmDialog(title, message, action) {
  return new Promise(function (resolve) {
    var d = document.getElementById('confirm');
    setKids(d, [
      h('div', { class: 'head' }, h('strong', null, title)),
      h('div', { class: 'body' }, h('p', null, message)),
      h('div', { class: 'foot' },
        h('button', { class: 'btn', type: 'button', onclick: function () { d.close(); resolve(false); } }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'button', onclick: function () { d.close(); resolve(true); } }, action || 'Continue'))]);
    d.showModal();
  });
}
function linkify(text) {
  var parts = text.split(/(https?:\/\/[^\s)'"]+)/);
  return parts.map(function (p, i) { return i % 2 ? link(p, p) : p; });
}
function showOutput(title, res) {
  var d = document.getElementById('output');
  var ok = res && res.ok;
  var lines = (res && res.output) || [];
  var body = [];
  if (lines.length) body.push(h('pre', { class: 'output' }, lines.map(function (l) { return h('div', { class: l.level }, linkify(l.text)); })));
  if (res && res.error) body.push(h('p', { class: 'bad-text' }, res.error));
  if (res && res.issues) body.push(h('ul', null, res.issues.map(function (i) { return h('li', null, h('code', null, i.path || '(arguments)'), ' ', i.message); })));
  if (!body.length) body.push(h('p', { class: 'muted' }, 'Done.'));
  setKids(d, [
    h('div', { class: 'head' }, h('strong', null, title), chip(ok ? 'success' : 'failed', ok ? 'ok' : 'bad')),
    h('div', { class: 'body' }, body),
    h('div', { class: 'foot' }, h('button', { class: 'btn primary', type: 'button', onclick: function () { d.close(); } }, 'Close'))]);
  d.showModal();
}

function setBusy(v) { busy = v; render(); }
function run(name, args, title, confirmText) {
  var go = confirmText ? confirmDialog(title, confirmText, title) : Promise.resolve(true);
  return go.then(function (yes) {
    if (!yes) return;
    setBusy(true);
    return api('/api/actions/' + name, args || {})
      .then(function (res) { if (name === 'audit' && res.result) auditResult = res.result; if (name !== 'audit') showOutput(title, res); else if (!res.ok && res.error) showOutput(title, res); })
      .catch(function (e) { showOutput(title, e.data || { error: e.message }); })
      .then(function () { busy = false; return refresh(); });
  });
}

// ---- Sections
function header() {
  var el = document.getElementById('header');
  var r = S && S.repo;
  setKids(el, [
    h('h1', null, 'vcs-protection studio'),
    r ? chip(r.root.split(/[\\/]/).pop()) : chip('not a git repository', 'warn'),
    r && r.branch ? chip('branch ' + r.branch) : null,
    r && r.rules ? chip(r.rules.source === 'remote' ? 'rules from ' + r.remote.name + ' (shared)' : 'rules only in this clone (not merged yet)', r.rules.source === 'remote' ? 'ok' : 'warn') : null,
    r && r.unmerged ? chip('local changes not merged', 'warn') : null,
    busy ? h('span', null, h('span', { class: 'spinner' }), ' working…') : null,
    h('span', { class: 'muted' }, 'v' + (S ? S.version : ''))]);
}

function nav() {
  var el = document.getElementById('nav');
  setKids(el, SECTIONS.filter(function (s) { return (S && S.repo) || s[0] === 'overview' || s[0] === 'machine'; }).map(function (s) {
    return h('button', { class: s[0] === section ? 'active' : '', type: 'button', onclick: function () { location.hash = s[0]; } }, s[1]);
  }));
}

function initForm() {
  var branches = h('input', { type: 'text', value: (S.repo && S.repo.branch) || 'main' });
  var approvals = h('input', { type: 'number', min: 0, value: 1 });
  var gh = h('input', { type: 'checkbox', checked: true });
  return card('Set up protection in this repository',
    h('p', { class: 'muted' }, 'Creates .vcs-protection.json, installs the git hooks and (optionally) the GitHub guard workflow — the same as ', h('code', null, 'vcs-protection init'), '.'),
    h('div', { class: 'form' },
      h('div', { class: 'row' },
        field('Branches to protect (comma-separated, globs allowed)', branches),
        field('Required approvals', approvals)),
      check('Also write the GitHub Actions guard workflow', gh),
      h('div', null, btn('Initialize', function () {
        run('init', { branches: branches.value, approvals: Number(approvals.value), github: gh.checked }, 'Initialize');
      }, 'primary'))));
}

function overview() {
  if (!S.repo) {
    return [h('h2', null, 'Overview'),
      h('div', { class: 'notice' }, 'This folder (' + S.cwd + ') is not inside a git repository. Only the Machine section is available here; start the studio inside a repository to manage its protection.')];
  }
  var r = S.repo;
  var out = [h('h2', null, 'Overview')];
  if (r.rulesError) out.push(h('div', { class: 'notice' }, 'The rules can\'t be read: ' + r.rulesError));
  if (!r.rules && !r.rulesError) { out.push(initForm()); return out; }
  var hooksOk = r.hooks.list.filter(function (x) { return x.state === 'installed'; }).length;
  out.push(h('div', { class: 'grid' },
    h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Protected patterns'), h('div', { class: 'value' }, r.rules ? r.rules.config.protected.length : 0)),
    h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Git hooks'), h('div', { class: 'value ' + (hooksOk === r.hooks.list.length ? 'ok-text' : 'bad-text') }, hooksOk + ' / ' + r.hooks.list.length)),
    h('div', { class: 'stat' }, h('div', { class: 'label' }, 'GitHub guard'), h('div', { class: 'value ' + (r.workflow.present && r.workflow.inSync ? 'ok-text' : 'warn-text') },
      !r.workflow.present ? 'missing' : r.workflow.inSync ? 'in sync' : 'out of date')),
    h('div', { class: 'stat' }, h('div', { class: 'label' }, 'Local bypasses'), h('div', { class: 'value' }, r.bypasses.count))));
  var checks = (doctor && doctor.checks) || [];
  var fixable = checks.some(function (c) { return !c.ok && c.fixable; });
  out.push(card('Health (vcs-protection doctor)',
    doctor && doctor.error ? h('div', { class: 'notice' }, doctor.error) : null,
    table(['', 'Check', 'Details'], checks.map(function (c) {
      return h('tr', null, h('td', { class: c.ok ? 'ok-text' : 'bad-text' }, c.ok ? '✔' : '✖'), h('td', null, c.name), h('td', null, c.detail));
    })),
    fixable ? h('div', { class: 'row' }, btn('Repair hooks', function () { run('repairHooks', {}, 'Repair hooks'); }, 'primary')) : null));
  return out;
}

function rules() {
  var r = S.repo;
  var out = [h('h2', null, 'Rules')];
  if (!r.rules) { out.push(h('div', { class: 'notice' }, 'No rules yet. Set them up in the Overview.')); return out; }
  out.push(h('p', { class: 'muted' }, 'Rules in force, from ', h('code', null, r.rules.location), '. Changes are made in this clone\'s .vcs-protection.json and take effect for everyone once merged, like ', h('code', null, 'protect'), ' / ', h('code', null, 'unprotect'), '.'));
  if (r.unmerged) out.push(h('div', { class: 'notice' }, 'This clone\'s .vcs-protection.json has changes that aren\'t merged yet; the table shows the rules in force.'));
  var share = shareSelect();
  var rows = r.rules.config.protected.map(function (rule) {
    var approvals = h('input', { type: 'number', min: 0, value: rule.requiredApprovals });
    var del = h('input', { type: 'checkbox', checked: rule.allowDeletion });
    return h('tr', null,
      h('td', null, h('code', null, rule.pattern)),
      h('td', null, approvals),
      h('td', null, check('allowed', del)),
      h('td', { class: 'actions' },
        btn('Save', function () {
          run('protect', { pattern: rule.pattern, approvals: Number(approvals.value), allowDeletion: del.checked, share: share.value }, 'Update ' + rule.pattern);
        }), ' ',
        btn('Remove', function () {
          run('unprotect', { pattern: rule.pattern, share: share.value }, 'Unprotect ' + rule.pattern,
            '\'' + rule.pattern + '\' stays protected for everyone until this change is merged into the default branch.');
        }, 'danger')));
  });
  out.push(card(null, table(['Pattern', 'Approvals', 'Deletion on the remote', ''], rows),
    h('div', { class: 'row' }, field('How to share changes', share))));
  var p = h('input', { type: 'text', placeholder: 'e.g. release/*' });
  var a = h('input', { type: 'number', min: 0, value: 1 });
  var d = h('input', { type: 'checkbox' });
  out.push(card('Protect a branch or pattern',
    h('div', { class: 'form' },
      h('div', { class: 'row' },
        field('Branch or glob', p, 'release/* matches release/1.0; release/** any depth'),
        field('Required approvals', a)),
      check('Allow deleting it on the remote', d),
      h('div', null, btn('Protect', function () {
        run('protect', { pattern: p.value, approvals: Number(a.value), allowDeletion: d.checked, share: share.value }, 'Protect ' + p.value);
      }, 'primary')))));
  return out;
}

var SWEEPS = [['*/15 * * * *', 'Every 15 minutes'], ['*/30 * * * *', 'Every 30 minutes'], ['0 * * * *', 'Every hour'], ['off', 'Off'], ['custom', 'Custom cron…']];
var CONCLUSIONS = ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'];

function settings() {
  var r = S.repo;
  var base = r.workingConfig || (r.rules && r.rules.config);
  var out = [h('h2', null, 'Guard settings')];
  if (r.workingConfigError) out.push(h('div', { class: 'notice' }, 'This clone\'s .vcs-protection.json is invalid: ' + r.workingConfigError));
  if (!base) { out.push(h('div', { class: 'notice' }, 'No rules yet. Set them up in the Overview.')); return out; }
  var g = base.github;
  var enforcement = h('select', null, h('option', { value: 'revert' }, 'revert (reset + rescue branch + issue)'), h('option', { value: 'report' }, 'report (issue only)'));
  enforcement.value = g.enforcement;
  var rescue = h('input', { type: 'text', value: g.rescueBranchPrefix });
  var bypassUsers = h('input', { type: 'text', value: g.bypassUsers.join(', ') });
  var stale = h('input', { type: 'checkbox', checked: g.dismissStaleApprovals });
  var known = SWEEPS.some(function (s) { return s[0] === g.sweep; });
  var sweep = h('select', null, SWEEPS.map(function (s) { return h('option', { value: s[0] }, s[1]); }));
  sweep.value = g.sweep === null ? 'off' : known ? g.sweep : 'custom';
  var cron = h('input', { type: 'text', value: g.sweep && !known ? g.sweep : '', placeholder: '*/20 * * * *' });
  var guardLogin = h('input', { type: 'text', value: g.guardLogin });
  var bypassAllowed = h('input', { type: 'checkbox', checked: base.bypass.allowed });
  var failMode = h('select', null, h('option', { value: 'open' }, 'open (warn and allow)'), h('option', { value: 'closed' }, 'closed (block)'));
  failMode.value = base.failMode;
  var pp = g.poisonPill;
  var ppOn = h('input', { type: 'checkbox', checked: pp.enabled });
  var ppWorkflows = h('input', { type: 'text', value: pp.workflows.join(', '), placeholder: 'CI, E2E' });
  var ppChecks = h('input', { type: 'text', value: pp.checks.join(', '), placeholder: 'empty: every job' });
  var ppConclusions = CONCLUSIONS.map(function (c) { return h('input', { type: 'checkbox', value: c, checked: pp.conclusions.indexOf(c) >= 0 }); });
  var share = shareSelect();
  out.push(h('p', { class: 'muted' }, 'Saved to .vcs-protection.json (and the workflow is regenerated), then shared like a rules change. They apply once merged.'));
  out.push(card('Enforcement',
    h('div', { class: 'form' },
      h('div', { class: 'row' }, field('On a violation', enforcement), field('Rescue branch prefix', rescue)),
      field('Bypass users (GitHub logins, comma-separated)', bypassUsers, 'Their pushes are accepted by the guard, e.g. a release bot.'),
      check('Only count approvals of the PR\'s final commit (dismiss stale approvals)', stale),
      h('div', { class: 'row' }, field('Sweep', sweep, 'Re-checks every protected branch; catches [skip ci] pushes.'), field('Custom cron', cron)),
      field('Guard account', guardLogin, 'Whose markers count. Keep github-actions[bot] unless the guard uses a GitHub App token.'))));
  out.push(card('Local hooks',
    h('div', { class: 'form' },
      check('Allow the VCS_PROTECTION_BYPASS emergency bypass', bypassAllowed),
      field('If the CLI is missing or crashes (failMode)', failMode))));
  out.push(card('Poison pill',
    h('div', { class: 'form' },
      check('Reset merges that make a critical CI workflow fail', ppOn),
      h('div', { class: 'row' }, field('Critical workflows (their name:)', ppWorkflows), field('Only these jobs', ppChecks)),
      h('div', null, h('div', { class: 'hint' }, 'Conclusions that count as a failure'),
        h('div', { class: 'row' }, ppConclusions.map(function (box) { return check(box.value, box); }))))));
  out.push(card(null, h('div', { class: 'row' }, field('How to share the change', share),
    h('div', null, btn('Save settings', function () {
      var patch = {
        github: {
          enforcement: enforcement.value, rescueBranchPrefix: rescue.value.trim(), bypassUsers: list(bypassUsers.value),
          dismissStaleApprovals: stale.checked, guardLogin: guardLogin.value.trim(),
          sweep: sweep.value === 'off' ? null : sweep.value === 'custom' ? cron.value.trim() : sweep.value,
          poisonPill: {
            enabled: ppOn.checked, workflows: list(ppWorkflows.value), checks: list(ppChecks.value),
            conclusions: ppConclusions.filter(function (b) { return b.checked; }).map(function (b) { return b.value; })
          }
        },
        bypass: { allowed: bypassAllowed.checked },
        failMode: failMode.value
      };
      run('updateSettings', { patch: patch, share: share.value }, 'Save settings');
    }, 'primary')))));
  return out;
}

function hooks() {
  var r = S.repo;
  var out = [h('h2', null, 'Hooks')];
  out.push(h('p', { class: 'muted' }, 'Installed in ', h('code', null, r.hooks.dir), r.hooks.hooksPath ? ' (core.hooksPath is set)' : '', '.'));
  if (r.hooks.inWorkTree && r.hooks.ignored) out.push(h('div', { class: 'notice' }, 'This hooks directory is generated by another tool (e.g. husky), which may overwrite the hooks; reference-transaction is the one that enforces.'));
  if (r.hooks.inWorkTree && !r.hooks.ignored) out.push(h('div', { class: 'notice' }, 'This hooks directory is tracked in the repository. The hooks contain paths of this machine: don\'t commit them.'));
  var states = { installed: 'ok', outdated: 'warn', missing: 'bad', foreign: 'warn' };
  out.push(card(null, table(['Hook', 'State', 'Chained'], r.hooks.list.map(function (x) {
    return h('tr', null, h('td', null, h('code', null, x.hook)), h('td', null, chip(x.state, states[x.state])), h('td', null, x.chained ? x.hook + '.local' : ''));
  })),
  h('div', { class: 'row' },
    btn('Install / refresh', function () { run('installHooks', {}, 'Install hooks'); }, 'primary'),
    btn('Repair missing or outdated', function () { run('repairHooks', {}, 'Repair hooks'); }),
    btn('Uninstall', function () { run('uninstallHooks', {}, 'Uninstall hooks', 'Removes the vcs-protection hooks from this clone (chained *.local hooks are restored). The clone is no longer protected locally.'); }, 'danger'))));
  return out;
}

function github() {
  var r = S.repo;
  var gh = r.remote.github;
  var out = [h('h2', null, 'GitHub guard')];
  if (!gh) out.push(h('div', { class: 'notice' }, 'The remote \'' + r.remote.name + '\' is not a GitHub repository' + (r.remote.url ? ' (' + r.remote.url + ')' : '') + '. The guard needs GitHub.'));
  if (!r.tokenAvailable) out.push(h('div', { class: 'notice info' }, 'No GitHub token found (GITHUB_TOKEN, GH_TOKEN or gh auth login). Rule changes print a link instead of opening the PR, and the audit only reads local bypasses.'));
  var wf = r.workflow;
  out.push(card('Workflow',
    h('p', null, h('code', null, wf.path), ' ', !wf.present ? chip('missing', 'bad') : wf.inSync ? chip('in sync', 'ok') : chip('out of date', 'warn'),
      wf.pinned ? h('span', { class: 'muted' }, '  runs vcs-protection@' + wf.pinned) : null)));
  var pin = h('input', { type: 'text', placeholder: S.version });
  out.push(card('Write the workflow (vcs-protection github setup)',
    h('div', { class: 'row' }, field('Pin version (optional)', pin),
      h('div', null, btn('Write workflow', function () { run('githubSetup', { pin: pin.value.trim() || undefined }, 'Write workflow'); }, 'primary'))),
    h('p', { class: 'hint' }, 'Commit the file through a pull request. On GitHub, Settings → Actions → General → Workflow permissions must be "Read and write".')));
  if (gh) {
    out.push(card('On GitHub',
      h('p', null, link('Actions runs', gh.web + '/actions'), ' · ', link('Run the guard (sweep or baseline)', gh.web + '/actions/workflows/vcs-protection-guard.yml'), ' · ', link('Issues', gh.web + '/issues')),
      h('p', { class: 'hint' }, 'A branch the guard has never verified needs one run with "baseline" ticked. That runs on GitHub, with the workflow\'s token, so it is started there.')));
  }
  return out;
}

function audit() {
  var out = [h('h2', null, 'Audit')];
  var since = h('input', { type: 'text', placeholder: 'e.g. 2 weeks ago' });
  var limit = h('input', { type: 'number', min: 1, value: 50 });
  out.push(card('Check recent history (vcs-protection audit)',
    h('p', { class: 'muted' }, 'Judges the recent first-parent commits of each protected branch like the GitHub guard does. Run git fetch first for up-to-date branches.'),
    h('div', { class: 'row' }, field('Since', since), field('Commits per branch', limit),
      h('div', null, btn('Run audit', function () {
        run('audit', { since: since.value.trim() || undefined, limit: Number(limit.value) || undefined }, 'Audit');
      }, 'primary')))));
  if (auditResult) {
    if (!auditResult.branches) out.push(h('div', { class: 'notice' }, 'The remote history was skipped: it needs a GitHub remote and a token.'));
    else if (!auditResult.branches.length) out.push(h('div', { class: 'notice info' }, 'No protected branches among the remote-tracking branches. Run git fetch, then audit again.'));
    else auditResult.branches.forEach(function (b) {
      out.push(card(b.branch + ' — ' + b.commits.length + ' commit(s)', table(['', 'Commit', 'Result', 'Subject'], b.commits.map(function (c) {
        return h('tr', null, h('td', { class: c.ok ? 'ok-text' : 'bad-text' }, c.ok ? '✔' : '✖'), h('td', null, commitLink(c.sha)), h('td', null, c.reason), h('td', { class: 'muted' }, c.subject));
      }))));
    });
    if (auditResult.branches) out.push(h('p', { class: auditResult.problems ? 'bad-text' : 'ok-text' }, auditResult.problems ? auditResult.problems + ' problem(s) found.' : 'No problems found.'));
  }
  var entries = (bypasses && bypasses.entries) || [];
  out.push(card('Local bypasses (VCS_PROTECTION_BYPASS)',
    entries.length ? table(['Time', 'Who', 'Hook', 'Ref', 'Commit', 'Reason'], entries.slice().reverse().map(function (b) {
      return h('tr', null, h('td', { class: 'mono' }, b.time), h('td', null, b.user), h('td', null, b.hook), h('td', { class: 'mono' }, b.ref), h('td', null, commitLink(b.newSha)), h('td', null, b.reason));
    })) : h('p', { class: 'muted' }, 'None logged in this clone.')));
  return out;
}

function machine() {
  var g = S.global;
  var force = h('input', { type: 'checkbox' });
  var state = g.installed ? chip('installed', 'ok') : g.foreign ? chip('another template is configured', 'warn') : chip('not installed', 'bad');
  return [h('h2', null, 'Machine'),
    card('Hooks for every new clone (vcs-protection install --global)',
      h('p', null, 'git init.templateDir: ', g.current ? h('code', null, g.current) : h('span', { class: 'muted' }, 'not set'), ' ', state),
      h('p', { class: 'muted' }, 'Points git at ', h('code', null, g.templateDir), ' so every new clone gets the hooks. They stay inactive in repositories without rules.'),
      g.foreign ? check('Replace the other template (--force)', force) : null,
      h('div', { class: 'row' },
        btn(g.installed ? 'Reinstall' : 'Install', function () { run('installGlobal', { force: force.checked }, 'Install the global template'); }, 'primary'),
        g.installed ? btn('Remove', function () { run('uninstallGlobal', {}, 'Remove the global template', 'New clones will no longer get the hooks automatically. Existing clones keep theirs.'); }, 'danger') : null))];
}

var VIEWS = { overview: overview, rules: rules, settings: settings, hooks: hooks, github: github, audit: audit, machine: machine };

function render() {
  if (!S) return;
  header();
  nav();
  var view = VIEWS[section] && (S.repo || section === 'machine') ? VIEWS[section] : overview;
  setKids(document.getElementById('main'), [].concat(view()));
}

window.addEventListener('hashchange', function () {
  section = location.hash.slice(1) || 'overview';
  if (section === 'audit' && S && S.repo) api('/api/bypasses').then(function (b) { bypasses = b; render(); });
  render();
});
window.addEventListener('focus', function () { if (!busy) refresh(); });
refresh().then(function () {
  if (section === 'audit' && S && S.repo) return api('/api/bypasses').then(function (b) { bypasses = b; render(); });
});
`;

/** The studio app. `token` is only ever placed inside the nonce'd script, never in a URL or attribute. */
export function renderPage(opts: { token: string; nonce: string }): string {
  const { token, nonce } = opts;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>vcs-protection studio</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<header id="header"><h1>vcs-protection studio</h1><span class="spinner"></span></header>
<div class="layout">
<nav id="nav" aria-label="Sections"></nav>
<main id="main"></main>
</div>
<dialog id="output"></dialog>
<dialog id="confirm"></dialog>
<script nonce="${nonce}">(function (TOKEN) {${CLIENT}})(${JSON.stringify(token)});</script>
</body>
</html>
`;
}

/** Shown for `/` without the right token (an old tab, or someone else's link). */
export function notFoundPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>vcs-protection studio</title></head>
<body><p>This studio link is not valid. Open the link printed in the terminal where <code>vcs-protection studio</code> is running (a new link is printed every time it starts).</p></body></html>
`;
}
