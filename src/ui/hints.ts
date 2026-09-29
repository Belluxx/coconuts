import './hints.css';

type Movement = 'walk' | 'swim' | 'row';
export interface IslandAction { label: string; key: string; run: () => void }
interface HintState { action?: IslandAction; movement: Movement; looking: boolean; visible: boolean }

const guides: Record<Movement, string> = {
  walk: '<span><kbd>W A S D</kbd> walk</span><span>Mouse to look</span>',
  swim: '<span>Swim where you look</span><span><kbd>Space</kbd> rise</span><span><kbd>C</kbd> dive</span>',
  row: '<span><kbd>W S</kbd> row</span><span><kbd>A D</kbd> steer</span><span><kbd>Home</kbd> return</span>',
};

/** One action at a time; movement instructions quietly leave once learned. */
export function createHints(parent: HTMLElement) {
  const root = document.createElement('div');
  root.className = 'interaction-hints';
  root.innerHTML = `
    <div class="interaction-cue" aria-live="polite" inert>
      <button class="interaction-action"><span></span><kbd></kbd></button>
    </div>
    <p class="movement-guide" aria-live="polite"></p>
    <p class="cursor-hint"><kbd>Esc</kbd><span>release cursor</span></p>`;
  parent.append(root);
  const cue = root.querySelector<HTMLElement>('.interaction-cue')!;
  const button = root.querySelector<HTMLButtonElement>('.interaction-action')!;
  const label = button.querySelector('span')!;
  const key = button.querySelector('kbd')!;
  const guide = root.querySelector<HTMLElement>('.movement-guide')!;
  const cursor = root.querySelector<HTMLElement>('.cursor-hint')!;
  let action: IslandAction | undefined;
  let movement: Movement | undefined;
  let guideTime = 0;
  let guideRequested = false;
  let visible = false;
  const show = (element: HTMLElement, open: boolean) => {
    if (element.getAttribute('aria-hidden') === String(!open)) return;
    element.classList.toggle('visible', open);
    element.setAttribute('aria-hidden', String(!open));
  };
  button.addEventListener('click', () => action?.run());
  const recall = (event: KeyboardEvent) => {
    if (!visible || event.key !== '?' || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    guideTime = 0;
    guideRequested = true;
  };
  window.addEventListener('keydown', recall);

  return {
    update(state: HintState, dt: number) {
      visible = state.visible;
      if (movement !== state.movement) {
        movement = state.movement;
        guide.innerHTML = guides[movement];
        guideTime = 0;
        guideRequested = false;
      }
      if (visible) guideTime += dt;
      action = visible ? state.action : undefined;
      if (action) {
        if (label.textContent !== action.label) label.textContent = action.label;
        if (key.textContent !== action.key) key.textContent = action.key;
      }
      cue.inert = !action;
      show(cue, !!action);
      // Keep navigation help available when the boat's exit action is showing.
      show(guide, visible && (!action || movement === 'row' || guideRequested) && guideTime < 9);
      show(cursor, visible && state.looking);
    },
  };
}
