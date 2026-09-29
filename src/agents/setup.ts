import './agents.css';
import { desktop, type AgentProvider, type SetupState } from './bridge';

/** One setup sheet: choose agents, install their hooks, then show only the steps left to the user. */
export function createAgentSetup(onModalChange: (open: boolean) => void) {
  if (!desktop) return { isOpen: false, open: async () => {}, start: async () => {} };
  const bridge = desktop.setup;

  const dialog = document.createElement('dialog');
  dialog.className = 'hook-setup letter';
  dialog.setAttribute('aria-labelledby', 'setup-title');
  dialog.innerHTML = `
    <button class="letter-close" aria-label="Close agent setup"><span>Esc</span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M6 18 18 6"/></svg></button>
    <div class="letter-body setup-body">
      <p class="setup-eyebrow">A note before you settle in</p>
      <h1 id="setup-title" tabindex="-1">Bring your agent along.</h1>
      <p class="setup-intro"></p>
      <div class="setup-agents"></div>
      <p class="setup-error" role="status" hidden></p>
      <div class="setup-actions">
        <button class="letter-send setup-connect">Connect selected</button>
        <button class="letter-handoff setup-done">Set up later</button>
      </div>
      <button class="setup-back" hidden>Connect another agent</button>
      <p class="setup-footnote">You can always return here from Settings.</p>
    </div>`;
  document.body.append(dialog);
  const intro = dialog.querySelector<HTMLElement>('.setup-intro')!;
  const list = dialog.querySelector<HTMLElement>('.setup-agents')!;
  const error = dialog.querySelector<HTMLElement>('.setup-error')!;
  const connect = dialog.querySelector<HTMLButtonElement>('.setup-connect')!;
  const done = dialog.querySelector<HTMLButtonElement>('.setup-done')!;
  const back = dialog.querySelector<HTMLButtonElement>('.setup-back')!;
  const close = dialog.querySelector<HTMLButtonElement>('.letter-close')!;
  let state: SetupState = { firstRun: true, agents: [] };
  let selected = new Set<AgentProvider>();
  let attempted = false;
  let busy = false;

  function say(message = '') {
    error.textContent = message;
    error.hidden = !message;
  }

  function renderActions() {
    const pending = state.agents.filter(agent => selected.has(agent.id) && (!agent.installed || agent.needsUpdate));
    connect.hidden = attempted && !pending.length;
    connect.disabled = busy || !pending.length;
    connect.textContent = busy ? 'Connecting…' : attempted ? 'Try again' : 'Connect selected';
    done.disabled = close.disabled = busy;
    done.textContent = attempted ? 'Enter the island' : 'Set up later';
    done.className = connect.hidden ? 'letter-send setup-done' : 'letter-handoff setup-done';
    back.hidden = !attempted || state.agents.every(agent => agent.installed && !agent.needsUpdate);
    back.disabled = busy;
  }

  function render() {
    const agents = attempted ? state.agents.filter(agent => agent.installed || selected.has(agent.id)) : state.agents;
    intro.textContent = attempted
      ? 'The connections below are saved. Finish any steps shown, then make yourself at home.'
      : 'Your agent’s replies can arrive by boat. Choose the agents you use; we’ll install their connections for you.';
    if (attempted && agents.some(agent => agent.error)) intro.textContent = 'Review the notes below to finish connecting your agents.';
    list.replaceChildren();
    for (const agent of agents) {
      const ready = agent.installed && !agent.needsUpdate;
      const row = document.createElement('section');
      row.className = 'setup-agent';
      row.innerHTML = `
        <label class="setup-choice">
          <input type="checkbox">
          <span class="setup-mark" aria-hidden="true"><svg viewBox="0 0 22 22"><path d="m3 12 5 4L19 5"/></svg></span>
          <span><span class="setup-name"></span><span class="setup-status"></span></span>
        </label>`;
      const input = row.querySelector('input')!;
      input.checked = ready || selected.has(agent.id);
      input.disabled = busy || ready;
      input.addEventListener('change', () => {
        if (input.checked) selected.add(agent.id);
        else selected.delete(agent.id);
        renderActions();
      });
      row.querySelector('.setup-name')!.textContent = agent.name === 'VS Code' ? 'VS Code · Local' : agent.name;
      let status = agent.detected ? 'Found on your Mac' : 'Not detected · you can still select it';
      if (agent.needsUpdate) status = 'Connection update available';
      else if (ready) status = agent.connected ? 'Connected · your agent has checked in' : 'Connection installed';
      if (agent.error) status = 'Could not finish setup';
      row.querySelector('.setup-status')!.textContent = status;
      if (agent.error || (ready && agent.instruction)) {
        const note = document.createElement('p');
        note.className = 'setup-step';
        note.textContent = agent.error || agent.instruction;
        const action = document.createElement('button');
        action.className = 'setup-link';
        action.textContent = agent.error ? 'Show settings file' : `Open ${agent.name}`;
        action.disabled = busy;
        action.addEventListener('click', async () => {
          try {
            if (agent.error) await bridge.showConfig(agent.id);
            else if (!await bridge.openAgent(agent.id)) say(`Open ${agent.name} to complete this step.`);
          } catch { say(`Could not open ${agent.name}. You can finish this step in the agent.`); }
        });
        row.append(note, action);
      }
      list.append(row);
    }
    renderActions();
  }

  async function finish() {
    if (busy) return;
    try {
      await bridge.dismiss();
      dialog.close();
    } catch { say('Could not save your setup preference. Please try again.'); }
  }

  async function open() {
    if (dialog.open) return;
    onModalChange(true);
    dialog.showModal();
    dialog.querySelector<HTMLElement>('h1')!.focus();
    intro.textContent = 'Looking for your agents…';
    connect.disabled = true;
    say();
    try {
      state = await bridge.state();
      if (!dialog.open) return;
      selected = new Set(state.agents.filter(agent => agent.detected && (!agent.installed || agent.needsUpdate)).map(agent => agent.id));
      attempted = state.agents.some(agent => agent.installed) && !selected.size;
      render();
    } catch { say('Could not check your agents. Close this note and try again from Settings.'); }
  }

  connect.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    say();
    render();
    try {
      state = await bridge.install([...selected]);
      attempted = true;
    } catch { say('Could not complete setup. Please try again.'); }
    finally {
      busy = false;
      render();
    }
  });
  done.addEventListener('click', () => { void finish(); });
  close.addEventListener('click', () => { void finish(); });
  back.addEventListener('click', () => {
    attempted = false;
    selected.clear();
    render();
  });
  dialog.addEventListener('cancel', event => {
    event.preventDefault();
    void finish();
  });
  dialog.addEventListener('close', () => onModalChange(false));
  dialog.addEventListener('keydown', event => event.stopPropagation());
  bridge.subscribe(next => {
    state = next;
    if (dialog.open && !busy) render();
  });

  return {
    get isOpen() { return dialog.open; },
    open,
    /** Open on the first launch. */
    async start() {
      try {
        if ((await bridge.state()).firstRun) await open();
      } catch { /* Setup remains available from Settings if the first read fails. */ }
    },
  };
}
