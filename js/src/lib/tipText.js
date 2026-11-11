/**
 * Texte des infobulles — **fonction pure**, sans React (`js/test/tipText.test.mjs`).
 *
 * Construit **a la demande**, uniquement pour la barre survolee : la version historique
 * concatenait le texte des ~1270 infobulles a chaque render (une frappe dans « Nom du DAG »
 * declenchait 1270 concatinations + une re-creation du DOM, 3 a 6 s sous charge).
 */

import { fmtDuration, fmtTime, fmtTimeMs } from './time.js';

export const TIP_DELAY_MS = 100; // même ressenti que l'ancien openDelay des TooltipRoot
export const TIP_MAX_WIDTH = 380;
export const TIP_RUN_LINES = 5; // lignes de runs détaillées dans le tooltip d'un bucket

export const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Texte du tooltip, construit **à la demande** (plus de concaténation de ~1270 chaînes au render). */
export const tipTextFor = (item) => {
  if (!item) return '';
  if (item.kind !== 'bucket') {
    const run = item.run;
    const tags = run.tags && run.tags.length ? `\ntags: ${run.tags.join(', ')}` : '';
    return (
      `${run.run_id}\n` +
      `${fmtTime(run.start)} → ${run.end ? fmtTime(run.end) : '(en cours)'} · ` +
      `${fmtDuration(item.endMs - item.startMs)}${tags}`
    );
  }
  const repartition = Object.keys(item.states)
    .sort((a, b) => item.states[b] - item.states[a] || a.localeCompare(b))
    .map((state) => `${state} ${item.states[state]}`)
    .join(' · ');
  const lines = item.runs
    .slice(0, TIP_RUN_LINES)
    .map((run) => `  ${clip(run.run_id, 58)}  ${run.state || 'none'}`);
  const rest = item.count - lines.length;
  return [
    `${item.dagId} · ${item.count} runs · ${fmtTimeMs(item.startMs)} → ` +
      `${item.open ? '(en cours)' : fmtTimeMs(item.endMs)} · ${fmtDuration(item.endMs - item.startMs)}`,
    repartition,
    ...lines,
    rest > 0 ? `  … +${rest} autres` : '',
  ]
    .filter(Boolean)
    .join('\n');
};
