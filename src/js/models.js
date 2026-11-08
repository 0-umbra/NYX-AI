/** Model availability is explicit so future tiers remain locked until supported. */
import { escapeHtml } from './util.js';
import { $, icon, radioGroup, enableLightDismiss, toast } from './ui.js';

export const MODELS = Object.freeze([
  { id: 'free', available: true, name: 'FREE', tagline: 'Everyday assistant', description: 'Quick answers and simple drafting.',
    traits: ['Optimised for speed', 'Short, everyday tasks'] },
  { id: 'pro', available: false, name: 'PRO', tagline: 'Deeper reasoning', description: 'Stronger reasoning for longer, more complex work.',
    traits: ['Deeper reasoning', 'Longer writing and analysis'] },
  { id: 'max', available: false, name: 'MAX', tagline: 'Maximum capability', description: 'The most capable tier for demanding, multi-step tasks.',
    traits: ['Highest capability', 'Complex, multi-step work'] },
]);
export const DEFAULT_MODEL_ID = 'free';
export const isModelId = (id) => MODELS.some((m) => m.id === id);
export const isModelAvailable = (id) => MODELS.some((m) => m.id === id && m.available);
export const getModel = (id) => MODELS.find((m) => m.id === id) ?? MODELS[0];

const optionHtml = (m) => `<button type="button" ${m.available ? 'role="radio" aria-checked="false"' : 'aria-disabled="true"'} class="tier" data-value="${m.id}">`
  + `<span class="tier-name">${m.name}</span><span class="tier-body"><span class="tier-tag">${escapeHtml(m.tagline)}</span>`
  + `<span class="tier-desc">${escapeHtml(m.description)}</span></span>${m.available ? icon('check') : '<span class="tier-lock">Coming soon</span>'}</button>`;

const cardHtml = (m) => `<article class="card" data-card="${m.id}"><div class="card-head"><span class="card-title">${m.name}</span>`
  + `<span class="badge ${m.available ? '' : 'badge-warn'}">${m.available ? 'Available' : 'Coming soon'}</span></div><p>${escapeHtml(m.tagline)}. ${escapeHtml(m.description)}</p>`
  + `<ul aria-label="Capabilities">${m.traits.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
  + `<button type="button" class="btn btn-block" data-select-model="${m.id}"${m.available ? '' : ' aria-disabled="true"'}></button></article>`;

export function initModels({ storage, onCompare }) {
  let id = storage.get('model', DEFAULT_MODEL_ID);
  if (!isModelAvailable(id)) { id = DEFAULT_MODEL_ID; storage.set('model', id); }
  const subs = new Set();
  const sheet = $('model-sheet');
  const options = $('model-options');
  const cards = $('model-cards');

  options.innerHTML = MODELS.map(optionHtml).join('');
  cards.innerHTML = MODELS.map(cardHtml).join('');
  const group = radioGroup(options, (v) => set(v));

  function sync() {
    const model = getModel(id);
    $('model-chip-label').textContent = model.name;
    $('model-chip').setAttribute('aria-label', `Model tier: ${model.name}. Change tier`);
    group.set(id);
    cards.querySelectorAll('[data-card]').forEach((card) => {
      const selected = card.dataset.card === id;
      card.classList.toggle('is-selected', selected);
      const btn = card.querySelector('[data-select-model]');
      btn.textContent = !isModelAvailable(card.dataset.card) ? 'Locked · Coming soon' : selected ? 'Selected' : `Use ${getModel(card.dataset.card).name}`;
      btn.disabled = selected;
    });
  }

  function set(next) {
    if (!isModelAvailable(next)) { if (isModelId(next)) toast(`${getModel(next).name} is not available yet.`); return; }
    if (next === id) return;
    id = next;
    storage.set('model', id);
    sync();
    subs.forEach((fn) => fn(id));
  }

  options.addEventListener('click', (e) => {
    const locked = e.target.closest('[aria-disabled="true"][data-value]');
    if (locked) set(locked.dataset.value);
  });

  $('model-chip').addEventListener('click', () => {
    sheet.showModal();
    options.querySelector('[aria-checked="true"]')?.focus();
  });
  $('model-compare').addEventListener('click', () => { sheet.close(); onCompare?.(); });
  cards.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-select-model]');
    if (!btn) return;
    set(btn.dataset.selectModel);
    if (isModelAvailable(btn.dataset.selectModel)) toast(`${getModel(btn.dataset.selectModel).name} selected`);
  });
  enableLightDismiss(sheet);
  sync();

  return { get id() { return id; }, set, subscribe(fn) { subs.add(fn); return () => subs.delete(fn); } };
}
