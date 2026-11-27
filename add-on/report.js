// The two final reports. Both are built as plain blocks, so the page, the saved HTML file and
// the copied text always say the same thing. No DOM and no SDK here.

const ImportReport = (() => {
  const show = (v) => {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'number') return String(Number(v.toPrecision(6)));
    return typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  const withUnit = (v, unit) => (typeof v === 'number' && unit ? `${show(v)} ${unit}` : show(v));
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const lostCount = (p) => p.params.filter((x) => !x.retained).length;

  /** One plain sentence on what happened to a plug-in's settings. */
  function pluginVerdict(p) {
    const changed = p.params.length;
    const lost = lostCount(p);
    switch (p.status) {
      case 'not_loaded':
        return `NOT LOADED. ${p.reason ?? ''}` +
          (changed ? ` ${plural(changed, 'MODIFIED parameter')} not retained.` : ' Settings were not retained.');
      case 'retained':
        return changed ? `All ${plural(changed, 'modified parameter')} retained.`
          : 'No parameters differ from the default in Logic, so none were copied.';
      case 'parameters_only':
        return (changed ? `All ${plural(changed, 'modified parameter')} retained. ` : 'No exposed parameters differ from the default. ') +
          'The plug-in also has internal settings that were NOT copied or checked.';
      case 'partial':
      case 'not_retained':
        return `${lost} of ${plural(changed, 'MODIFIED parameter')} NOT retained.`;
      default:
        return `Loaded, but its settings could not be compared or retained. ${p.paramError ?? ''}`;
    }
  }

  const needsAttention = (p) => !['retained'].includes(p.status);

  function headline(result) {
    const lost = result.plugins.reduce((n, p) => n + lostCount(p), 0);
    const missing = result.log.filter((l) => l.status === 'not_transferred').length;
    const approx = result.log.filter((l) => l.status === 'approximated').length;
    const plugins = result.plugins.filter(needsAttention).length;
    return `This is not a verified exact copy. ${plural(missing, 'item')} not transferred, ${approx} approximated, ` +
      `${plural(plugins, 'plug-in')} to check, ${plural(lost, 'MODIFIED plug-in parameter')} not retained.`;
  }

  function countTable(result) {
    return {
      type: 'table', head: ['What', 'Done', 'In Logic project'],
      rows: Object.entries(result.counts).map(([k, v]) => [k, String(v.copied), String(v.total)]),
    };
  }

  /** What the user still has to do or check by hand, most important first. */
  function actions(result) {
    const rows = [];
    const add = (kind, channel, what) => rows.push([kind, channel ?? 'Whole session', what]);
    const sidechain = /side-chain/i;
    for (const l of result.log.filter((x) => sidechain.test(x.item))) add('Assign side-chain', l.channel, `${l.item}: ${l.detail}`);
    for (const p of result.plugins) {
      if (!p.loaded) add('Replace missing plug-in', p.channel, `${p.name} (insert ${p.slot}). ${p.reason ?? ''}`);
      else if (lostCount(p)) {
        add('Set plug-in values', p.channel, `${p.name}: ${p.params.filter((x) => !x.retained)
          .map((x) => `${x.name} → ${show(x.logic)}`).join('; ')}`);
      } else if (p.status === 'unknown') add('Check plug-in settings', p.channel, `${p.name}: its settings could not be compared.`);
    }
    // A missed color is cosmetic: it is listed in the Not transferred section, not as a to-do.
    for (const l of result.log.filter((x) => x.status === 'not_transferred' && !sidechain.test(x.item) && x.item !== 'Track color')) {
      add('Not transferred', l.channel, `${l.item}: ${l.detail}`);
    }
    for (const l of result.log.filter((x) => x.status === 'approximated')) add('Check by ear', l.channel, `${l.item}: ${l.detail}`);
    return rows;
  }

  function actionBlocks(result) {
    const rows = actions(result);
    return [
      { type: 'h2', text: `To do or check by hand (${rows.length})` },
      rows.length ? { type: 'table', head: ['Action', 'Channel', 'Details'], rows }
        : { type: 'p', text: 'The importer found nothing that needs a manual step. Still compare the two mixes by ear.' },
    ];
  }

  function simplified(manifest, result) {
    const blocks = [
      { type: 'h1', text: `Import report: ${manifest.session.name}` },
      { type: 'p', text: headline(result) },
      ...actionBlocks(result),
      { type: 'h2', text: 'What was imported' },
      countTable(result),
      { type: 'p', text: '"Done" means LUNA accepted the step. It does not mean it sounds the same: listen and compare.' },
    ];
    if (result.plugins.length) {
      blocks.push({ type: 'h2', text: 'Plug-ins' }, {
        type: 'table', head: ['Channel', 'Plug-in', 'Result'],
        rows: result.plugins.map((p) => [p.channel, p.name, pluginVerdict(p)]),
      });
    }
    // Everything else that was lost, grouped by channel so the list stays short.
    const lost = new Map();
    for (const l of result.log.filter((x) => x.status === 'not_transferred')) {
      const key = l.channel ?? 'Whole session';
      if (!lost.has(key)) lost.set(key, new Set());
      lost.get(key).add(l.item);
    }
    if (lost.size) {
      blocks.push({ type: 'h2', text: 'Not transferred' }, {
        type: 'table', head: ['Channel', 'Items'],
        rows: [...lost].map(([channel, items]) => {
          const list = [...items];
          return [channel, list.slice(0, 5).join('; ') + (list.length > 5 ? `; and ${list.length - 5} more` : '')];
        }),
      });
    }
    blocks.push({ type: 'p', text: `The converter does not check: ${(manifest.notChecked ?? []).join(', ')}.` });
    return blocks;
  }

  function pluginBlocks(p) {
    const blocks = [
      { type: 'h3', text: `${p.channel} · insert ${p.slot} · ${p.name}${p.manufacturer ? ` (${p.manufacturer})` : ''}` },
      { type: 'p', text: pluginVerdict(p) },
    ];
    const facts = [];
    if (p.loadedAs) facts.push(`Loaded in LUNA as ${p.loadedAs}.`);
    if (p.preset) facts.push(`Logic preset name: ${p.preset}.`);
    if (p.bypassed) facts.push('Bypassed in Logic.');
    if (p.paramError) facts.push(`Settings reader: ${p.paramError}`);
    if (p.privateState.length) facts.push(`Internal settings not exposed as parameters (not compared): ${p.privateState.join(', ')}.`);
    if (!p.logicOwn && p.totalParams) {
      facts.push(`${p.totalParams} parameters compared; ${p.params.length} differ from the plug-in's default.`);
    }
    if (facts.length) blocks.push({ type: 'p', text: facts.join(' ') });
    if (p.params.length) {
      blocks.push({
        type: 'table', head: ['Parameter', 'Label', 'Logic value', 'Plug-in default', 'LUNA shows', 'Result'],
        rows: p.params.map((x) => [
          x.name, x.label, withUnit(x.logic, x.unit), withUnit(x.default, x.unit), show(x.luna),
          x.retained ? 'Retained' : `NOT retained. ${x.reason ?? ''}`,
        ]),
      });
    }
    if (p.logicOwn) {
      const saved = Object.entries(p.savedValues ?? {});
      blocks.push({
        type: 'p', text: saved.length
          ? "Values read from the Logic project. The defaults of Logic's own plug-ins are not known to this importer, so these are not labelled MODIFIED or unmodified:"
          : "This importer could not read this Logic plug-in's settings. Open the Logic project to see them.",
      });
      if (saved.length) blocks.push({ type: 'table', head: ['Setting', 'Logic value'], rows: saved.map(([k, v]) => [k, show(v)]) });
    }
    return blocks;
  }

  function extended(manifest, result) {
    const s = manifest.session;
    const names = new Map(manifest.channels.map((c) => [c.id, c.name]));
    const destination = (id) => (id === 'master' ? 'Master' : names.get(id) ?? '—');
    const blocks = [
      { type: 'h1', text: `Extended import report: ${s.name}` },
      { type: 'p', text: headline(result) },
      { type: 'p', text: `Saved by ${show(s.logicVersion)}. Sample rate ${show(s.sampleRate)} Hz. Tempo changes: ${s.tempo.length}. Markers: ${s.markers.length}.` },
      countTable(result),
      { type: 'h2', text: 'Channels as read from Logic' },
      {
        type: 'table', head: ['Channel', 'Type', 'Inside', 'Output', 'Fader dB', 'Pan (-1..1)', 'Sends', 'Audio / MIDI / automation'],
        rows: manifest.channels.map((c) => [
          c.name, c.kind, c.parent == null ? '—' : destination(c.parent), c.output == null ? '—' : destination(c.output),
          c.gainDb === -144 ? '-∞' : show(c.gainDb), show(c.pan),
          c.sends.map((x) => `${destination(x.target)} ${x.gainDb === -144 ? '-∞' : show(x.gainDb)}`).join('; ') || '—',
          `${c.audio.length} / ${c.midi.length} / ${c.automation.length}`,
        ]),
      },
      { type: 'h2', text: 'Plug-ins and their settings' },
    ];
    if (!result.plugins.length) blocks.push({ type: 'p', text: 'The converter found no plug-ins.' });
    for (const p of result.plugins) blocks.push(...pluginBlocks(p));
    const titles = { not_transferred: 'Not transferred', approximated: 'Approximated', warning: 'Warnings' };
    for (const [status, title] of Object.entries(titles)) {
      const rows = result.log.filter((l) => l.status === status);
      if (!rows.length) continue;
      blocks.push({ type: 'h2', text: `${title} (${rows.length})` }, {
        type: 'table', head: ['Channel', 'Item', 'Details'],
        rows: rows.map((l) => [l.channel ?? 'Whole session', l.item, l.detail]),
      });
    }
    blocks.push(
      { type: 'h2', text: 'Not checked by the converter' },
      { type: 'p', text: `${(manifest.notChecked ?? []).join(', ')}. If the project uses any of these, compare them by hand.` },
    );
    return blocks;
  }

  function build(manifest, result) {
    return { name: manifest.session.name, simplified: simplified(manifest, result), extended: extended(manifest, result) };
  }

  function toMarkdown(blocks) {
    const cell = (v) => String(v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    return blocks.map((b) => {
      if (b.type === 'table') {
        return [b.head, b.head.map(() => '---'), ...b.rows].map((r) => `| ${r.map(cell).join(' | ')} |`).join('\n');
      }
      const mark = { h1: '# ', h2: '## ', h3: '### ' }[b.type] ?? '';
      return mark + b.text;
    }).join('\n\n') + '\n';
  }

  // Every name comes from the user's project, so everything is escaped.
  const escape = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toHtmlBody(blocks) {
    return blocks.map((b) => {
      if (b.type === 'table') {
        const row = (r, tag) => `<tr>${r.map((v) => `<${tag}${v === 'MODIFIED' ? ' class="modified"' : ''}>${escape(v)}</${tag}>`).join('')}</tr>`;
        return `<div class="scroll"><table><thead>${row(b.head, 'th')}</thead><tbody>${b.rows.map((r) => row(r, 'td')).join('')}</tbody></table></div>`;
      }
      return `<${b.type}>${escape(b.text)}</${b.type}>`;
    }).join('\n');
  }

  function toHtmlFile(report) {
    return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(report.name)}: import report</title>
<style>body{font:14px -apple-system,Helvetica,sans-serif;margin:24px;color:#111}table{border-collapse:collapse;margin:8px 0 16px}th,td{border:1px solid #ccc;padding:4px 8px;text-align:left;vertical-align:top}.modified{font-weight:700;background:#ffe8a3}details{margin-top:32px}summary{font-size:18px;font-weight:600;cursor:pointer}</style>
${toHtmlBody(report.simplified)}
<details><summary>Extended version</summary>${toHtmlBody(report.extended)}</details></html>`;
  }

  return { build, actions, pluginVerdict, toMarkdown, toHtmlBody, toHtmlFile };
})();

globalThis.ImportReport = ImportReport;
