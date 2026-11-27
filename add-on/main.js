// Logic Importer: page wiring for the three steps. logic.js imports, report.js writes the
// reports, wizard.js talks to the helper and decides which step is open.

const $ = (id) => document.getElementById(id);
const STORE = 'com.logicimporter.addon:last-report';
const CONFIRMED = 'com.logicimporter.addon:helper-confirmed';
const helper = Wizard.helperClient(() => window.LOGIC_IMPORTER_HELPER);
let installation;
const state = {
  helperConfirmed: false, helperOnline: false, lunaConnected: false, project: null, manifest: null, outputFolder: null,
  sessionName: '', exporting: false, importing: false, imported: false, hasReport: false,
};
let luna;
let report;
let mode = 'simplified';

const setStatus = (text) => { $('status').textContent = text; };

function paint() {
  const v = Wizard.view(state);
  v.steps.forEach((name, i) => { $(`step${i + 1}`).className = `step ${name}`; });
  $('installHow').hidden = v.helperInstalled;
  $('installDone').hidden = !v.helperInstalled;
  $('installLocation').hidden = !installation;
  $('helperFolder').textContent = installation?.folder ?? '';
  $('helperAgent').textContent = installation?.launchAgent ?? '';
  $('pickProject').disabled = $('pickProjectFolder').disabled = !v.pickProject;
  for (const id of ['export', 'pickOutput', 'sessionName', 'import']) $(id).disabled = !v[id];
  $('projectPath').textContent = state.project ?? '';
  $('outputPath').textContent = state.outputFolder ?? '';
}

/** Read helper-config.js again: the installed helper writes it after this page has loaded. */
function reloadConfig() {
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = `helper-config.js?t=${Date.now()}`;
    script.onload = script.onerror = () => { script.remove(); resolve(); };
    document.body.appendChild(script);
  });
}

async function probeHelper() {
  await reloadConfig();
  const status = await helper.status();
  state.helperOnline = true;
  installation = status.installation ?? undefined;
  return status;
}

async function checkHelper() {
  if (state.exporting) return;
  try {
    await probeHelper();
    if (state.helperConfirmed) $('installMessage').textContent = '';
  } catch (e) {
    state.helperOnline = false;
    if (state.helperConfirmed) {
      $('installMessage').textContent = `${e.message} Restart your Mac, or run the installer again.`;
    }
  }
  paint();
}

async function answerInstalled(yes) {
  $('helperYes').disabled = $('helperNo').disabled = true;
  $('installMessage').textContent = yes ? 'Looking for the helper…' : '';
  const answer = await Wizard.answerInstalled(yes, probeHelper);
  state.helperConfirmed = answer.confirmed;
  try {
    if (answer.confirmed) localStorage.setItem(CONFIRMED, 'yes');
    else localStorage.removeItem(CONFIRMED);
  } catch { /* the question is simply asked again next time */ }
  $('installMessage').textContent = answer.message;
  $('helperYes').disabled = $('helperNo').disabled = false;
  paint();
}

async function showInFinder(path) {
  try {
    if (!(await luna.gui.available())) throw new Error('unavailable');
    await luna.gui.revealPath(path);
  } catch {
    $('installerPath').textContent = path;
    $('installerFallback').hidden = false;
  }
}

async function getInstaller() {
  // The path is always shown too, in case Finder opens behind LUNA or not at all.
  $('installerPath').textContent = Wizard.INSTALLER_PATH;
  $('installerFallback').hidden = false;
  await showInFinder(Wizard.INSTALLER_PATH);
}

function useManifest(text, exportFolder) {
  state.manifest = AddOnLogic.parseManifest(text);
  state.imported = false;
  const s = AddOnLogic.summarize(state.manifest);
  $('summary').textContent =
    `${s.name}: ${s.tracks} tracks, ${s.summing} summing folders, ${s.folders} grouping folders, ${s.buses} buses, ` +
    `${s.plugins} plug-ins, ${s.audio} audio regions, ${s.midi} MIDI regions, ${s.automation} automation lanes.`;
  $('exportDone').hidden = false;
  $('exportNote').hidden = !exportFolder;
  $('exportFolder').textContent = exportFolder ?? '';
  state.sessionName = `${s.name} (from Logic)`;
  $('sessionName').value = state.sessionName;
  paint();
}

function forgetExport() {
  state.manifest = null;
  state.imported = false;
  $('exportDone').hidden = true;
  $('exportProgress').textContent = $('importProgress').textContent = '';
  $('exportError').textContent = $('importError').textContent = '';
}

async function pickProject(kind) {
  $('exportError').textContent = '';
  setStatus('Choose in the macOS window (it may open behind LUNA)');
  try {
    const reply = await helper.pick(kind);
    if (!reply.cancelled) {
      forgetExport();
      state.project = reply.path;
    }
  } catch (e) {
    $('exportError').textContent = e.message;
  }
  setStatus(state.lunaConnected ? 'Connected to LUNA' : 'Waiting for LUNA…');
  paint();
}

async function runExport() {
  if (state.exporting) return;
  state.exporting = true;
  $('exportError').textContent = '';
  paint();
  try {
    await helper.startExport();
    const done = await Wizard.waitForExport(helper, (m) => { $('exportProgress').textContent = m; });
    useManifest(await helper.manifest(), done.exportFolder);
    $('exportProgress').textContent = 'Export finished.';
  } catch (e) {
    $('exportProgress').textContent = '';
    $('exportError').textContent = `The export failed.\n${e.message}`;
  } finally {
    state.exporting = false;
    paint();
  }
}

