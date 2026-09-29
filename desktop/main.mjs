// Coconuts as a native desktop app. The island is served from a privileged `app://`
// scheme (a secure context, so WebGPU is available). Agent hooks post events to a
// user-only Unix socket in the app's data folder.
import { app, BrowserWindow, clipboard, ipcMain, Menu, net, protocol, shell } from 'electron';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyEvent, finishQuestion, formatAnswers, isEvent, openAgent, readAnswers } from './agents.mjs';
import { providers } from './hook.mjs';
import { createSetup } from './setup.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(here, '..', 'dist');
const devURL = process.env.COCONUTS_DEV_URL;
app.setName('Coconuts');
const socketPath = path.join(app.getPath('appData'), 'Coconuts', 'hooks.sock');
const statePath = path.join(app.getPath('userData'), 'agents.json');
const setup = createSetup(app.getPath('userData'));
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

let win;

/** Jobs in progress, and bottles: the last replies plus every unanswered question. */
const state = { working: {}, bottles: [] };
try {
  const { bottles } = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (Array.isArray(bottles)) state.bottles = bottles;
} catch { /* First launch. */ }
for (const bottle of state.bottles) {
  bottle.provider ??= 'cursor';
  // No hook is waiting after a restart, so questions are answered in the agent.
  if (bottle.question) bottle.question.replyMode = 'handoff';
}
const findBottle = id => state.bottles.find(bottle => bottle.id === id);

let saving = Promise.resolve();
function stateChanged() {
  state.bottles = state.bottles.filter((bottle, index) => bottle.question?.state === 'pending' || index >= state.bottles.length - 30);
  const snapshot = JSON.stringify({ bottles: state.bottles });
  saving = saving.then(() => fs.promises.writeFile(statePath, snapshot)).catch(() => {});
  win?.webContents.send('agent-state', state);
}

// Claude's question hook waits on its connection for a reply from the island.
const waiting = new Map();

function release(id, output = {}) {
  const held = waiting.get(id);
  if (!held) return;
  waiting.delete(id);
  clearTimeout(held.timer);
  if (!held.response.destroyed) held.response.end(JSON.stringify(output));
}

/** Let the agent ask on its own; the island then copies replies for pasting. */
function handOff(id) {
  release(id);
  const bottle = findBottle(id);
  if (bottle?.question) bottle.question.replyMode = 'handoff';
  stateChanged();
}

function hold(id, response) {
  const bottle = findBottle(id);
  if (bottle?.question?.state !== 'pending' || waiting.has(id)) return false;
  bottle.question.replyMode = 'direct';
  const giveUp = () => { if (waiting.get(id)?.response === response) handOff(id); };
  waiting.set(id, { response, timer: setTimeout(giveUp, 9 * 60 * 1000) });
  response.on('close', giveUp);
  return true;
}

function receive(event, response) {
  const result = applyEvent(state, event);
  try {
    if (setup.markConnected(event.provider)) win?.webContents.send('hook-setup-state', setup.state());
  } catch { /* Setup history must not interrupt an agent. */ }
  const held = event.wait === true && !!result.questionId && hold(result.questionId, response);
  for (const id of waiting.keys()) if (findBottle(id)?.question?.state !== 'pending') release(id);
  if (result.focus) focusIsland();
  if (result.changed || held) stateChanged();
  if (!held) response.end('{}');
}

function listen() {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  fs.rmSync(socketPath, { force: true });
  const server = http.createServer((request, response) => {
    // Hooks from an older install post elsewhere; answer them neutrally until setup updates them.
    if (request.method !== 'POST' || request.url !== '/event') return response.end('{}');
    let body = '';
    request.on('data', chunk => {
      body += chunk;
      if (body.length > 4e6) request.destroy();
    });
    request.on('end', () => {
      let event;
      try { event = JSON.parse(body); } catch { /* Handled below. */ }
      if (isEvent(event)) receive(event, response);
      else response.writeHead(400).end('{}');
    });
  });
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
  app.on('will-quit', () => {
    for (const id of waiting.keys()) release(id);
    server.close();
    fs.rmSync(socketPath, { force: true });
  });
}

