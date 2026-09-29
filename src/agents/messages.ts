import { Marked } from 'marked';
import './agents.css';
import { desktop, type AgentAnswers, type AgentBottle, type AgentQuestion, type AgentSource, type ReplyResult } from './bridge';

/** What the yacht is doing, for the status note. */
interface BoatActivity {
  jobs: AgentSource[];
  bottles: AgentBottle[];
  moored: boolean;
  nearby: boolean;
}

const agentNames = { codex: 'Codex', claude: 'Claude Code', vscode: 'VS Code', cursor: 'Cursor' };
const agentName = (entry: AgentSource) => agentNames[entry.provider];
const sourceLabel = (entry: AgentSource) => `${agentName(entry)} · ${entry.project}`;
const stopped = (entry: AgentBottle) => ['error', 'interrupted', 'aborted'].includes(entry.status);
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, character => `&#${character.charCodeAt(0)};`);
const markdown = new Marked({ renderer: { html: ({ text }) => escapeHtml(text) } });

function activityMessage({ jobs, bottles, moored }: BoatActivity) {
  if (!bottles.length) {
    if (!jobs.length) return '';
    return jobs.length > 1 ? `${jobs.length} agents at work` : 'Your agent is at work';
  }
  const questions = bottles.filter(entry => entry.question?.state === 'pending');
  if (questions.length) {
    if (!moored) return 'A question is sailing in';
    return questions.length > 1 ? 'Questions await at the jetty' : 'A question awaits at the jetty';
  }
  if (bottles.some(stopped)) {
    return moored ? 'Your agent stopped. A note at the jetty' : 'Your agent stopped. A note is sailing in';
  }
  if (!moored) return 'Finished. A message is sailing in';
  return bottles.length > 1 ? `${bottles.length} messages at the jetty` : 'Finished. A message at the jetty';
}

function emptyMessage(entry: AgentBottle) {
  if (entry.question) return '';
  if (entry.status === 'error') return '<p>This turn stopped with an error.</p>';
  if (stopped(entry)) return '<p>This turn was interrupted.</p>';
  return '<p><em>No message was left in this bottle.</em></p>';
}

function questionField(question: AgentQuestion, index: number, count: number, answer: AgentAnswers[string], onChange: () => void) {
  const field = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = question.question;
  if (count > 1) {
    const number = document.createElement('span');
    number.className = 'question-number';
    number.textContent = `${index + 1} / ${count}`;
    legend.prepend(number);
  }
  field.append(legend);

  if (question.multiSelect && question.options.length) {
    const help = document.createElement('p');
    help.className = 'question-help';
    help.textContent = 'Choose all that apply.';
    field.append(help);
  }
  for (const [optionIndex, option] of question.options.entries()) {
    const row = document.createElement('label');
    row.className = 'question-choice';
    row.innerHTML = `
      <input>
      <span class="choice-mark" aria-hidden="true">
        <span>${String(optionIndex + 1).padStart(2, '0')}</span>
        <svg viewBox="0 0 22 22"><path d="m3 12 5 4L19 5"/></svg>
      </span>
      <span class="choice-copy"><span class="choice-title"></span></span>`;
    const input = row.querySelector('input')!;
    input.type = question.multiSelect ? 'checkbox' : 'radio';
    input.name = `question-${index}`;
    input.value = option.id;
    input.checked = answer.selected.includes(option.id);
    row.querySelector('.choice-title')!.textContent = option.label;
    if (option.description) {
      const description = document.createElement('span');
      description.className = 'choice-description';
      description.textContent = option.description;
      row.querySelector('.choice-copy')!.append(description);
    }
    input.addEventListener('change', () => {
      answer.selected = [...field.querySelectorAll<HTMLInputElement>('input:checked')].map(input => input.value);
      onChange();
    });
    field.append(row);
  }

  if (question.allowOther || !question.options.length) {
    const writing = document.createElement('div');
    writing.className = 'question-writing';
    const note = document.createElement('textarea');
    note.rows = 2;
    note.maxLength = 12000;
    note.placeholder = 'Your words…';
    note.setAttribute('aria-label', `Your reply: ${question.question}`);
    note.value = answer.text;
    note.addEventListener('input', () => {
      answer.text = note.value;
      onChange();
    });
    writing.append(note);
    if (question.options.length) {
      const write = document.createElement('button');
      write.type = 'button';
      write.className = 'question-write';
      write.textContent = 'Write your own reply';
      writing.hidden = !note.value;
      write.hidden = !!note.value;
      write.addEventListener('click', () => {
        write.hidden = true;
        writing.hidden = false;
        note.focus();
      });
      field.append(write);
    }
    field.append(writing);
  }
  return field;
}

