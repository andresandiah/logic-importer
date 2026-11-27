// Runs against Luna.MockEngine: no LUNA needed. The fixtures are converter output from real
// Logic project saves (logicxkit's test corpus); their audio files are generated test tones.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Luna } from '@uaudio/luna-builder-sdk';

globalThis.Luna = Luna;
await import('../logic.js');
await import('../report.js');
const logic = globalThis.AddOnLogic;
const reports = globalThis.ImportReport;

const fixture = (name) => logic.parseManifest(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));

async function run(manifest, prepare = () => {}) {
  const engine = new Luna.MockEngine();
  engine.addSession('abc', { name: 'New', tracks: [] });
  prepare(engine);
  const luna = await Luna.connect({ port_: engine.port() });
  const session = await luna.session();
  const result = await logic.importProject(luna, session, manifest, { settleMs: 300 });
  await engine.settled();
  return { engine, session, result };
}

const done = (result, key) => `${result.counts[key]?.copied}/${result.counts[key]?.total}`;
const byName = (session, name) => [...session.tracks.items, ...session.buses.items].find((c) => c.name.value === name);

describe('import into LUNA', () => {
  it('turns summing stacks into summing folders that hold their tracks', async () => {
    const { session, result } = await run(fixture('audio'));
    expect(done(result, 'Summing folders')).toBe('2/2');
    const folder = byName(session, 'Gitarren');
    expect(folder.folderMode.value).toBe('summing');
    expect(session.folderContents(folder).map((c) => c.name.value)).toEqual(['Audio 1', 'Audio 3']);
    expect(byName(session, 'Audio 1').main.busUid.value).toBe(folder.id);
  });

  it('keeps nested folders nested, grouping folders as grouping folders', async () => {
    const { session, result } = await run(fixture('nested'));
    expect(done(result, 'Folders')).toBe('2/2');
    const outer = byName(session, 'Band');
    expect(outer.folderMode.value).toBe('container');
    expect(byName(session, 'Gitarren').folderUid.value).toBe(outer.id);
    expect(byName(session, 'Audio 1').folderUid.value).toBe(byName(session, 'Gitarren').id);
  });

  it('places audio and MIDI regions', async () => {
    const { result } = await run(fixture('audio'));
    expect(done(result, 'Audio regions')).toBe('4/4');
    expect(done(result, 'MIDI regions')).toBe('1/1');
  });

  /** A stand-in for LUNA's clip gain control and its lane. `accepts` false: LUNA ignores it. */
  const gainLuna = ({ accepts = true, existing = [] } = {}) => {
    const lane = [...existing];
    const calls = [];
    return {
      lane, calls,
      raw: {
        get: async (path) => (path.endsWith('/automation')
          ? { children: lane.map((p) => ({ properties: { start: { value: p.tick }, value: { value: p.value } } })) }
          : { properties: { uid: { value: 'gain-uid' } } }),
        post: async (path, body) => {
          calls.push(path);
          if (accepts) for (const v of body.values) lane.push({ tick: v.location, value: Number(v.value.value ?? v.value) });
        },
      },
    };
  };
  const once = async (attempt) => attempt();

  it('sets region gain with one lane point and never touches the clip gain control', async () => {
    const luna = gainLuna();
    await logic.setClipGain(luna, { uid: 's' }, { path: '/clip' }, -15, once);
    expect(luna.lane).toEqual([{ tick: 0, value: -15 }]);
    expect(luna.calls).toEqual(['/sessions/s/insert_bp']);
  });

  it('reports a region gain LUNA did not keep', async () => {
    await expect(logic.setClipGain(gainLuna({ accepts: false }), { uid: 's' }, { path: '/clip' }, -15, once))
      .rejects.toThrow(/instead of -15 dB/);
  });

  it('leaves a clip with existing gain points alone', async () => {
    const luna = gainLuna({ existing: [{ tick: 0, value: -3 }] });
    await expect(logic.setClipGain(luna, { uid: 's' }, { path: '/clip' }, -15, once)).rejects.toThrow(/left alone/);
    expect(luna.calls).toEqual([]);
  });

  it('creates buses and sends', async () => {
    const { result } = await run(fixture('sends'));
    expect(done(result, 'Buses')).toBe('2/2');
    expect(done(result, 'Sends')).toBe('2/2');
  });

  describe('confirms switches, sends and bypass with LUNA', () => {
    const mixer = () => {
      const m = fixture('sends');
      const c = m.channels.find((x) => x.sends.length);
      c.mute = true;
      c.solo = true;
      c.sends[0].preFader = true;
      c.sends[1].bypassed = true;
      c.plugins = [{
        slot: 1, displayName: 'Pro-MB', manufacturer: 'FabFilter', logicOwn: false, component: ['aumf', 'FPMb', 'FabF'],
        instrument: false, midiEffect: false, bypassed: true, privateState: [], params: [],
      }];
      return { m, name: c.name };
    };
    const plugin = (engine) => engine.addPlugin('com.fabfilter.au.FPMb', { name: 'Pro-MB', manufacturer: 'FabFilter', sdkType: 'au' });

    it('counts them when LUNA holds them', async () => {
      const { m } = mixer();
      const { result } = await run(m, plugin);
      expect(result.log.filter((l) => l.status === 'not_transferred' && /Mute|Solo|Send to|Bypass/.test(l.item))).toEqual([]);
      expect(done(result, 'Sends')).toBe('2/2');
      expect(done(result, 'Plug-ins bypassed')).toBe('1/1');
    });

    it('reports them when only the page changed', async () => {
      const { m } = mixer();
      const engine = new Luna.MockEngine();
      engine.addSession('abc', { name: 'New', tracks: [] });
      plugin(engine);
      const luna = await Luna.connect({ port_: engine.port() });
      const session = await luna.session();
      // LUNA that accepts every write but still reports everything off, unsent and not bypassed.
      const ignores = { get: async (path) => (/outputs\/send_\d+$/.test(path) ? { properties: { assignments: { value: [] } } }
        : { properties: { real_value: { value: false }, string_value: { value: '' } } }) };
      const stillIn = ignores.get;
      ignores.get = async (path) => (/controls\/[^/]*bypass[^/]*$/i.test(path)
        ? { properties: { real_value: { value: false } } } : stillIn(path));
      const lying = new Proxy(luna, { get: (target, key) => (key === 'raw' ? ignores : Reflect.get(target, key)) });
      const result = await logic.importProject(lying, session, m, { settleMs: 150 });
      const lost = result.log.filter((l) => l.status === 'not_transferred').map((l) => l.item);
      for (const item of [/^Mute on/, /^Solo on/, /^Send to/, /^Bypass/]) expect(lost.some((x) => item.test(x)), String(item)).toBe(true);
      expect(done(result, 'Sends')).toBe('0/2');
      expect(done(result, 'Plug-ins bypassed')).toBe('0/1');
    });
  });

  describe('track colors', () => {
    it("maps Logic's color numbers, counted from 1, onto its picker", () => {
      expect(logic.lunaColor(1)).toBe(0xFFCA3C0F); // first swatch, red
      expect(logic.lunaColor(9)).toBe(0xFF11C92F); // instrument default, green
      expect(logic.lunaColor(16)).toBe(0xFF3582D4); // audio default, blue
      expect(logic.lunaColor(24)).toBe(0xFFCA0FA5); // Stereo Out, magenta
      expect(logic.lunaColor(25)).toBe(0xFFA33A19); // second row starts
      expect(logic.lunaColor(96)).toBe(0xFF571C4B); // last swatch
      for (const none of [0, 97, -1, 1.5, null, undefined]) expect(logic.lunaColor(none)).toBeUndefined();
      expect(new Set(Array.from({ length: 96 }, (_, i) => logic.lunaColor(i + 1))).size).toBe(96);
    });

    it('colors tracks and summing folders, the same number giving the same color', async () => {
      const manifest = fixture('audio');
      for (const c of manifest.channels) c.logicColour = c.kind === 'summing' ? 73 : 16;
      const { session, result } = await run(manifest);
      expect(result.counts['Track colors'].copied).toBe(result.counts['Track colors'].total);
      expect(byName(session, 'Gitarren').color.value >>> 0).toBe(logic.lunaColor(73));
      expect(byName(session, 'Audio 1').color.value >>> 0).toBe(logic.lunaColor(16));
      expect(byName(session, 'Audio 3').color.value >>> 0).toBe(logic.lunaColor(16));
    });

    it('reports colors LUNA ignores or numbers it does not know, and carries on', async () => {
      const manifest = fixture('sends');
      manifest.channels.forEach((c, i) => { c.logicColour = i ? 73 : 500; });
      const engine = new Luna.MockEngine();
      engine.addSession('abc', { name: 'New', tracks: [] });
      const luna = await Luna.connect({ port_: engine.port() });
      const session = await luna.session();
      const ignores = new Proxy(luna, {
        get: (target, key) => (key === 'raw'
          ? { ...target.raw, get: async (path, options) => (/\/(tracks|buses)\/[^/]+$/.test(path) ? { properties: { color: { value: 1 } } } : target.raw.get(path, options)) }
          : Reflect.get(target, key)),
      });
      const result = await logic.importProject(ignores, session, manifest, { settleMs: 120 });
      expect(result.counts['Track colors'].copied).toBe(0);
      const details = result.log.filter((l) => l.item === 'Track color').map((l) => l.detail);
      expect(details).toContain('Logic color number 500 is not in the palette.');
      expect(details).toContain('LUNA did not apply the color.');
      expect(done(result, 'Sends')).toBeDefined();
      expect(reports.actions(result).some((r) => r[2].startsWith('Track color'))).toBe(false);
    });
  });

  it('sets faders and writes volume and pan automation', async () => {
    const { session, result } = await run(fixture('automation'));
    expect(done(result, 'Automation lanes')).toBe('3/3');
    expect(byName(session, 'Audio 1').gain.real.value).toBeCloseTo(-7.044, 2);
  });

  it('reports missing converter data instead of hiding it', async () => {
    const { result } = await run(fixture('automation'));
    expect(result.log.some((l) => l.status === 'not_transferred' && /was not found/.test(l.detail))).toBe(true);
  });

  it('carries on and logs the failure when one step fails', async () => {
    const { result } = await run(fixture('audio'), (engine) =>
      engine.fail('/sessions/abc/insert_clip', 'uasrv.invalid_value', 1));
    expect(done(result, 'Audio regions')).toBe('3/4');
    expect(done(result, 'MIDI regions')).toBe('1/1');
  });

  it('rejects files the converter did not make', () => {
    expect(() => logic.parseManifest('nope')).toThrow(/not valid JSON/);
    expect(() => logic.parseManifest('{"format":"other"}')).toThrow(/not a Logic Importer file/);
  });
});

