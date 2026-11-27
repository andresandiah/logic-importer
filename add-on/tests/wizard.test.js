import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';
import fs from 'node:fs';

globalThis.Luna = Luna;
await import('../wizard.js');
await import('../logic.js');
await import('../report.js');
const { Wizard, AddOnLogic: logic, ImportReport: reports } = globalThis;

const base = { helperConfirmed: true, helperOnline: true, lunaConnected: true, exporting: false, importing: false };

describe('three steps', () => {
  it('opens them in order', () => {
    expect(Wizard.view(base)).toMatchObject({ steps: ['done', 'active', 'locked', 'locked'], export: false, import: false });
    const exported = { ...base, project: '/p', manifest: {}, sessionName: 'Song' };
    expect(Wizard.view(exported)).toMatchObject({ steps: ['done', 'done', 'active', 'locked'], pickOutput: true, import: false });
    expect(Wizard.view({ ...exported, outputFolder: '/o' }).import).toBe(true);
    expect(Wizard.view({ ...exported, outputFolder: '/o', imported: true, hasReport: true }))
      .toMatchObject({ steps: ['done', 'done', 'done', 'active'], import: false });
  });

  it('locks the controls while work is running', () => {
    const v = Wizard.view({ ...base, project: '/p', manifest: {}, sessionName: 'S', outputFolder: '/o', importing: true });
    expect(v).toMatchObject({ pickProject: false, pickOutput: false, import: false });
  });
});

describe('installing the helper', () => {
  it('keeps everything locked until the answer is Yes and the helper answers', () => {
    for (const s of [{ ...base, helperConfirmed: false }, { ...base, helperOnline: false }]) {
      expect(Wizard.view(s)).toMatchObject({ steps: ['active', 'locked', 'locked', 'locked'], pickProject: false });
    }
  });

  it('No explains what to do and does not look for the helper', async () => {
    let asked = 0;
    const answer = await Wizard.answerInstalled(false, async () => { asked += 1; });
    expect(answer).toMatchObject({ confirmed: false });
    expect(answer.message).toContain('Install it first');
    expect(asked).toBe(0);
  });

  it('Yes is not believed when the helper cannot be reached', async () => {
    const answer = await Wizard.answerInstalled(true, async () => { throw new Error('The helper is not running.'); }, { tries: 2, pauseMs: 1 });
    expect(answer.confirmed).toBe(false);
    expect(answer.message).toContain('cannot be reached');
  });

  it('Yes unlocks once the helper answers, even if it needs a moment to start', async () => {
    let n = 0;
    const answer = await Wizard.answerInstalled(true, async () => { n += 1; if (n < 3) throw new Error('x'); return {}; }, { pauseMs: 1 });
    expect(answer.confirmed).toBe(true);
  });

  it('picks up a config written after the page loaded', async () => {
    let config;
    const helper = Wizard.helperClient(() => config, async () => ({ ok: true, json: async () => ({ ok: 1 }) }));
    await expect(helper.status()).rejects.toThrow('not been set up');
    config = { port: 1, token: 't' };
    await expect(helper.status()).resolves.toEqual({ ok: 1 });
  });

  it('points at the installer where LUNA installs this Add On', () => {
    const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
    expect(Wizard.INSTALLER_PATH).toContain(`/Add Ons/${manifest.package_name}/helper-installer/`);
    expect(fs.existsSync(new URL('../helper-installer/Logic Importer Helper.pkg', import.meta.url))).toBe(true);
  });
});

describe('helper client', () => {
  const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body, text: async () => JSON.stringify(body) });

  it('sends the token to this Mac only', async () => {
    const seen = [];
    const helper = Wizard.helperClient({ port: 8797, token: 't' }, async (url, o) => { seen.push([url, o]); return reply({}); });
    await helper.pick('session-folder');
    expect(seen[0]).toEqual(['http://127.0.0.1:8797/pick/session-folder', { method: 'POST', headers: { 'X-Importer-Token': 't' } }]);
  });

  it('says when the helper is not set up or not running', async () => {
    await expect(Wizard.helperClient(undefined).status()).rejects.toMatchObject({ offline: true });
    const down = Wizard.helperClient({ port: 1, token: 't' }, async () => { throw new TypeError('refused'); });
    await expect(down.status()).rejects.toThrow('not running');
  });

  it('waits for the export and surfaces failure', async () => {
    const states = [{ status: 'running', messages: ['a'] }, { status: 'failed', error: 'bad project' }];
    const seen = [];
    await expect(Wizard.waitForExport({ status: async () => states.shift() }, (m) => seen.push(m), { pollMs: 1 }))
      .rejects.toThrow('bad project');
    expect(seen).toEqual(['a']);
  });
});

describe('creating the session', () => {
  const fake = (create) => ({ sessions: { items: { items: [{ uid: 'old', name: { value: 'Song' } }] }, create } });

  it('passes the chosen output folder to LUNA', async () => {
    let sent;
    await logic.createSession(fake(async (o) => { sent = o; return {}; }), { name: 'Song', directoryPath: '/o' });
    expect(sent).toMatchObject({ name: 'Song', directoryPath: '/o' });
  });

  it('finds a session LUNA made after the SDK gave up waiting, never an older one', async () => {
    const luna = fake(async () => {
      setTimeout(() => luna.sessions.items.items.push({ uid: 'new', name: { value: 'Song' } }), 20);
      throw Object.assign(new Error('slow'), { code: 'timeout' });
    });
    await expect(logic.createSession(luna, { name: 'Song' }, { waitMs: 1000, pollMs: 5 })).resolves.toMatchObject({ uid: 'new' });
  });

  it('fails when no new session appears or LUNA refuses', async () => {
    const slow = fake(async () => { throw Object.assign(new Error('slow'), { code: 'timeout' }); });
    await expect(logic.createSession(slow, { name: 'Song' }, { waitMs: 30, pollMs: 5 })).rejects.toThrow('slow');
    await expect(logic.createSession(fake(async () => { throw new Error('refused'); }), { name: 'S' })).rejects.toThrow('refused');
  });
});

describe('manual to-do list', () => {
  it('puts side-chains first and gives the values to set', () => {
    const rows = reports.actions({
      log: [
        { status: 'not_transferred', channel: 'Bass', item: 'InPhase side-chain', detail: "Side-chain source 'Kick' must be reconnected by hand." },
        { status: 'not_transferred', channel: null, item: 'Track colours', detail: 'x' },
      ],
      plugins: [
        { channel: 'Vox', slot: 2, name: 'Nectar', loaded: false, reason: 'Missing.', params: [] },
        { channel: 'Syn', slot: 1, name: 'SSL', loaded: true, status: 'partial', params: [{ name: 'HP Freq', logic: '42 Hz', retained: false }] },
      ],
    });
    expect(rows.map((r) => r[0])).toEqual(['Assign side-chain', 'Replace missing plug-in', 'Set plug-in values']);
    expect(rows[2][2]).toContain('HP Freq → 42 Hz');
  });
});

it('the page loads every script it needs and has every element the wiring uses', () => {
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  for (const [, file] of html.matchAll(/<script src="([^"]+)"/g)) {
    if (file !== 'helper-config.js') expect(fs.existsSync(new URL(`../${file}`, import.meta.url)), file).toBe(true);
  }
  for (const [, id] of main.matchAll(/\$\('([a-zA-Z0-9-]+)'\)/g)) expect(html, id).toContain(`id="${id}"`);
});
