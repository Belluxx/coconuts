// Installs the Coconuts hook into agents' settings and tracks first-launch setup.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providers, questionTools } from './hook.mjs';

const hookSource = fileURLToPath(new URL('./hook.mjs', import.meta.url));
// Earlier installs copied the hook's modules beside it, and Cursor once used a shell script.
const oldFiles = ['agent-questions.mjs', 'agent-providers.mjs', 'agent-host.mjs', 'vscode-transcript.mjs', 'agent-turns.mjs', 'coconuts-hook.sh'];
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const isOurs = hook => typeof hook?.command === 'string' && /coconuts-(agent-hook\.mjs|hook\.sh)/.test(hook.command);

function writeAtomic(file, contents) {
  fs.writeFileSync(`${file}.${process.pid}.tmp`, contents, { mode: 0o600 });
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
}

/** Where an agent keeps its settings; COCONUTS_<AGENT>_DIR or the agent's own variable override it. */
function locate(provider) {
  if (!Object.hasOwn(providers, provider)) throw new Error('Unknown agent.');
  const agent = providers[provider];
  const directory = path.resolve(process.env[`COCONUTS_${provider.toUpperCase()}_DIR`] || process.env[agent.directoryEnv] || path.join(os.homedir(), agent.directory));
  const hookDirectory = path.join(directory, provider === 'vscode' ? 'hooks/coconuts' : 'hooks');
  return { directory, config: path.join(directory, agent.config), hookDirectory, script: path.join(hookDirectory, 'coconuts-agent-hook.mjs') };
}

function readConfig(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return {};
    if (error instanceof SyntaxError) throw new Error(`The settings in ${file} are not valid JSON. Fix the file, then try again.`);
    throw error;
  }
}

/**
 * The agent's settings with Coconuts' entries replaced and everything else kept.
 * The hook runs on the app's bundled runtime, in Node mode.
 */
function withHooks(config, provider, paths, executable = process.execPath) {
  const agent = providers[provider];
  if (!isObject(config) || (config.hooks !== undefined && !isObject(config.hooks)) || (provider === 'vscode' && config.version !== undefined)) {
    throw new Error(`Invalid hooks configuration: ${paths.config}`);
  }
  if (provider === 'cursor') config.version ??= 1;
  config.hooks ??= {};
  for (const [event, kind] of Object.entries(agent.events)) {
    const entries = config.hooks[event] ?? [];
    if (!Array.isArray(entries) || !entries.every(entry => isObject(entry) && (agent.grouped ? Array.isArray(entry.hooks) : typeof entry.command === 'string'))) {
      throw new Error(`Invalid ${event} hooks in ${paths.config}`);
    }
    const kept = agent.grouped ? entries.flatMap(group => {
      const hooks = group.hooks.filter(hook => !isOurs(hook));
      if (hooks.length === group.hooks.length) return [group];
      return hooks.length ? [{ ...group, hooks }] : [];
    }) : entries.filter(hook => !isOurs(hook));
    const hook = {
      command: `ELECTRON_RUN_AS_NODE=1 ${quote(executable)} ${quote(paths.script)} ${provider} ${event}`,
      // Claude's question hook waits for a reply from the island.
      timeout: provider === 'claude' && event === 'PreToolUse' ? 620 : event === 'Interrupt' ? 3 : 5,
    };
    if (provider !== 'cursor') hook.type = 'command';
    const entry = agent.grouped ? { hooks: [hook] } : hook;
    if (kind.startsWith('question') && provider !== 'vscode') entry.matcher = questionTools;
    config.hooks[event] = [...kept, entry];
  }
  return config;
}

/** Install or update the hook, keeping a backup of the agent's original settings. */
export function installHooks(provider, executable) {
  const paths = locate(provider);
  const original = fs.existsSync(paths.config) ? fs.readFileSync(paths.config) : undefined;
  const config = withHooks(readConfig(paths.config), provider, paths, executable); // Validates before touching any file.
  fs.mkdirSync(paths.hookDirectory, { recursive: true });
  if (original && !fs.existsSync(`${paths.config}.coconuts-backup`)) fs.writeFileSync(`${paths.config}.coconuts-backup`, original, { mode: 0o600 });
  writeAtomic(paths.script, fs.readFileSync(hookSource));
  for (const file of oldFiles) fs.rmSync(path.join(paths.hookDirectory, file), { force: true });
  writeAtomic(paths.config, `${JSON.stringify(config, null, 2)}\n`);
}

