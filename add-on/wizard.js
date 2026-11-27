// The helper's client and the rules for which step is open. No DOM and no SDK here.

const Wizard = (() => {
  // Where LUNA installs this Add On (the folder is named by the manifest's package_name).
  const INSTALLER_PATH = '/Library/Application Support/Universal Audio/LUNA/Add Ons/Logic Importer/helper-installer/Logic Importer Helper.pkg';

  /**
   * Talks to the helper on this Mac. `source` is { port, token } from helper-config.js, or a
   * function returning it, because installing the helper rewrites that file while we are open.
   */
  function helperClient(source, fetcher = (...a) => fetch(...a)) {
    async function call(method, path, raw = false) {
      const config = typeof source === 'function' ? source() : source;
      if (!config?.token) throw Object.assign(new Error('The helper has not been set up on this Mac yet.'), { offline: true });
      let reply;
      try {
        reply = await fetcher(`http://127.0.0.1:${config.port}${path}`, { method, headers: { 'X-Importer-Token': config.token } });
      } catch {
        throw Object.assign(new Error('The helper is not running.'), { offline: true });
      }
      if (raw && reply.ok) return reply.text();
      const body = await reply.json().catch(() => ({}));
      if (!reply.ok) throw new Error(body.error ?? `The helper answered ${reply.status}.`);
      return body;
    }
    return {
      status: () => call('GET', '/status'),
      pick: (kind) => call('POST', `/pick/${kind}`),
      startExport: () => call('POST', '/export'),
      manifest: () => call('GET', '/manifest', true),
      revealExport: () => call('POST', '/reveal-export'),
    };
  }

  /** Poll until the export ends. Resolves with the final status or throws its error. */
  async function waitForExport(helper, onMessage, { pollMs = 700 } = {}) {
    for (;;) {
      const s = await helper.status();
      if (s.messages?.length) onMessage(s.messages[s.messages.length - 1]);
      if (s.status === 'done') return s;
      if (s.status === 'failed') throw new Error(s.error ?? 'The export failed.');
      if (s.status !== 'running') throw new Error('The helper restarted and the export was lost. Export again.');
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /**
   * The answer to "Did you install the helper?". Yes only counts when the helper answers.
   * `probe` reloads the config and asks the helper for its status.
   */
  async function answerInstalled(yes, probe, { tries = 5, pauseMs = 1000 } = {}) {
    if (!yes) {
      return { confirmed: false, message: 'Install it first: click "Get the helper installer", follow the steps above, then click Yes.' };
    }
    let last;
    for (let i = 0; i < tries; i += 1) {
      try {
        return { confirmed: true, status: await probe(), message: '' };
      } catch (e) {
        last = e;
        if (i + 1 < tries) await new Promise((r) => setTimeout(r, pauseMs));
      }
    }
    return {
      confirmed: false,
      message: `The helper cannot be reached yet. ${last.message} Check that the installer said it finished. ` +
        'Then close and reopen this window and click Yes again. If that fails, restart your Mac.',
    };
  }

  /** Which controls are usable, from what has happened so far. */
  function view(s) {
    const exported = Boolean(s.manifest);
    const idle = !s.exporting && !s.importing;
    const ready = s.helperConfirmed && s.helperOnline;
    return {
      steps: [
        ready ? 'done' : 'active',
        exported ? 'done' : ready ? 'active' : 'locked',
        !exported ? 'locked' : s.imported ? 'done' : 'active',
        s.hasReport ? 'active' : 'locked',
      ],
      helperInstalled: ready,
      pickProject: idle && ready,
      export: idle && ready && Boolean(s.project) && !exported,
      pickOutput: idle && exported && s.helperOnline,
      sessionName: idle && exported,
      import: idle && exported && !s.imported && s.lunaConnected && Boolean(s.sessionName?.trim()) &&
        // Without the helper there is no picker: LUNA's default folder is used.
        (Boolean(s.outputFolder) || !s.helperOnline),
    };
  }

  return { INSTALLER_PATH, helperClient, waitForExport, answerInstalled, view };
})();

globalThis.Wizard = Wizard;