describe('plug-in settings', () => {
  const param = { name: 'Mix', default: 50, saved: 80, min: 0, max: 100 };
  /** A stand-in for a LUNA parameter control: `store` decides what LUNA keeps. */
  const control = (start, store = (v) => v) => {
    const c = {
      value: start,
      real: { get value() { return c.value; }, set: async (v) => { c.value = store(v); } },
      display: { get value() { return String(c.value); } },
      resetToDefault: async () => { c.value = start; },
    };
    return c;
  };
  const now = async (attempt) => { if (!(await attempt())) throw new Error('no'); };

  it('retains a value only when LUNA reads it back', async () => {
    await expect(logic.writeParam(control(50), param, now)).resolves.toMatchObject({ retained: true });
  });

  it('leaves a parameter alone when LUNA uses another scale', async () => {
    const c = control(0.5);
    await expect(logic.writeParam(c, param, now)).resolves.toMatchObject({ retained: false });
    expect(c.value).toBe(0.5);
  });

  it('resets a parameter LUNA changed to something else', async () => {
    const c = control(50, () => 100);
    await expect(logic.writeParam(c, param, now)).resolves.toMatchObject({ retained: false });
    expect(c.value).toBe(50);
  });

  it('on another number scale, keeps a value only when LUNA shows Logic\'s text', async () => {
    const dB = { name: 'Threshold', default: 10, saved: -5, min: -10, max: 10, defaultText: '10.0 dB', savedText: '-5.0 dB' };
    const make = (text) => {
      const c = control(1); // LUNA counts 0..1 here
      c.display = { get value() { return text(c.value); } };
      c.normalized = { set: async (v) => { c.value = v; } };
      return c;
    };
    const good = make((v) => `${(v * 20 - 10).toFixed(1)} dB`);
    await expect(logic.writeParam(good, dB, now)).resolves.toMatchObject({ retained: true });
    const curved = make((v) => `${(v * v * 20 - 10).toFixed(1)} dB`);
    await expect(logic.writeParam(curved, dB, now)).resolves.toMatchObject({ retained: false });
    expect(curved.value).toBe(1);
  });

  it('stops when the starting tempo cannot be set', async () => {
    const manifest = fixture('sends');
    manifest.session.tempo = [{ tick: 0, bpm: 104 }];
    const engine = new Luna.MockEngine();
    engine.addSession('abc', { name: 'New', tracks: [] });
    const luna = await Luna.connect({ port_: engine.port() });
    const session = await luna.session();
    session.musical.setTempoInEffectAt = async () => { throw new Error('refused'); };
    await expect(logic.importProject(luna, session, manifest, { settleMs: 200 })).rejects.toThrow(/import stopped/);
    expect(session.tracks.items).toHaveLength(0);
  });

  it('sets the starting tempo and reads it back', async () => {
    const manifest = fixture('sends');
    manifest.session.tempo = [{ tick: 0, bpm: 104 }];
    const { session } = await run(manifest);
    expect(session.musical.timeline.tempoAt(0)).toBeCloseTo(104, 3);
  });

  it('does not trust a value only the page shows', async () => {
    const stored = async () => ({ real: 50, display: '50' }); // LUNA ignored the write
    await expect(logic.writeParam(control(50), param, now, stored))
      .resolves.toMatchObject({ retained: false, reason: 'LUNA did not apply the value.' });
  });

  it('writes option parameters by knob position', async () => {
    const key = { name: 'Key', default: 0, saved: 6, min: 0, max: 11, defaultText: 'C', savedText: 'F#' };
    const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
    const c = control(0);
    c.real.set = async () => {}; // what LUNA does with a plain number here
    c.discrete = { value: true };
    c.normalized = { set: async (v) => { c.value = Math.round(v * 11); } };
    c.display = { get value() { return names[c.value]; } };
    await expect(logic.writeParam(c, key, now)).resolves.toMatchObject({ retained: true, lunaValue: 'F#' });
  });

  it('counts a value LUNA already holds as kept', async () => {
    await expect(logic.writeParam(control(80), param, now)).resolves.toMatchObject({ retained: true });
  });

  it('matches plug-ins by exact name and maker only', () => {
    const plugin = { component: ['aumf', 'FPMb', 'FabF'], displayName: 'Pro-MB', manufacturer: 'FabFilter', logicOwn: false };
    const row = (name, sdkType = 'au', manufacturer = 'FabFilter') => ({ name, sdkType, manufacturer, installed: true });
    expect(logic.matchPlugin(plugin, [row('Pro-MB', 'vst3'), row('Pro-MB')]).sdkType).toBe('au');
    expect(logic.matchPlugin(plugin, [row('Pro-Q 4'), row('Pro-MB', 'au', 'Other')])).toBeUndefined();
  });

  it('matches a UADx plug-in by its LUNA id and never by a look-alike title', () => {
    const plugin = {
      component: ['aufx', 'U365', 'UADx'], lunaIds: ['uaudio_la3a'], displayName: 'UADx LA-3A Compressor',
      manufacturer: 'Universal Audio (UADx)', logicOwn: false,
    };
    const hardware = { pluginId: 'com.universal_audio_inc.vst.56AU', name: 'UADx LA-3A Compressor', installed: true };
    const native = { pluginId: 'uaudio_la3a', name: 'LA-3A Compressor', installed: true };
    expect(logic.matchPlugin(plugin, [hardware, native])).toBe(native);
    expect(logic.matchPlugin(plugin, [hardware])).toBeUndefined();
  });

  const withPlugin = () => {
    const manifest = fixture('sends');
    manifest.channels[0].plugins = [
      {
        slot: 1, name: 'x', displayName: 'Pro-MB', manufacturer: 'FabFilter', logicOwn: false,
        component: ['aumf', 'FPMb', 'FabF'], instrument: false, midiEffect: false, bypassed: false, privateState: [],
        params: [
          { id: 1, name: 'Mix <b>', unit: '%', default: 50, saved: 80, modified: true },
          { id: 2, name: 'Untouched', unit: '', default: 1, saved: 1, modified: false },
        ],
      },
      {
        slot: 2, name: 'Compressor', displayName: 'Compressor', logicOwn: true, component: null, instrument: false,
        midiEffect: false, bypassed: false, params: [], savedValues: { threshold: -20 },
      },
    ];
    return manifest;
  };

  it('labels changed parameters MODIFIED when a plug-in is missing', async () => {
    const manifest = withPlugin();
    const { result } = await run(manifest);
    expect(result.plugins[0]).toMatchObject({ loaded: false, status: 'not_loaded' });
    expect(result.plugins[0].params).toEqual([expect.objectContaining({ name: 'Mix <b>', label: 'MODIFIED', retained: false })]);
    const report = reports.build(manifest, result);
    const extended = reports.toMarkdown(report.extended);
    expect(extended).toContain('| Mix <b> | MODIFIED | 80 % | 50 % |');
    expect(extended).not.toContain('Untouched');
    expect(extended).toContain('not labelled MODIFIED or unmodified');
    expect(reports.toMarkdown(report.simplified)).toContain('1 MODIFIED parameter not retained');
    expect(reports.toHtmlBody(report.extended)).toContain('Mix &lt;b&gt;');
  });

  it('does not call settings retained when LUNA loads the plug-in without the parameter', async () => {
    const { result } = await run(withPlugin(), (engine) =>
      engine.addPlugin('com.fabfilter.au.FPMb', { name: 'Pro-MB', manufacturer: 'FabFilter', sdkType: 'au' }));
    expect(result.plugins[0]).toMatchObject({ loaded: true, status: 'not_retained' });
  });

  it('never claims a full match when internal state exists', () => {
    const base = { loaded: true, totalParams: 3, logicOwn: false, params: [{ retained: true }], privateState: ['blob'] };
    expect(logic.pluginStatus(base)).toBe('parameters_only');
    expect(logic.pluginStatus({ ...base, privateState: [] })).toBe('retained');
  });
});
