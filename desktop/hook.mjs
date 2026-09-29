// The hook that setup copies into each agent. Agents run it as
// `coconuts-agent-hook.mjs <provider> <event>` with the event's JSON on stdin. It turns
// the payload into a Coconuts event, posts it to the app's socket, and prints the hook
// output the agent expects. It is installed as a single file, so it imports nothing local.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

/**
 * Where each agent keeps its hook settings, how it is detected and opened, and how its
 * hook events map to Coconuts events. `localTurns`: the agent sends no turn ids.
 */
export const providers = {
  cursor: {
    name: 'Cursor', directory: '.cursor', config: 'hooks.json',
    application: 'Cursor.app', command: 'cursor', opens: ['Cursor'],
    events: {
      beforeSubmitPrompt: 'prompt', afterAgentResponse: 'response', stop: 'stop',
      preToolUse: 'question', postToolUse: 'questionResolved', postToolUseFailure: 'questionResolved',
    },
  },
  codex: {
    name: 'Codex', directory: '.codex', directoryEnv: 'CODEX_HOME', config: 'hooks.json', grouped: true,
    application: 'Codex.app', command: 'codex', extension: 'openai.chatgpt-', opens: ['Codex', 'Visual Studio Code', 'Terminal'],
    events: {
      UserPromptSubmit: 'prompt', Stop: 'stop', SessionEnd: 'sessionEnd', Interrupt: 'stop',
      PreToolUse: 'question', PostToolUse: 'questionResolved',
    },
    instructions: 'In Codex, use /hooks to review and trust the Coconuts hooks before they can run.',
  },
  claude: {
    name: 'Claude Code', directory: '.claude', directoryEnv: 'CLAUDE_CONFIG_DIR', config: 'settings.json', grouped: true, localTurns: true,
    application: 'Claude.app', command: 'claude', extension: 'anthropic.claude-code-', opens: ['Terminal'],
    events: {
      UserPromptSubmit: 'prompt', Stop: 'stop', SessionEnd: 'sessionEnd', StopFailure: 'stop',
      PreToolUse: 'question', PostToolUse: 'questionResolved', PostToolUseFailure: 'questionResolved',
    },
  },
  vscode: {
    name: 'VS Code', directory: '.copilot', config: 'hooks/coconuts.json', localTurns: true,
    application: 'Visual Studio Code.app', command: 'code', opens: ['Visual Studio Code'],
    events: { UserPromptSubmit: 'prompt', Stop: 'stop', PreToolUse: 'question', PostToolUse: 'questionResolved' },
    instructions: 'In VS Code, choose the Local agent target and start a new session. Hooks are enabled by default.',
  },
};

/** Tools that ask the user something, in any agent. Setup uses it as the hook matcher. */
export const questionTools = '(^|[./_])(AskUserQuestion|AskQuestion|askQuestions|ask_questions|request_user_input|request_user_input_async)$';

const socketPath = process.env.COCONUTS_HOOK_SOCKET || path.join(os.homedir(), 'Library/Application Support/Coconuts/hooks.sock');
const turnDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'coconuts-turns');
const text = value => typeof value === 'string' ? value.trim() : '';
const hash = value => createHash('sha256').update(value).digest('hex');
const isAbsolutePath = value => typeof value === 'string' && path.isAbsolute(value);

// CLI agents name their host app in the environment; extensions may only set their bundle id.
const terminals = new Map([
  ['Apple_Terminal', 'Terminal'], ['iTerm.app', 'iTerm'], ['WezTerm', 'WezTerm'], ['ghostty', 'Ghostty'],
  ['WarpTerminal', 'Warp'], ['vscode', 'Visual Studio Code'], ['vscode-insiders', 'Visual Studio Code - Insiders'],
  ['cursor', 'Cursor'], ['codex', 'Codex'],
]);
const bundles = new Map([
  ['com.microsoft.VSCode', 'Visual Studio Code'], ['com.microsoft.VSCodeInsiders', 'Visual Studio Code - Insiders'],
  ['com.todesktop.230313mzl4w4u92', 'Cursor'], ['com.openai.codex', 'Codex'],
]);
function hostApp(env = process.env) {
  return terminals.get(env.TERM_PROGRAM) ?? bundles.get(env.__CFBundleIdentifier)
    ?? (env.VSCODE_PID || env.VSCODE_IPC_HOOK_CLI ? 'Visual Studio Code' : '');
}

