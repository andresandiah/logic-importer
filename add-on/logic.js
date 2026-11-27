// Logic Importer: builds a LUNA session from a converter file. No DOM here.
// Rule for every step: say "copied" only when LUNA accepted it (and, for values, reads back
// the same). Anything else goes into the log, which the report is made from.

const AddOnLogic = (() => {
  const FORMAT = 'logic-to-luna/1';

  function parseManifest(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch {
      throw new Error('This file is not a converter file (it is not valid JSON).');
    }
    if (m?.format !== FORMAT || !Array.isArray(m.channels) || !m.session) {
      throw new Error('This is not a Logic Importer file. Choose the .lunaimport.json made by the converter.');
    }
    return m;
  }

  function summarize(m) {
    const count = (fn) => m.channels.reduce((n, c) => n + fn(c), 0);
    return {
      name: m.session.name,
      tracks: m.channels.filter((c) => ['audio', 'instrument'].includes(c.kind)).length,
      summing: m.channels.filter((c) => c.kind === 'summing').length,
      folders: m.channels.filter((c) => c.kind === 'folder').length,
      buses: m.channels.filter((c) => c.kind === 'bus').length,
      plugins: count((c) => c.plugins.length),
      audio: count((c) => c.audio.length),
      midi: count((c) => c.midi.length),
      automation: count((c) => c.automation.length),
    };
  }

  const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const message = (e) => e?.message ?? String(e);
  const close = (a, b, tolerance) => Math.abs(a - b) <= tolerance;

  // ------------------------------------------------------------------ plug-ins

  const FORMAT_RANK = { au: 0, uadx: 1, vst3: 2, vst: 3 };

  /** The LUNA plug-in for a Logic Audio Unit, or undefined. Exact names only: no guessing. */
  function matchPlugin(plugin, catalog) {
    if (plugin.logicOwn || !plugin.component) return undefined;
    // An id that identifies this very Audio Unit beats any comparison of titles.
    for (const id of plugin.lunaIds ?? []) {
      const exact = catalog.find((c) => c.pluginId === id && c.installed !== false);
      if (exact) return exact;
    }
    // A UADx plug-in has a look-alike hardware UAD version: never take one by title.
    if (plugin.component[2] === 'UADx') return undefined;
    const wanted = norm(plugin.displayName);
    const maker = norm(plugin.manufacturer);
    const rows = catalog.filter((c) => {
      if (c.installed === false) return false;
      const name = norm(c.name);
      if (name !== wanted && name !== maker + wanted) return false;
      const other = norm(c.manufacturer);
      return !maker || !other || other.includes(maker) || maker.includes(other);
    });
    rows.sort((a, b) => (FORMAT_RANK[a.sdkType] ?? 9) - (FORMAT_RANK[b.sdkType] ?? 9));
    return rows[0];
  }

  /** The one LUNA parameter with this name, or undefined when none or several have it. */
  function matchParam(controls, name) {
    const hits = controls.filter((c) => norm(c.name.value) === norm(name));
    return hits.length === 1 ? hits[0] : undefined;
  }

  const numeric = (v) => (typeof v === 'boolean' ? Number(v) : v);

  /** What the page itself shows. Only for tests: importProject reads from LUNA instead. */
  const localState = async (control) => ({ real: control.real.value, display: control.display.value });

  /** Poll `read` until `ok(state)`; returns the last state and whether it matched. */
  async function confirm(read, control, ok, wait) {
    let state;
    try {
      await wait(async () => { state = await read(control); if (!ok(state)) throw new Error('not yet'); return true; });
      return { matched: true, state };
    } catch {
      return { matched: false, state: state ?? (await read(control)) };
    }
  }

  const sameText = (a, b) => a != null && b != null &&
    String(a).replace(/\s+/g, '').toLowerCase() === String(b).replace(/\s+/g, '').toLowerCase();

  /**
   * Copy one changed Audio Unit parameter into LUNA and prove it arrived.
   * - `read` must ask LUNA, not the page: the SDK shows a written value before LUNA accepts
   *   it, and LUNA silently ignores some writes.
   * - Numbers are only trusted when LUNA starts at the Audio Unit's default number. Otherwise
   *   (UADx) LUNA must start at the default's text and end at exactly Logic's text.
   * - Option and switch parameters are written by knob position, which LUNA honours.
   */
  async function writeParam(control, param, wait, read = localState) {
    if (!control) return { retained: false, reason: 'LUNA has no single parameter with this name.' };
    const { min, max, saved, savedText, defaultText } = param;
    if (param.default === undefined) return { retained: false, reason: 'The plug-in reported no default to compare units with.' };
    const span = max !== undefined ? Math.abs(max - min) : 1;
    const tolerance = Math.max(span * 0.002, 1e-4);
    const atNumber = (st, target) => close(numeric(st.real), target, tolerance);
    const before = await read(control);
    const shown = (st) => st.display || st.real;

    // Some plug-ins (tempo-synced delays) already load with Logic's value.
    const textDecides = savedText != null && Boolean(before.display);
    if (textDecides ? sameText(before.display, savedText) : atNumber(before, saved)) {
      return { retained: true, otherScale: !atNumber(before, saved), lunaValue: shown(before) };
    }

    const position = max > min ? Math.min(1, Math.max(0, (saved - min) / (max - min))) : undefined;
    const sameNumbers = atNumber(before, param.default);
    let write;
    let matches;
    let otherScale = false;
    if (sameNumbers) {
      const isSwitch = typeof before.real === 'boolean';
      const stepped = control.discrete?.value && position !== undefined && control.normalized;
      write = () => (stepped ? control.normalized.set(position) : control.real.set(isSwitch ? saved >= 0.5 : saved));
      // A named option must also show the same name (option order can differ between formats).
      matches = (st) => atNumber(st, saved) && (!stepped || !st.display || savedText == null || sameText(st.display, savedText));
    } else if (control.normalized && position !== undefined && savedText != null &&
               !sameText(savedText, defaultText) && sameText(before.display, defaultText)) {
      otherScale = true;
      write = () => control.normalized.set(position);
      matches = (st) => sameText(st.display, savedText);
    } else {
      return { retained: false, lunaValue: shown(before), reason: 'LUNA does not use the same scale or default for this parameter, so it was left alone.' };
    }

    try {
      await write();
    } catch (e) {
      return { retained: false, lunaValue: shown(before), reason: `LUNA refused the value: ${message(e)}` };
    }
    const after = await confirm(read, control, matches, wait);
    if (after.matched) return { retained: true, otherScale, lunaValue: shown(after.state) };
    if (after.state.real === before.real && after.state.display === before.display) {
      return { retained: false, lunaValue: shown(after.state), reason: 'LUNA did not apply the value.' };
    }
    try {
      await control.resetToDefault();
    } catch {
      return { retained: false, lunaValue: shown(after.state), reason: 'LUNA showed a different value and it could not be reset.' };
    }
    return { retained: false, lunaValue: shown(await read(control)), reason: `LUNA showed ${shown(after.state)} instead, so the parameter was reset.` };
  }

  /** The report row for each parameter that differs from the plug-in's default. */
  function changedRow(param, outcome) {
    return {
      id: param.id, name: param.name, unit: param.unit,
      logic: param.savedText ?? param.saved, default: param.defaultText ?? param.default,
      label: 'MODIFIED', retained: outcome.retained, luna: outcome.lunaValue ?? null, reason: outcome.reason ?? null,
    };
  }

  function emptyPluginResult(channel, p) {
    return {
      channel: channel.name, slot: p.slot, name: p.displayName, manufacturer: p.manufacturer,
      logicOwn: p.logicOwn, instrument: p.instrument, preset: p.presetName, loaded: false,
      loadedAs: null, reason: null, bypassed: p.bypassed, paramError: p.paramError,
      privateState: p.privateState ?? [], savedValues: p.savedValues,
      totalParams: p.params.length, params: [], status: 'not_loaded',
    };
  }

  /** The report row for each parameter that differs from the plug-in's default. */
  function changedRow(param, outcome) {
    return {
      id: param.id, name: param.name, unit: param.unit,
      logic: param.savedText ?? param.saved, default: param.defaultText ?? param.default,
      label: 'MODIFIED', retained: outcome.retained, luna: outcome.lunaValue ?? null, reason: outcome.reason ?? null,
    };
  }

  /**
   * One status per plug-in. `retained` is never claimed while the plug-in holds private state
   * that parameters cannot show.
   */
  function pluginStatus(r) {
    if (!r.loaded) return 'not_loaded';
    if (r.paramError || r.logicOwn || !r.totalParams) return 'unknown';
    const lost = r.params.filter((p) => !p.retained).length;
    if (lost) return lost === r.params.length ? 'not_retained' : 'partial';
    return r.privateState.length ? 'parameters_only' : 'retained';
  }

  // ------------------------------------------------------------------ import

  /**
   * Build `session` (a new, empty one) from a manifest.
   * options: { onProgress(text), settleMs, catalog() }
   * Returns { log, plugins, counts } for the report.
   */
  async function importProject(luna, session, manifest, options = {}) {
    const log = [];
    const pluginResults = [];
    const counts = {};
    const progress = options.onProgress ?? (() => {});
    const wait = (predicate) => Luna.settle(predicate, 'value', { timeoutMs: options.settleMs ?? 1500 });
    // Polls a read that has to go to LUNA.
    const retry = async (attempt) => {
      const end = Date.now() + (options.settleMs ?? 1500);
      for (;;) {
        try { return await attempt(); } catch (e) {
          if (Date.now() > end) throw e;
          await new Promise((r) => setTimeout(r, 60));
        }
      }
    };
    /** A control as LUNA holds it, not as the page last showed it. */
    const readLuna = options.readControl ?? (async (control) => {
      const reply = await luna.raw.get(control.path);
      const p = reply?.properties ?? reply ?? {};
      const of = (key) => (p[key] && typeof p[key] === 'object' ? p[key].value : p[key]);
      return { real: of('real_value') ?? of('value'), display: of('string_value') ?? '' };
    });
    const note = (status, channel, item, detail = '') => log.push({ status, channel, item, detail });
    const tally = (key, ok) => {
      counts[key] ??= { copied: 0, total: 0 };
      counts[key].total += 1;
      if (ok) counts[key].copied += 1;
    };
    /** Run one step. A failure is logged and the import carries on. */
    async function step(channel, item, fn, countKey) {
      try {
        await fn();
        if (countKey) tally(countKey, true);
        return true;
      } catch (e) {
        note('not_transferred', channel, item, message(e));
        if (countKey) tally(countKey, false);
        return false;
      }
    }

    for (const n of manifest.notes ?? []) note(n.status, n.channel, n.item, n.detail);
    await session.ready();

    progress('Setting tempo and time signatures');
    const [first, ...later] = manifest.session.tempo;
    // Every region position assumes the Logic tempo, so a wrong starting tempo stops the import.
    if (first) await setStartTempo(session, first.bpm, wait);
    if (first) tally('Tempo changes', true);
    for (const t of later) {
      await step(null, `Tempo ${t.bpm} BPM`, async () => {
        await session.musical.setTempo(t.bpm, t.tick);
        await wait(() => close(session.musical.timeline.tempoAt(t.tick), t.bpm, 0.01));
      }, 'Tempo changes');
    }
    for (const s of manifest.session.signatures) {
      await step(null, `Time signature ${s.numerator}/${s.denominator} at bar ${s.bar}`,
        () => session.musical.setTimeSignature(s.numerator, s.denominator, s.bar), 'Time signatures');
    }

    // ---- tracks, buses, folders (parents first)
    progress('Creating tracks and folders');
    const byId = new Map(manifest.channels.map((c) => [c.id, c]));
    const made = new Map(); // Logic channel id -> LUNA Track or Bus
    const depth = (c, seen = new Set()) => {
      if (c.parent == null || !byId.has(c.parent) || seen.has(c.id)) return 0;
      seen.add(c.id);
      return 1 + depth(byId.get(c.parent), seen);
    };
    const countKeyFor = { audio: 'Audio tracks', instrument: 'Instrument tracks', bus: 'Buses', summing: 'Summing folders', folder: 'Folders' };
    for (const c of [...manifest.channels].sort((a, b) => depth(a) - depth(b) || a.order - b.order)) {
      if (c.kind === 'master') continue;
      if (!countKeyFor[c.kind]) {
        note('not_transferred', c.name, 'Channel', `Logic channel type '${c.label}' is not supported.`);
        continue;
      }
      const folderUid = made.get(c.parent)?.id;
      const stemFormat = c.stereo ? 'stereo' : 'mono';
      await step(c.name, 'Create channel', async () => {
        let channel;
        if (c.kind === 'summing' || c.kind === 'folder') {
          channel = await session.newFolder({ name: c.name, mode: c.kind === 'summing' ? 'summing' : 'container', folderUid });
        } else if (c.kind === 'bus') {
          channel = await session.newBus({ name: c.name });
          if (folderUid) await session.moveToFolder([channel], folderUid);
        } else {
          [channel] = await session.newTrack({
            name: c.name, trackType: c.kind, folderUid, makeNameUnique: true,
            stemFormat: c.kind === 'instrument' ? 'stereo' : stemFormat,
          });
        }
        made.set(c.id, channel);
      }, countKeyFor[c.kind]);
    }
    const masterSource = manifest.channels.find((c) => c.kind === 'master');
    if (masterSource) {
      if (session.master) made.set(masterSource.id, session.master);
      else note('not_transferred', masterSource.name, 'Master channel', 'LUNA reported no master bus.');
    }

    // ---- order inside each folder
    const groups = new Map();
    for (const c of [...manifest.channels].sort((a, b) => a.order - b.order)) {
      if (c.kind === 'master' || !made.has(c.id)) continue;
      const key = made.has(c.parent) ? c.parent : null;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(made.get(c.id));
    }
    for (const items of groups.values()) {
      for (let i = 1; i < items.length; i += 1) {
        const ok = await step(null, 'Track order', () => session.reorder([items[i]], { after: items[i - 1] }));
        if (!ok) break;
      }
    }

    for (const [id, channel] of made) {
      await step(byId.get(id).name, 'Load channel controls', () => channel.loadStrip());
    }

    // ---- routing
    progress('Routing outputs');
    const luaDefault = (c) => {
      for (let p = byId.get(c.parent), n = 0; p && n < 20; p = byId.get(p.parent), n += 1) {
        if (p.kind === 'summing') return p.id;
      }
      return 'master';
    };
    for (const c of manifest.channels) {
      const channel = made.get(c.id);
      if (!channel || c.kind === 'master' || c.kind === 'folder' || c.output == null) continue;
      const automatic = luaDefault(c);
      const wanted = byId.get(c.output)?.kind === 'master' ? 'master' : c.output;
      if (wanted === automatic) {
        tally('Output routings', true); // LUNA routes folder members and new channels this way itself
        continue;
      }
      const target = wanted === 'master' ? session.master : made.get(wanted);
      await step(c.name, `Output to ${wanted === 'master' ? 'master' : byId.get(wanted)?.name}`, async () => {
        if (!target) throw new Error('The destination channel was not created.');
        await channel.main.retarget(target.id);
      }, 'Output routings');
    }

    // ---- mixer
    progress('Setting faders, pan, mute and solo');
    async function setValue(c, item, control, target, tolerance, countKey) {
      await step(c.name, item, async () => {
        if (!control) throw new Error('LUNA has no such control on this channel.');
        if (close(numeric(control.real.value), target, tolerance)) return;
        await control.real.set(target);
        const after = await confirm(readLuna, control, (st) => close(numeric(st.real), target, tolerance), retry);
        if (!after.matched) throw new Error(`LUNA holds ${after.state.display || after.state.real} instead of ${target}.`);
      }, countKey);
    }
    /** Turn a switch on or off and ask LUNA, not the page, whether it happened. */
    async function holdSwitch(control, on, label) {
      const isOn = (st) => Boolean(numeric(st.real));
      if (isOn(await readLuna(control)) !== on) await control.toggle();
      const after = await confirm(readLuna, control, (st) => isOn(st) === on, retry);
      if (!after.matched) throw new Error(`LUNA did not turn ${label} ${on ? 'on' : 'off'}.`);
    }
    async function setSwitch(c, item, control, on) {
      if (!control && !on) return; // buses and folders may lack a switch Logic never turned on
      await step(c.name, `${item} ${on ? 'on' : 'off'}`, async () => {
        if (!control) throw new Error('LUNA has no such control on this channel.');
        await holdSwitch(control, on, item.toLowerCase());
      });
    }
    /** One property of a LUNA object, read from LUNA. */
    async function lunaProperty(path, key) {
      const reply = await luna.raw.get(path);
      const p = (reply?.properties ?? reply ?? {})[key];
      return p && typeof p === 'object' && 'value' in p ? p.value : p;
    }
    for (const c of manifest.channels) {
      const channel = made.get(c.id);
      if (!channel) continue;
      if (c.kind === 'folder') {
        if (Math.abs(c.gainDb ?? 0) > 0.05 || c.pan || c.mute || c.solo) {
          note('not_transferred', c.name, 'Folder stack mixer settings',
            `Logic fader ${c.gainDb} dB, pan ${c.pan}, mute ${c.mute}, solo ${c.solo}. A LUNA grouping folder was left at its defaults; apply these to its tracks.`);
        }
        continue;
      }
      await step(c.name, 'Load controls', () => channel.controls.load());
      if (c.gainDb != null) {
        // -144 stands for Logic's -∞: any LUNA value of -90 dB or lower counts as silent.
        const gain = channel.gain;
        if (c.gainDb <= -144) {
          await step(c.name, 'Fader at -∞', async () => {
            await gain.real.set(-144);
            await wait(() => numeric(gain.real.value) <= -90);
          }, 'Faders');
        } else await setValue(c, `Fader ${c.gainDb} dB`, gain, c.gainDb, 0.15, 'Faders');
      }
      if (c.pan != null) {
        const pans = channel.main.pans.filter(Boolean);
        if (pans.length === 1) {
          await setValue(c, `Pan ${c.pan}`, pans[0], c.pan * 100, 1.5, 'Pan');
        } else if (pans.length === 2 && c.pan !== 0) {
          await setValue(c, 'Left pan', pans[0], -100 + 200 * Math.max(0, c.pan), 1.5);
          await setValue(c, 'Right pan', pans[1], 100 - 200 * Math.max(0, -c.pan), 1.5);
          note('approximated', c.name, 'Stereo balance', `Logic balance ${c.pan} was approximated with LUNA's left and right pans. Check by ear.`);
        } else tally('Pan', pans.length === 2);
      }
      await setSwitch(c, 'Mute', channel.mute, c.mute);
      if (c.kind !== 'master') await setSwitch(c, 'Solo', channel.solo ?? channel.controls.byId('solo'), c.solo);
    }

    // ---- sends
    progress('Creating sends');
    for (const c of manifest.channels) {
      const channel = made.get(c.id);
      if (!channel || !c.sends.length) continue;
      await step(c.name, 'Load sends', () => channel.outputs.load());
      for (const [i, s] of c.sends.entries()) {
        await step(c.name, `Send to ${s.bus}`, async () => {
          const send = channel.outputs.byId(`send_${i}`);
          const target = made.get(s.target);
          if (!send) throw new Error('LUNA has no free send slot for it.');
          if (!target) throw new Error('The destination bus was not created.');
          await send.retarget(target.id);
          let assigned;
          try {
            await retry(async () => {
              assigned = await lunaProperty(send.path, 'assignments');
              if (!(assigned ?? []).some((a) => a.value === target.id)) throw new Error('not yet');
              return true;
            });
          } catch {
            throw new Error('LUNA does not show the send going to that bus.');
          }
          await send.controls.load();
          await send.gain.real.set(s.gainDb);
          const level = await confirm(readLuna, send.gain,
            (st) => (s.gainDb <= -144 ? numeric(st.real) <= -90 : close(numeric(st.real), s.gainDb, 0.15)), retry);
          if (!level.matched) throw new Error(`LUNA holds ${level.state.display || level.state.real} instead of ${s.gainDb} dB.`);
          if (!send.preFader) { if (s.preFader) throw new Error('LUNA has no pre-fader switch for this send.'); }
          else await holdSwitch(send.preFader, Boolean(s.preFader), 'pre-fader');
          if (!send.mute) { if (s.bypassed) throw new Error('LUNA has no mute switch for this send.'); }
          else await holdSwitch(send.mute, Boolean(s.bypassed), 'send mute');
        }, 'Sends');
      }
    }

    // ---- plug-ins
    progress('Loading plug-ins');
    let catalog = [];
    if (manifest.channels.some((c) => c.plugins.length)) {
      await step(null, 'Read the LUNA plug-in list', async () => {
        await luna.plugins.load();
        catalog = luna.plugins.items.map((p) => ({
          pluginId: p.pluginId.value ?? p.id, name: p.name.value, manufacturer: p.manufacturer,
          sdkType: p.sdkType.value, installed: p.installed.value,
        }));
      });
    }
    const paramControls = new Map(); // `${channelId}:${slot}:${paramId}` -> control with a trusted scale
    for (const c of manifest.channels) {
      const channel = made.get(c.id);
      for (const p of c.plugins) {
        const result = emptyPluginResult(c, p);
        pluginResults.push(result);
        progress(`Loading ${p.displayName} on ${c.name}`);
        let slot;
        const row = matchPlugin(p, catalog);
        if (!channel) result.reason = 'Its channel was not created.';
        else if (p.logicOwn) result.reason = "This is one of Logic's own plug-ins, which LUNA cannot load.";
        else if (p.midiEffect) result.reason = 'MIDI effects are not transferred.';
        else if (!row) result.reason = 'No installed LUNA plug-in has the same name and maker.';
        else {
          try {
            if (p.instrument) {
              await channel.effects.load?.();
              slot = channel.effects.byId('instrument');
              if (!slot) throw new Error('This channel has no instrument slot.');
              await slot.setPlugin(row.pluginId, { wait: true });
            } else slot = await channel.insert(row.pluginId);
            if (!slot) throw new Error('There is no free insert slot.');
            await slot.waitForPlugin();
            if (slot.pluginError.value) throw new Error(slot.pluginError.value);
            result.loaded = true;
            result.loadedAs = `${row.name} (${row.sdkType || 'unknown format'})`;
          } catch (e) {
            result.reason = `LUNA could not load it: ${message(e)}`;
          }
        }
        let controls = [];
        if (result.loaded) {
          try {
            await slot.controls.load();
            controls = slot.params;
          } catch (e) {
            result.paramError ??= `LUNA's parameters could not be read: ${message(e)}`;
          }
        }
        for (const param of p.params) {
          const control = result.loaded ? matchParam(controls, param.name) : undefined;
          if (!param.modified) {
            if (control && param.default !== undefined) paramControls.set(`${c.id}:${p.slot}:${param.id}`, { control, param });
            continue;
          }
          const outcome = result.loaded
            ? await writeParam(control, param, retry, readLuna)
            : { retained: false, reason: 'The plug-in was not loaded.' };
          result.params.push(changedRow(param, outcome));
          if (outcome.retained && !outcome.otherScale) paramControls.set(`${c.id}:${p.slot}:${param.id}`, { control, param, verified: true });
        }
        if (result.loaded && p.bypassed) {
          await step(c.name, `Bypass ${p.displayName}`, async () => {
            await slot.setIn(false);
            // LUNA has no "bypassed" property: it is the plug-in's own bypass control, read
            // with a flag that says which value means IN.
            const control = slot.bypass;
            if (!control) throw new Error('LUNA shows no bypass control to confirm it. Bypass it by hand.');
            const activeLow = await lunaProperty(slot.path, 'bypass_control_active_low');
            const bypassed = (st) => {
              const nonzero = Boolean(numeric(st.real));
              return !(activeLow === true ? nonzero : !nonzero);
            };
            const after = await confirm(readLuna, control, bypassed, retry);
            if (!after.matched) throw new Error('LUNA did not confirm the bypass. Bypass it by hand.');
          }, 'Plug-ins bypassed');
        }
        result.status = pluginStatus(result);
        tally('Plug-ins loaded', result.loaded);
      }
    }

    // ---- audio
    progress('Importing audio');
    const sources = new Map();
    for (const c of manifest.channels) {
      const track = made.get(c.id);
      for (const r of c.audio) {
        await step(c.name, `Audio region '${r.name}'`, async () => {
          if (!track) throw new Error('Its track was not created.');
          if (!sources.has(r.file)) sources.set(r.file, session.importPath(r.file));
          const source = await sources.get(r.file);
          const clip = await session.insertClip({
            trackUid: track.id, sourceUid: source.id, name: r.name, startTick: r.start, stopTick: r.stop,
            sourceStartNs: r.sourceStartNs, sourceStopNs: r.sourceStopNs, lengthFollows: 'time',
          });
          if (r.gainDb) {
            await step(c.name, `Region gain ${r.gainDb} dB on '${r.name}' (set it by hand)`,
              () => setClipGain(luna, session, clip, r.gainDb, retry), 'Region gains');
          }
          if (r.muted) await clip.setMuted(true);
          if (r.fadeIn) await step(c.name, `Fade-in on '${r.name}'`, () => clip.setFadeIn(r.fadeIn));
          if (r.fadeOut) await step(c.name, `Fade-out on '${r.name}'`, () => clip.setFadeOut(r.fadeOut));
        }, 'Audio regions');
      }
    }

    // ---- MIDI
    progress('Writing MIDI');
    for (const c of manifest.channels) {
      const track = made.get(c.id);
      for (const r of [...c.midi].sort((a, b) => a.start - b.start)) {
        if (!r.notes.length && !r.events.length) {
          note('not_transferred', c.name, `MIDI region '${r.name}'`, 'The region plays no notes or controller data.');
          continue;
        }
        await step(c.name, `MIDI region '${r.name}'`, async () => {
          if (!track) throw new Error('Its track was not created.');
          const lane = await playlistOf(session, track);
          // LUNA only makes a MIDI clip by writing a note: write a throwaway one, size the
          // clip to the region, add the real data, then delete the throwaway.
          const { clip, notes: placeholder } = await lane.createNotes([
            { pitch: 0, startTick: r.start, stopTick: r.start + Math.min(r.stop - r.start, 1_000_000_000), velocity: 1 },
          ]);
          await clip.trim(r.start, r.stop);
          await clip.midi.ready();
          if (r.notes.length) {
            await clip.addNotes(r.notes.map((n) => ({
              pitch: n.pitch, tick: n.tick, lengthTicks: n.length, velocity: n.velocity, channel: n.channel,
            })));
          }
          if (r.events.length) {
            await clip.addMidi(r.events.map((e) => ({
              tick: e.tick, status: e.status, data1: e.data1, ...(e.data2 == null ? {} : { data2: e.data2 }),
            })));
          }
          await clip.midi.deleteNotes(placeholder);
          if (r.muted) await clip.setMuted(true);
          await clip.midi.refresh();
          await wait(() => clip.midi.notes.items.length >= r.notes.length).catch(() => {
            throw new Error(`LUNA shows ${clip.midi.notes.items.length} of ${r.notes.length} notes.`);
          });
          if (r.events.length) {
            note('approximated', c.name, `MIDI region '${r.name}'`,
              `${r.events.length} controller, program or pitch bend event(s) were sent to LUNA but not read back. Check them.`);
          }
        }, 'MIDI regions');
      }
    }

    // ---- markers
    for (const m of manifest.session.markers) {
      await step(null, `Marker '${m.name}'`, () => session.addMarker(m.tick, m.name), 'Markers');
    }

    // ---- automation (last, so it is not disturbed by the writes above)
    progress('Writing automation');
    for (const c of manifest.channels) {
      const channel = made.get(c.id);
      for (const lane of c.automation) {
        await step(c.name, `${lane.label} automation`, async () => {
          if (!channel || c.kind === 'folder') throw new Error('There is no LUNA channel that can carry it.');
          let control;
          let scale = (v) => v;
          if (lane.target === 'volume') control = channel.gain;
          else if (lane.target === 'mute') control = channel.mute;
          else if (lane.target === 'pan') {
            const pans = channel.main.pans.filter(Boolean);
            if (pans.length !== 1) throw new Error('Balance automation on a stereo channel is not transferred.');
            [control] = pans;
            scale = (v) => v * 100;
          } else {
            const found = paramControls.get(`${c.id}:${lane.slot}:${lane.paramId}`);
            if (!found) throw new Error('Its plug-in parameter was not matched to a LUNA parameter with the same scale.');
            const { control: candidate, param, verified } = found;
            const span = Math.abs((param.max ?? 1) - (param.min ?? 0));
            if (!verified && !close(numeric(candidate.real.value), param.default, Math.max(span * 0.002, 1e-4))) {
              throw new Error('LUNA does not use the same scale for this parameter.');
            }
            control = candidate;
          }
          if (!control) throw new Error('LUNA has no such control on this channel.');
          await control.automation.insert(lane.points.map((p) => ({ tick: p.tick, value: scale(p.value) })));
          note('approximated', c.name, `${lane.label} automation`,
            `${lane.points.length} points written. The curve between points may differ from Logic.`);
        }, 'Automation lanes');
      }
      if (channel && c.automation.length) {
        await step(c.name, 'Set automation mode to Read', () => channel.setAutomationMode('read'));
      }
    }

    if (manifest.session.sampleRate) {
      note('warning', null, 'Sample rate', `The Logic project is ${manifest.session.sampleRate} Hz. Check the LUNA session's sample rate.`);
    }
    note('not_transferred', null, 'Track colours', 'Colours are not transferred.');
    progress('Done');
    return { log, plugins: pluginResults, counts };
  }

  /** Change the tempo already at the session start (LUNA refuses to add a second one there). */
  async function setStartTempo(session, bpm, wait) {
    try {
      await session.musical.ready();
      await session.musical.setTempoInEffectAt(bpm, 0);
      await wait(() => close(session.musical.timeline.tempoAt(0), bpm, 0.01));
    } catch (e) {
      throw new Error(`LUNA's tempo could not be set to ${bpm} BPM (${message(e)}). ` +
        'The import stopped because clips would be placed wrongly.');
    }
  }

  /**
   * Give a clip a fixed gain by putting one point at its start on the clip's gain lane (it
   * holds across the whole clip). Measured on LUNA 3.1.2 with exported audio:
   *  - clip.gain changes only an old field and has no effect on the sound;
   *  - a plain write to the gain control is not picked up by the audio engine when made;
   *  - set_touch on a clip's gain control CRASHES LUNA. Never touch it;
   *  - insert_bp changes the sound by exactly the requested amount.
   * A clip that already has gain points is left alone (points would stack).
   */
  async function setClipGain(luna, session, clip, dB, wait) {
    const gainPath = `${clip.path}/controls/gain`;
    const properties = (reply) => reply?.properties ?? reply ?? {};
    const points = async () => {
      const lane = await luna.raw.get(`${gainPath}/automation`, { levels: 2 });
      return (lane?.children ?? []).map((n) => ({ tick: n.properties?.start?.value, value: n.properties?.value?.value }));
    };
    let uid;
    await wait(async () => {
      uid = properties(await luna.raw.get(gainPath)).uid?.value;
      if (!uid) throw new Error("LUNA has not published the clip's gain control.");
      return true;
    });
    if ((await points()).length) throw new Error('The clip already has gain points, so it was left alone.');
    await luna.raw.post(`/sessions/${session.uid}/insert_bp`, {
      session_uid: session.uid, control_uid: uid, values: [{ location: 0, value: Luna.float(dB) }],
    });
    let held = [];
    try {
      await wait(async () => {
        held = await points();
        if (held.length !== 1 || held[0].tick !== 0 || !close(Number(held[0].value), dB, 0.05)) throw new Error('not yet');
        return true;
      });
    } catch {
      throw new Error(`LUNA's clip gain lane holds ${JSON.stringify(held)} instead of ${dB} dB.`);
    }
  }

  /**
   * Create the new session. LUNA can take longer to answer than the SDK waits, so a timeout
   * is not a failure yet: watch for the session to appear before giving up.
   */
  async function createSession(luna, { name, directoryPath }, { waitMs = 90_000, pollMs = 500 } = {}) {
    const listed = () => luna.sessions.items.items;
    const before = new Set(listed().map((s) => s.uid ?? s.id));
    try {
      return await luna.sessions.create({ name, timeoutMs: waitMs, ...(directoryPath ? { directoryPath } : {}) });
    } catch (error) {
      if (error?.code !== 'timeout') throw error;
      const end = Date.now() + waitMs;
      for (;;) {
        const fresh = listed().filter((s) => !before.has(s.uid ?? s.id) && s.name?.value === name);
        if (fresh.length === 1) return fresh[0];
        if (Date.now() > end) throw error;
        await new Promise((r) => setTimeout(r, pollMs));
      }
    }
  }

  /** The track's active playlist, waiting for LUNA to publish it. */
  async function playlistOf(session, track) {
    await Luna.settle(() => session.playlistFor(track), 'the track playlist', {
      timeoutMs: 5000, refresh: () => track.load(),
    });
    return session.playlistFor(track);
  }

  return { FORMAT, parseManifest, summarize, matchPlugin, matchParam, writeParam, setClipGain, createSession, pluginStatus, importProject };
})();

globalThis.AddOnLogic = AddOnLogic;