function answer(id, answers) {
  const bottle = findBottle(id), held = waiting.get(id);
  if (bottle?.question?.state !== 'pending' || !held || held.response.destroyed) {
    throw new Error('This question is now in your agent. You can copy your reply and continue there.');
  }
  const resolved = readAnswers(bottle.question.questions, answers);
  release(id, { answers: Object.fromEntries(resolved.map(({ question, answer }) => [question, answer])) });
  finishQuestion(state, bottle, formatAnswers(resolved));
  stateChanged();
  return { ok: true };
}

async function copyReply(id, answers) {
  const bottle = findBottle(id);
  if (bottle?.question?.state !== 'pending') throw new Error('This question has already moved on.');
  clipboard.writeText(formatAnswers(readAnswers(bottle.question.questions, answers)));
  handOff(id);
  if (await openAgent(bottle)) return { ok: true };
  return { ok: false, error: 'Your reply is copied. Open your agent and paste it into the conversation.' };
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    title: 'Coconuts', backgroundColor: '#e9eee1', show: false,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  win.once('ready-to-show', () => win.show());
  const openOutside = url => { if (/^https?:/.test(url)) void shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(devURL || 'app://')) return;
    event.preventDefault();
    openOutside(url);
  });
  win.webContents.on('did-finish-load', () => win.webContents.send('agent-state', state));
  win.on('closed', () => { win = undefined; });
  void win.loadURL(devURL || 'app://coconuts/index.html');
}

function focusIsland() {
  // The window may be closed while the app stays in the Dock.
  if (!app.isReady()) return;
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
  win.focus();
}

/** Requests from the island's own page; setup paths and commands stay in this process. */
function handle(channel, handler) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!win || event.senderFrame !== win.webContents.mainFrame) throw new Error('Only available in the Coconuts window.');
    return handler(...args);
  });
}
/** Reply errors become notes on the paper. */
const replying = handler => async (id, answers) => {
  try { return await handler(id, answers); } catch (error) { return { ok: false, error: error.message }; }
};
const knownProvider = provider => {
  if (!Object.hasOwn(providers, provider)) throw new Error('Unknown agent.');
  return provider;
};

handle('agent-state', () => state);
handle('agent-read', id => {
  const bottle = findBottle(id);
  if (!bottle) return;
  bottle.read = true;
  stateChanged();
});
handle('agent-answer', replying(answer));
handle('agent-copy-reply', replying(copyReply));
handle('open-agent', id => {
  const bottle = findBottle(id);
  if (!bottle) return false;
  handOff(id);
  return openAgent(bottle);
});
handle('hook-setup-state', () => setup.state());
handle('hook-setup-install', selected => setup.install(selected));
handle('hook-setup-dismiss', () => setup.dismiss());
handle('hook-setup-open', provider => openAgent({ provider: knownProvider(provider) }));
handle('hook-setup-config', provider => shell.showItemInFolder(setup.configPath(knownProvider(provider))));
// A user activation lets the island lock the mouse when the window gains focus.
handle('activate', () => win.webContents.executeJavaScript('0', true));

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', focusIsland);
  app.whenReady().then(() => {
    app.dock?.setIcon(path.join(here, 'icons', 'icon.png'));
    protocol.handle('app', request => {
      const file = path.join(dist, decodeURIComponent(new URL(request.url).pathname));
      if (!file.startsWith(dist + path.sep)) return new Response('Not found', { status: 404 });
      return net.fetch(pathToFileURL(file).href);
    });
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
      { label: 'View', submenu: [{ role: 'togglefullscreen' }, { type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] },
      { role: 'windowMenu' },
    ]));
    // Installed hooks run on the packaged app; development runs leave them alone.
    if (app.isPackaged) {
      try { setup.refresh(); } catch { /* Setup shows what still needs attention. */ }
    }
    listen();
    createWindow();
    app.on('activate', focusIsland);
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
} else {
  // Another Coconuts owns the socket; it takes the focus instead.
  app.quit();
}