/** Whether the hook is in the agent's settings, and whether its file or entries are out of date. */
export function inspectHooks(provider) {
  const paths = locate(provider);
  try {
    const config = readConfig(paths.config);
    const installed = Object.values(config.hooks ?? {}).some(entries => Array.isArray(entries)
      && entries.some(entry => isOurs(entry) || (Array.isArray(entry?.hooks) && entry.hooks.some(isOurs))));
    let current = false;
    try { current = fs.readFileSync(paths.script).equals(fs.readFileSync(hookSource)); } catch { /* Not installed. */ }
    const expected = withHooks(structuredClone(config), provider, paths);
    const needsUpdate = installed && (!current || JSON.stringify(config) !== JSON.stringify(expected));
    return { installed, needsUpdate, disabled: config.disableAllHooks === true };
  } catch (error) {
    return { installed: false, needsUpdate: false, error: error.message };
  }
}

/** Whether the agent seems to be on this Mac: settings, an app, a command, or an editor extension. */
function detect(provider) {
  const agent = providers[provider], home = os.homedir();
  if (fs.existsSync(locate(provider).directory)) return true;
  if (['/Applications', path.join(home, 'Applications')].some(root => fs.existsSync(path.join(root, agent.application)))) return true;
  const bins = (process.env.PATH || '').split(path.delimiter).concat(path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin');
  if (bins.some(root => root && fs.existsSync(path.join(root, agent.command)))) return true;
  return !!agent.extension && ['.vscode', '.cursor'].some(editor => {
    try { return fs.readdirSync(path.join(home, editor, 'extensions')).some(name => name.startsWith(agent.extension)); } catch { return false; }
  });
}

/** First-launch setup in the app. Its history is kept apart from agent settings. */
export function createSetup(dataDirectory) {
  const file = path.join(dataDirectory, 'hook-setup.json');
  let history = { dismissed: false, connected: {} };
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    history = { dismissed: saved.dismissed === true, connected: isObject(saved.connected) ? saved.connected : {} };
  } catch { /* First launch. */ }
  const errors = new Map();
  const save = () => {
    fs.mkdirSync(dataDirectory, { recursive: true });
    writeAtomic(file, `${JSON.stringify(history, null, 2)}\n`);
  };

  function state() {
    return {
      firstRun: !history.dismissed,
      agents: Object.entries(providers).map(([id, agent]) => {
        const status = inspectHooks(id);
        // Connected once an event arrives from the current hook.
        const connected = status.installed && !status.needsUpdate && !status.disabled && !!history.connected[id];
        let instruction = status.installed && !connected ? agent.instructions ?? '' : '';
        if (status.disabled) instruction = 'Hooks are disabled in your agent settings. Enable them there to receive messages.';
        return { id, name: agent.name, detected: detect(id), ...status, connected, instruction, error: errors.get(id) || status.error || '' };
      }),
    };
  }

  function install(selected) {
    if (!Array.isArray(selected) || !selected.every(id => Object.hasOwn(providers, id))) throw new Error('Choose a supported agent.');
    for (const provider of new Set(selected)) {
      errors.delete(provider);
      try {
        const status = inspectHooks(provider);
        if (status.installed && !status.needsUpdate) continue;
        installHooks(provider);
        delete history.connected[provider];
      } catch (error) { errors.set(provider, error.message); }
    }
    save();
    return state();
  }

  return {
    state,
    install,
    /** Update hooks that no longer match this app, after it was updated or moved. */
    refresh() {
      const outdated = Object.keys(providers).filter(id => inspectHooks(id).needsUpdate);
      if (outdated.length) install(outdated);
    },
    dismiss() {
      history.dismissed = true;
      save();
    },
    /** Record the first event from an agent; true when that changes the setup state. */
    markConnected(provider) {
      if (history.connected[provider]) return false;
      history.connected[provider] = true;
      save();
      return true;
    },
    configPath: provider => locate(provider).config,
  };
}