function toolInput(body) {
  if (typeof body.tool_input !== 'string') return body.tool_input;
  try { return JSON.parse(body.tool_input); } catch { return undefined; }
}

/** A question tool call in one shape for every agent: ids, titles, and options. */
function readQuestion(body) {
  if (!new RegExp(questionTools).test(body.tool_name || '')) return;
  const input = toolInput(body);
  if (!Array.isArray(input?.questions) || !input.questions.length || input.questions.length > 12) return;
  const ids = new Set();
  const questions = [];
  for (const [index, question] of input.questions.entries()) {
    const title = text(question?.question || question?.prompt || question?.title);
    if (!title) return;
    let id = text(question.id) || `question-${index + 1}`;
    if (ids.has(id)) id = `question-${index + 1}`;
    if (ids.has(id)) return;
    ids.add(id);
    const choices = Array.isArray(question.options) ? question.options.slice(0, 30) : [];
    const options = choices.map((option, optionIndex) => ({
      id: String(optionIndex),
      label: text(typeof option === 'string' ? option : option?.label),
      description: text(option?.description),
    })).filter(option => option.label);
    questions.push({
      id,
      question: title,
      options,
      multiSelect: question.multiSelect === true || question.multi_select === true,
      allowOther: !options.length || (question.allowFreeformInput !== false && question.allow_other !== false && question.isOther !== false),
    });
  }
  return { id: text(body.tool_use_id) || hash(JSON.stringify(input.questions)), questions };
}

/** Agents without turn ids get one per prompt, kept in a file beside this hook. */
function localTurn(provider, session, kind, timestamp) {
  const file = path.join(turnDirectory, hash(`${provider}:${session}`));
  let turn;
  if (kind !== 'prompt') {
    try { turn = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* The first event seen can be a completion. */ }
  }
  if (kind === 'sessionEnd') {
    fs.rmSync(file, { force: true });
  } else if (typeof turn?.id !== 'string') {
    // Also saved for a completion seen without its prompt, so repeated stops match.
    turn = { id: randomUUID(), started: Date.parse(timestamp) || Date.now() };
    fs.mkdirSync(turnDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(turn), { mode: 0o600 });
    fs.renameSync(`${file}.${process.pid}.tmp`, file);
  }
  return turn ?? { id: randomUUID() };
}

// VS Code's JSONL transcript is not a public format; unknown shapes give no reply.
// Reference: microsoft/vscode-copilot-chat sessionTranscriptService.ts.
function transcriptReply(file, started, stopped) {
  if (!isAbsolutePath(file) || !Number.isFinite(started)) return '';
  let jsonl;
  try {
    const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
    try {
      const { size } = fs.fstatSync(descriptor);
      // Read a bounded tail; its first, partial record fails to parse and is skipped.
      const buffer = Buffer.alloc(Math.min(size, 2 * 1024 * 1024));
      jsonl = buffer.toString('utf8', 0, fs.readSync(descriptor, buffer, 0, buffer.length, size - buffer.length));
    } finally { fs.closeSync(descriptor); }
  } catch { return ''; }
  let reply = '';
  for (const line of jsonl.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const time = Date.parse(entry?.timestamp);
    if (!(time >= started && time <= stopped)) continue;
    if (entry.type === 'user.message') reply = '';
    // Messages that call tools are commentary, not the final reply.
    if (entry.type === 'assistant.message') {
      const { content, toolRequests } = entry.data ?? {};
      reply = typeof content === 'string' && Array.isArray(toolRequests) && !toolRequests.length ? content.trim() : '';
    }
  }
  return reply.slice(0, 100000);
}

