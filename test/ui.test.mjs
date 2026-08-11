import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, finish } from './_harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'src', 'web', 'ui.html'), 'utf8');

/* --- the page's JavaScript must parse -------------------------------------
   A syntax error here breaks the whole setup UI at runtime with nothing but a
   console message, so it is worth catching in CI. vm.Script compiles without
   executing, so no browser and no temp files are needed. */
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check('ui.html has exactly one script block', scripts.length === 1, `${scripts.length}`);

let parsed = true;
let parseError = '';
try {
  new vm.Script(scripts.join('\n'), { filename: 'ui.html' });
} catch (err) {
  parsed = false;
  parseError = err.message;
}
check('ui.html JavaScript parses', parsed, parseError);

/* --- structural elements the script depends on ----------------------------- */
for (const id of ['login', 'wizard', 'dash', 'stepbody', 'steps', 'loginform', 'pw', 'logout']) {
  check(`element #${id} exists`, html.includes(`id="${id}"`));
}

/* --- every element the script looks up by id must exist in the markup ------ */
const referenced = new Set([...scripts.join('\n').matchAll(/\$\('([a-zA-Z_][\w-]*)'\)/g)].map((m) => m[1]));
const missing = [...referenced].filter((id) => !html.includes(`id="${id}"`));
check('no $() lookups target missing ids', missing.length === 0, missing.join(', '));

/* --- assets and endpoints the page relies on -------------------------------- */
check('references the logo', html.includes('/logo.jpg'));
check('sets a favicon', html.includes('rel="icon"'));
check('is responsive', html.includes('name="viewport"'));
for (const endpoint of ['/api/session', '/api/login', '/api/logout', '/api/state', '/api/config', '/api/action']) {
  check(`calls ${endpoint}`, html.includes(endpoint));
}

/* --- dashboard quick-edit sections -------------------------------------------
   Every setting the wizard collects must also be reachable from the dashboard,
   which is the only way to change one without re-running setup. */
const js = scripts.join('\n');
for (const builder of ['secDestination', 'secPings', 'secSources', 'secOptions', 'secCommands']) {
  check(`${builder}() defined`, js.includes(`function ${builder}(`));
  check(`${builder}() rendered on the dashboard`, new RegExp(`\\b${builder}\\b[,\\]]`).test(js));
}
check('sections save their own patch', js.includes('function saveBar('));
check('open sections survive a re-render', js.includes('openSections'));
check('prefix is editable', js.includes('prefixEnabled:') && js.includes('#d_pfx'));
check('built-in rsshub is surfaced', js.includes('rsshub-restart') && js.includes('function rsshubBlock('));

/* --- RSS feed management ----------------------------------------------------
   The feed list is the setting people come back to most, so the manager has to
   cover the whole lifecycle without dropping to a config file. */
for (const fn of ['feedEditor', 'feedsFromState', 'feedPatch', 'testFeed', 'feedAdder',
  'fetchSettingsMarkup', 'fetchSettingsPatch']) {
  check(`${fn}() defined`, js.includes(`function ${fn}(`));
}
check('feeds can be reordered', js.includes('data-up') && js.includes('data-down'));
check('feeds can be disabled without deleting', js.includes('data-on') && js.includes('rssDisabled'));
check('feeds can be removed', js.includes('data-del'));
check('feeds can be tested one at a time', js.includes("action: 'feed-test'"));
check('a tested feed previews what it would post', js.includes('function itemRow('));
check('fetch settings are editable', js.includes('rssSettings:') && js.includes('_ua'));
check('presets come from the server', js.includes('S.feedPresets'));
check('the wizard and dashboard share the feed editor',
  (js.match(/feedEditor\(/g) ?? []).length >= 3, `${(js.match(/feedEditor\(/g) ?? []).length} uses`);

/* --- output escaping -------------------------------------------------------
   Guild, channel and role names come from Discord and land in innerHTML, so
   the escape helper must cover the dangerous characters. */
const escaper = scripts.join('\n').match(/const esc = [\s\S]*?\}\[c\]\)\);/);
check('esc() helper is present', Boolean(escaper));
if (escaper) {
  for (const ch of ['&', '<', '>', '"', "'"]) {
    check(`esc() handles ${ch}`, escaper[0].includes(`'${ch}'`) || escaper[0].includes(`"${ch}"`));
  }
}

finish();