async function loadFile(file) {
  $('exportError').textContent = '';
  if (!file || state.exporting || state.importing) return;
  try {
    const text = await file.text();
    forgetExport();
    useManifest(text, null);
  } catch (e) {
    $('exportError').textContent = e.message;
  }
}

async function pickOutput() {
  $('importError').textContent = '';
  setStatus('Choose in the macOS window (it may open behind LUNA)');
  try {
    const reply = await helper.pick('session-folder');
    if (!reply.cancelled) state.outputFolder = reply.path;
  } catch (e) {
    $('importError').textContent = e.message;
  }
  setStatus('Connected to LUNA');
  paint();
}

function paintReport() {
  state.hasReport = Boolean(report);
  $('report').hidden = !report;
  $('reportHint').hidden = Boolean(report);
  if (!report) return;
  for (const key of ['simplified', 'extended']) $(`tab-${key}`).classList.toggle('on', mode === key);
  // toHtmlBody escapes every value that came from the project.
  $('reportBody').innerHTML = ImportReport.toHtmlBody(report[mode]);
}

function keepReport() {
  try {
    localStorage.setItem(STORE, JSON.stringify(report));
  } catch {
    setStatus('Done. The report is too large to remember after this window closes: save or copy it now.');
  }
}

async function runImport() {
  if (state.importing) return;
  state.importing = true;
  report = undefined;
  paintReport();
  paint();
  $('importError').textContent = '';
  const progress = (text) => { $('importProgress').textContent = text; };
  let session;
  try {
    progress('Creating the new LUNA session (this can take a while)');
    // Always a new session: the import never edits one you already have.
    session = await AddOnLogic.createSession(luna, { name: state.sessionName.trim(), directoryPath: state.outputFolder });
    await session.ready();
    const result = await AddOnLogic.importProject(luna, session, state.manifest, { onProgress: progress });
    report = ImportReport.build(state.manifest, result);
    state.imported = true;
    mode = 'simplified';
    progress('Import finished. Check the report in step 3, then save the session in LUNA.');
    paintReport();
    keepReport();
    paint();
    $('step4').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    progress('');
    $('importError').textContent = `The import stopped: ${e.message}\n` + (session
      ? 'The new session is incomplete. Close it without saving, or delete it.'
      : 'Check in LUNA whether a new session was created before you try again.');
  } finally {
    state.importing = false;
    paint();
  }
}

async function copyReport() {
  const text = ImportReport.toMarkdown(report[mode]);
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const box = document.createElement('textarea');
    box.value = text;
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand('copy');
    box.remove();
    if (!ok) { setStatus('Copy failed. Select the report text and copy it by hand.'); return; }
  }
  setStatus(`Copied the ${mode} report.`);
}

function saveReport() {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([ImportReport.toHtmlFile(report)], { type: 'text/html' }));
  link.download = `${report.name} - import report.html`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
  setStatus('Asked to save both versions as one file. If no file appears inside LUNA, use Copy.');
}

function wire() {
  const drop = $('drop');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    void loadFile(e.dataTransfer.files[0]);
  });
  // A file dropped outside the box must not replace the page.
  for (const type of ['dragover', 'drop']) window.addEventListener(type, (e) => e.preventDefault());
  $('file').onchange = () => void loadFile($('file').files[0]);
  $('getInstaller').onclick = () => void getInstaller();
  $('helperYes').onclick = () => void answerInstalled(true);
  $('helperNo').onclick = () => void answerInstalled(false);
  $('showHelper').onclick = () => void showInFinder(installation.uninstaller);
  try {
    state.helperConfirmed = localStorage.getItem(CONFIRMED) === 'yes';
  } catch { /* ask again */ }
  $('pickProject').onclick = () => void pickProject('project');
  $('pickProjectFolder').onclick = () => void pickProject('project-folder');
  $('export').onclick = () => void runExport();
  $('reveal').onclick = () => void helper.revealExport().catch((e) => { $('exportError').textContent = e.message; });
  $('pickOutput').onclick = () => void pickOutput();
  $('sessionName').oninput = () => { state.sessionName = $('sessionName').value; paint(); };
  $('import').onclick = () => void runImport();
  for (const key of ['simplified', 'extended']) $(`tab-${key}`).onclick = () => { mode = key; paintReport(); };
  $('copy').onclick = () => void copyReport();
  $('save').onclick = saveReport;
  try {
    report = JSON.parse(localStorage.getItem(STORE)) ?? undefined;
  } catch {
    report = undefined;
  }
  paintReport();
  paint();
  void checkHelper();
  setInterval(() => void checkHelper(), 5000);
}

async function connect() {
  for (;;) {
    try {
      luna = await Luna.connect();
      break;
    } catch (e) {
      setStatus(e instanceof Luna.NotRunning ? 'Waiting for LUNA…' : e.message);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  Luna.bindShortcuts(luna);
  await luna.sessions.ready();
  state.lunaConnected = true;
  setStatus('Connected to LUNA');
  paint();
}

wire();
void connect();
