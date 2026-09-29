// What agents are working on and the messages they leave, driven by hook events.
// `working` holds one job per turn in progress; `bottles` holds finished replies and
// questions. Tool questions get their own bottle, separate from the turn's reply.
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { providers } from './hook.mjs';

const inSession = (entry, event) => entry.provider === event.provider && entry.conversationId === event.conversationId;
const inTurn = (entry, event) => inSession(entry, event) && (!event.generationId || entry.generationId === event.generationId);
const jobId = entry => JSON.stringify([entry.provider, entry.conversationId, entry.generationId]);
const pending = bottle => bottle.question?.state === 'pending';
const writtenReply = { id: 'reply', question: 'Your reply', options: [], multiSelect: false, allowOther: true };

/** A hook event as the app accepts it; anything else is ignored. */
export function isEvent(event) {
  const kinds = ['prompt', 'response', 'stop', 'sessionEnd', 'question', 'questionResolved'];
  return !!event && Object.hasOwn(providers, event.provider) && kinds.includes(event.kind)
    && typeof event.conversationId === 'string' && !!event.conversationId && typeof event.generationId === 'string'
    && (!event.kind.startsWith('question') || Array.isArray(event.question?.questions));
}

function resolveQuestions(state, match) {
  let changed = false;
  for (const bottle of state.bottles) {
    if (!pending(bottle) || !match(bottle)) continue;
    bottle.question.state = 'resolved';
    bottle.read = true;
    changed = true;
  }
  return changed;
}

function clearJobs(state, event, keepId) {
  let changed = false;
  for (const [id, job] of Object.entries(state.working)) {
    if (id === keepId || !inSession(job, event)) continue;
    delete state.working[id];
    changed = true;
  }
  return changed;
}

/** Close a question, answered from the island or resolved in the agent. */
export function finishQuestion(state, bottle, answer) {
  bottle.question.state = answer ? 'answered' : 'resolved';
  if (answer) bottle.question.answer = answer;
  bottle.read = true;
  const job = state.working[jobId(bottle)];
  if (job) job.waiting = state.bottles.some(entry => inTurn(entry, bottle) && pending(entry));
}

function record(message, event) {
  if (event.host) message.host = event.host;
  if (event.kind === 'prompt') message.project = event.project;
  else if (typeof event.response === 'string') message.response = event.response.trim();
  if (event.kind === 'stop') message.completionStatus = event.status || message.completionStatus || 'completed';
}

/** A stopped turn keeps its status; a reply ending in a question gets a written-reply field. */
function settle(message) {
  const lastLine = message.response.split('\n').filter(Boolean).pop() || '';
  const stopped = message.completionStatus && message.completionStatus !== 'completed';
  message.status = stopped ? message.completionStatus : /\?\s*$/.test(lastLine) ? 'input' : 'completed';
  if (message.status === 'input' && !message.question) {
    message.question = { id: message.id, state: 'pending', replyMode: 'handoff', questions: [writtenReply] };
  }
}

/**
 * Apply one event. `changed`: save and publish. `focus`: bring the island forward.
 * `questionId`: the bottle holding the event's question, which Claude's hook can wait on.
 */
export function applyEvent(state, event) {
  const { provider, kind, conversationId, generationId } = event;
  const id = jobId(event);
  if (kind === 'sessionEnd') {
    const resolved = resolveQuestions(state, bottle => inSession(bottle, event));
    return { changed: clearJobs(state, event) || resolved };
  }

  const asked = event.question && state.bottles.find(bottle => inTurn(bottle, event) && bottle.question?.id === event.question.id);
  if (kind === 'questionResolved') {
    if (!asked || !pending(asked)) return {};
    finishQuestion(state, asked);
    return { changed: true };
  }
  if (kind === 'question' && asked) return { questionId: asked.id };

  // Events after the turn's reply (repeated stops, Cursor's response after its stop) update that bottle.
  const reply = generationId && state.bottles.findLast(bottle => inTurn(bottle, event) && !bottle.question?.tool);
  if (reply) {
    if (kind === 'question') return {};
    record(reply, event);
    settle(reply);
    delete state.working[id];
    return { changed: true };
  }

  if (kind === 'prompt') {
    // A new prompt moves on from unanswered questions. Turns the hook numbers itself can miss their stop.
    resolveQuestions(state, bottle => inSession(bottle, event));
    if (providers[provider].localTurns) clearJobs(state, event, id);
  }
  const job = (kind !== 'prompt' || generationId) && state.working[id]
    || { id, provider, conversationId, generationId, project: event.project, response: '' };
  record(job, event);

  if (kind === 'question') {
    job.waiting = true;
    state.working[id] = job;
    const bottle = {
      ...job, id: randomUUID(), response: '', status: 'input', read: false,
      question: { id: event.question.id, tool: true, questions: event.question.questions, state: 'pending', replyMode: 'handoff' },
    };
    delete bottle.waiting;
    state.bottles.push(bottle);
    return { changed: true, questionId: bottle.id };
  }
  if (kind === 'stop') {
    resolveQuestions(state, bottle => inTurn(bottle, event));
    delete state.working[id];
    const bottle = { ...job, id: randomUUID(), read: false };
    delete bottle.waiting;
    settle(bottle);
    state.bottles.push(bottle);
    return { changed: true };
  }
  if (kind === 'prompt') job.waiting = false;
  state.working[id] = job;
  return { changed: true, focus: kind === 'prompt' };
}

/** Check a reply from the island against its questions; option ids come from the UI, labels never do. */
export function readAnswers(questions, answers) {
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw new Error('Write a reply to each question.');
  return questions.map(question => {
    const answer = answers[question.id];
    if (!answer || !Array.isArray(answer.selected) || answer.selected.length > question.options.length) {
      throw new Error('Choose an answer for each question.');
    }
    const selected = [...new Set(answer.selected)];
    if (!question.multiSelect && selected.length > 1) throw new Error('Choose one answer for this question.');
    const labels = selected.map(id => {
      const option = question.options.find(option => option.id === id);
      if (!option) throw new Error('This choice is no longer available.');
      return option.label;
    });
    const note = typeof answer.text === 'string' ? answer.text.trim() : '';
    if (note.length > 12000 || (note && !question.allowOther)) throw new Error('This reply is not available for this question.');
    if (!labels.length && !note) throw new Error('Write a reply to each question.');
    return { question: question.question, answer: [...labels, note].filter(Boolean).join(', ') };
  });
}

/** Answers as text to paste into the agent. */
export const formatAnswers = answers =>
  answers.map(({ question, answer }) => question === writtenReply.question ? answer : `${question}\n${answer}`).join('\n\n');

/** Bring the app running an agent to the front, trying its usual apps after the detected one. */
export async function openAgent({ provider, host }) {
  for (const application of new Set([host, ...providers[provider].opens].filter(Boolean))) {
    const opened = await new Promise(resolve => execFile('open', ['-a', application], error => resolve(!error)));
    if (opened) return true;
  }
  return false;
}
