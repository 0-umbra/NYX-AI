/**
 * Model tiers. FRONTEND SELECTION ONLY — no model is connected in this stage.
 * Descriptions describe planned behaviour. Stage 3 sends `model` ('free' | 'pro' | 'max') to the API gateway,
 * which decides what each tier maps to.
 */
import { escapeHtml } from './util.js';
import { $, icon, radioGroup, enableLightDismiss, toast } from './ui.js';

export const MODELS = Object.freeze([
  { id: 'free', name: 'FREE', tagline: 'Everyday assistant', description: 'Quick answers and simple drafting.',
    traits: ['Optimised for speed', 'Short, everyday tasks'] },
  { id: 'pro', name: 'PRO', tagline: 'Deeper reasoning', description: 'Stronger reasoning for longer, more complex work.',
    traits: ['Deeper reasoning', 'Longer writing and analysis'] },
  { id: 'max', name: 'MAX', tagline: 'Maximum capability', description: 'The most capable tier for demanding, multi-step tasks.',
    traits: ['Highest capability', 'Complex, multi-step work'] },
]);
export const DEFAULT_MODEL_ID = 'free';
export const isModelId = (id) => MODELS.some((m) => m.id === id);
export const getModel = (id) => MODELS.find((m) => m.id === id) ?? MODELS[0];

const optionHtml = (m) => `<button type="button" role="radio" class="tier" data-value="${m.id}" aria-checked="false">`
  + `<span class="tier-name">${m.name}</span><span class="tier-body"><span class="tier-tag">${escapeHtml(m.tagline)}</span>`
  + `<span class="tier-desc">${escapeHtml(m.description)}</span></span>${icon('check')}</button>`;

const cardHtml = (m) => `<article class="card" data-card="${m.id}"><div class="card-head"><span class="card-title">${m.name}</span>`
  + `<span class="badge badge-warn">Not connected</span></div><p>${escapeHtml(m.tagline)}. ${escapeHtml(m.description)}</p>`
  + `<ul aria-label="Planned behaviour">${m.traits.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
  + `<button type="button" class="btn btn-block" data-select-model="${m.id}"></button></article>`;

export function initModels({ storage, onCompare }) {
  let id = storage.get('model', DEFAULT_MODEL_ID);
  if (!isModelId(id)) id = DEFAULT_MODEL_ID;
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
      btn.textContent = selected ? 'Selected' : `Use ${getModel(card.dataset.card).name}`;
      btn.disabled = selected;
    });
  }

  function set(next) {
    if (!isModelId(next) || next === id) return;
    id = next;
    storage.set('model', id);
    sync();
    subs.forEach((fn) => fn(id));
  }

  $('model-chip').addEventListener('click', () => {
    sheet.showModal();
    options.querySelector('[aria-checked="true"]')?.focus();
  });
  $('model-compare').addEventListener('click', () => { sheet.close(); onCompare?.(); });
  cards.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-select-model]');
    if (!btn) return;
    set(btn.dataset.selectModel);
    toast(`${getModel(btn.dataset.selectModel).name} selected`);
  });
  enableLightDismiss(sheet);
  sync();

  return { get id() { return id; }, set, subscribe(fn) { subs.add(fn); return () => subs.delete(fn); } };
}