/** The Coconuts event for an agent's hook payload, or undefined when it has none. */
function translate(provider, name, body) {
  if (!Object.hasOwn(providers, provider) || !Object.hasOwn(providers[provider].events, name)) return;
  // Subagents (agent_id) report inside their parent's turn.
  if (!body || typeof body !== 'object' || body.agent_id) return;
  const agent = providers[provider], kind = agent.events[name], cursor = provider === 'cursor';
  let session = cursor ? body.conversation_id : body.session_id;
  if (!session && provider === 'vscode' && isAbsolutePath(body.transcript_path)) session = `transcript:${hash(body.transcript_path)}`;
  if (typeof session !== 'string' || !session) return;
  const asks = kind === 'question' || kind === 'questionResolved';
  const question = asks ? readQuestion(body) : undefined;
  if (asks && !question) return;

  const cwd = cursor ? body.workspace_roots?.[0] : body.cwd;
  const event = {
    provider, kind,
    conversationId: session,
    generationId: String((cursor ? body.generation_id : body.turn_id) || ''),
    project: typeof cwd === 'string' && cwd ? path.basename(cwd) : agent.name,
    // Cursor and VS Code run their own agents; CLI agents run in a terminal or an editor.
    host: cursor || provider === 'vscode' ? '' : hostApp(),
    question,
  };
  const turn = agent.localTurns && !event.generationId ? localTurn(provider, session, kind, body.timestamp) : undefined;
  if (turn) event.generationId = turn.id;
  let response = cursor ? body.text : body.last_assistant_message;
  if (kind === 'stop') {
    event.status = cursor ? body.status : name === 'Interrupt' ? 'interrupted' : name === 'StopFailure' ? 'error' : 'completed';
    if (provider === 'vscode') {
      response ||= transcriptReply(body.transcript_path, turn?.started, Date.parse(body.timestamp) || Infinity)
        || 'VS Code has finished this turn. Return to VS Code to read the reply.';
    }
  }
  if (typeof response === 'string') event.response = response;
  return event;
}

/** Post an event to the app. Undefined when it isn't listening. */
function deliver(event, timeout) {
  return new Promise(resolve => {
    const request = http.request({ socketPath, method: 'POST', path: '/event', headers: { 'Content-Type': 'application/json' } }, response => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { data += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); }
      });
      response.on('close', () => resolve(undefined));
    });
    request.setTimeout(timeout, () => request.destroy());
    request.on('error', () => resolve(undefined));
    request.end(JSON.stringify(event));
  });
}

/** The app may be closed: open it for events worth seeing, then keep trying for a while. */
async function redeliver(event, timeout) {
  if (event.kind === 'prompt' || event.kind === 'question' || (event.kind === 'stop' && event.status !== 'interrupted')) {
    // Editors run hooks with ELECTRON_RUN_AS_NODE set; the app must not inherit it.
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn('open', ['-b', 'dev.coconuts.island'], { stdio: 'ignore', env }).on('error', () => {});
  }
  for (let attempt = 0; attempt < 15; attempt++) {
    await delay(1000);
    const reply = await deliver(event, timeout);
    if (reply) return reply;
  }
}

/** Retry in a detached copy of this hook, so the agent never waits for the app to open. */
function redeliverLater(event) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--redeliver'], { detached: true, stdio: ['pipe', 'ignore', 'ignore'] });
  child.on('error', () => {});
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify(event));
  child.unref();
}

async function run([provider, name]) {
  if (provider === '--redeliver') {
    await redeliver(JSON.parse(fs.readFileSync(0, 'utf8')), 1000);
    return;
  }
  let output = {};
  if (provider === 'cursor' && name === 'beforeSubmitPrompt') output = { continue: true };
  if (provider === 'cursor' && name === 'preToolUse') output = { permission: 'allow' };
  try {
    const body = JSON.parse(fs.readFileSync(0, 'utf8'));
    const event = translate(provider, name, body);
    if (provider === 'claude' && event?.kind === 'question') {
      // Claude waits for a reply from the island; the app releases it within nine minutes.
      event.wait = true;
      const reply = await deliver(event, 10 * 60 * 1000) ?? await redeliver(event, 10 * 60 * 1000);
      if (reply?.answers) {
        output = {
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            updatedInput: { ...toolInput(body), answers: reply.answers },
          },
        };
      }
    } else if (event && !await deliver(event, 1000)) {
      redeliverLater(event);
    }
  } catch { /* Without Coconuts, the agent carries on as usual. */ }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

// Setup and the app import the provider table; only agents run the hook.
function isEntry() {
  try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isEntry()) await run(process.argv.slice(2));