/** The message paper with its reply drafts, and the passive status note beside the shore. */
export function createMessageUI(canvas: HTMLCanvasElement, onModalChange: (open: boolean) => void) {
  const app = document.querySelector<HTMLElement>('#app')!;
  const letter = document.createElement('div');
  letter.id = 'letter';
  letter.className = 'letter-shade';
  letter.hidden = true;
  letter.innerHTML = `
    <article class="letter" role="dialog" aria-modal="true" aria-label="Message in a bottle">
      <button class="letter-close" aria-label="Close message"><span>Esc</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button>
      <div class="letter-body" tabindex="0">
        <p class="letter-origin" hidden></p>
        <div class="letter-text"></div>
        <form class="letter-questions" novalidate hidden>
          <div class="question-fields"></div>
          <div class="question-actions">
            <button class="letter-send" type="submit"></button>
            <button class="letter-handoff" type="button"></button>
          </div>
          <p class="question-delivery" hidden></p>
          <p class="question-notice" role="status" hidden></p>
        </form>
      </div>
    </article>`;
  document.body.append(letter);
  const body = letter.querySelector<HTMLElement>('.letter-body')!;
  const origin = letter.querySelector<HTMLElement>('.letter-origin')!;
  const text = letter.querySelector<HTMLElement>('.letter-text')!;
  const form = letter.querySelector('form')!;
  const fields = form.querySelector<HTMLElement>('.question-fields')!;
  const actions = form.querySelector<HTMLElement>('.question-actions')!;
  const submit = form.querySelector<HTMLButtonElement>('.letter-send')!;
  const handoff = form.querySelector<HTMLButtonElement>('.letter-handoff')!;
  const delivery = form.querySelector<HTMLElement>('.question-delivery')!;
  const notice = form.querySelector<HTMLElement>('.question-notice')!;

  const activity = document.createElement('aside');
  activity.className = 'agent-activity';
  activity.setAttribute('aria-label', 'Message boat');
  activity.innerHTML = `
    <svg class="activity-sail" viewBox="0 0 28 32" aria-hidden="true"><path d="M14 3v22M11 6 3 21h8M17 10l8 11h-8M3 26c3 3 6 3 10 1 4 2 8 2 12-1"/></svg>
    <div><p class="activity-origin"></p><p class="activity-line" role="status" aria-live="polite"></p></div>`;
  document.querySelector('#interface')!.append(activity);
  const activityOrigin = activity.querySelector<HTMLElement>('.activity-origin')!;
  const activityLine = activity.querySelector<HTMLElement>('.activity-line')!;
  let activityAge = 0;

  const drafts = new Map<string, AgentAnswers>();
  const sending = new Set<string>();
  let current: AgentBottle | undefined;
  let previousFocus: HTMLElement | null = null;
  let appWasInert = false;

  function say(message = '') {
    notice.textContent = message;
    notice.hidden = !message;
  }

  function refreshQuestion() {
    if (!current?.question) return;
    const { state, replyMode } = current.question;
    const pending = state === 'pending';
    const direct = replyMode === 'direct';
    const busy = sending.has(current.id);
    fields.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>('input, textarea, button').forEach(input => {
      input.disabled = busy || !pending;
    });
    actions.hidden = !pending;
    submit.disabled = handoff.disabled = busy || !desktop;
    submit.textContent = direct ? 'Send this reply' : `Copy reply & open ${agentName(current)}`;
    if (busy) submit.textContent = 'Preparing reply…';
    handoff.hidden = !direct;
    handoff.textContent = `Answer in ${agentName(current)}`;
    delivery.hidden = direct || !pending;
    delivery.textContent = `Your reply will be copied, ready to paste in ${agentName(current)}.`;
    if (!pending) say(state === 'answered' ? 'Reply sent.' : 'This question has already been answered or closed in your agent.');
  }

  function open(entry: AgentBottle) {
    if (current) close();
    current = entry;
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    appWasInert = app.inert;
    app.inert = true;
    letter.hidden = false;
    onModalChange(true);
    origin.hidden = !entry.question;
    origin.textContent = sourceLabel(entry);
    text.innerHTML = entry.response ? markdown.parse(entry.response, { async: false }) : emptyMessage(entry);
    text.querySelectorAll('a').forEach(link => {
      link.target = '_blank';
      link.rel = 'noreferrer';
    });
    form.hidden = !entry.question;
    fields.replaceChildren();
    say();
    if (entry.question) {
      const questions = entry.question.questions;
      let answers = drafts.get(entry.id);
      if (!answers) {
        answers = Object.fromEntries(questions.map(question => [question.id, { selected: [], text: '' }]));
        drafts.set(entry.id, answers);
      }
      questions.forEach((question, index) => {
        fields.append(questionField(question, index, questions.length, answers[question.id], () => say()));
      });
      refreshQuestion();
    }
    body.scrollTop = 0;
    body.focus();
  }

  function close() {
    if (!current) return;
    current = undefined;
    letter.hidden = true;
    app.inert = appWasInert;
    onModalChange(false);
    if (previousFocus?.isConnected && !previousFocus.closest('[hidden], [inert]') && previousFocus.getClientRects().length) {
      previousFocus.focus();
    } else {
      canvas.focus();
    }
    previousFocus = null;
  }

  async function respond(action: 'reply' | 'handoff') {
    const entry = current;
    if (!entry?.question || entry.question.state !== 'pending' || !desktop || sending.has(entry.id)) return;
    const answers = drafts.get(entry.id)!;
    if (action === 'reply') {
      const unanswered = entry.question.questions.findIndex(question => {
        const answer = answers[question.id];
        return !answer.selected.length && !answer.text.trim();
      });
      if (unanswered !== -1) {
        say('Choose an answer or write a reply to each question.');
        fields.children[unanswered].querySelector<HTMLElement>('input, textarea')?.focus();
        return;
      }
    }
    sending.add(entry.id);
    say();
    refreshQuestion();
    try {
      let result: ReplyResult;
      if (action === 'handoff') {
        result = { ok: await desktop.openAgent(entry.id), error: `Open ${agentName(entry)} to answer this question.` };
      } else if (entry.question.replyMode === 'direct') {
        result = await desktop.answer(entry.id, answers);
      } else {
        result = await desktop.copyReply(entry.id, answers);
      }
      if (current?.id !== entry.id) return;
      if (result.ok) close();
      else say(result.error || 'Your reply could not be sent. Please try again.');
    } catch {
      if (current?.id === entry.id) say('Could not reach your agent. Your reply is still here for you to try again.');
    } finally {
      sending.delete(entry.id);
      if (current?.id === entry.id) refreshQuestion();
    }
  }

  form.addEventListener('submit', event => {
    event.preventDefault();
    void respond('reply');
  });
  handoff.addEventListener('click', () => { void respond('handoff'); });
  letter.querySelector('.letter-close')!.addEventListener('click', close);
  letter.addEventListener('click', event => { if (event.target === letter) close(); });
  const onKey = (event: KeyboardEvent) => {
    if (!current) return;
    // Stop world shortcuts while reading or typing a reply.
    event.stopImmediatePropagation();
    if (event.code === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.code === 'Tab') {
      event.preventDefault();
      const controls = [...letter.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex="0"]')]
        .filter(element => !element.closest('[hidden], [inert]') && element.getClientRects().length);
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey
        ? (index <= 0 ? controls.length - 1 : index - 1)
        : (index + 1) % controls.length;
      controls[next]?.focus();
    }
  };
  window.addEventListener('keydown', onKey, true);

  return {
    open,
    get isReading() { return !!current; },
    refresh(bottles: AgentBottle[]) {
      for (const entry of bottles) {
        if (entry.question?.state !== 'pending') drafts.delete(entry.id);
      }
      if (!current) return;
      const updated = bottles.find(entry => entry.id === current!.id);
      if (updated) {
        if (!!updated.question !== !!current.question) {
          open(updated);
          return;
        }
        current = updated;
        refreshQuestion();
      }
    },
    updateActivity(state: BoatActivity, dt: number, visible: boolean) {
      const entry = state.bottles[0] || state.jobs[0];
      const caption = entry ? sourceLabel(entry) : '';
      const message = activityMessage(state);
      if (activityLine.textContent !== message || activityOrigin.textContent !== caption) {
        activityOrigin.textContent = caption;
        activityLine.textContent = message;
        activityAge = 0;
      }
      if (visible) activityAge += dt;
      const showing = visible && !!message && !state.nearby;
      activity.classList.toggle('visible', showing);
      activity.classList.toggle('settled', activityAge > 10);
      activity.setAttribute('aria-hidden', String(!showing));
    },
  };
}
