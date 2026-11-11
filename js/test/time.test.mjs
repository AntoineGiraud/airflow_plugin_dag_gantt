/**
 * Tests des formats, de la fenêtre affichée et des graduations — **sans React ni DOM** :
 *
 *   bun ./test/time.test.mjs
 *
 * Le Gantt dessine en heures **locales** : les tests construisent donc des dates sans
 * décalage (`2026-11-10T09:00:00`) et n'attendent que des valeurs relatives.
 */
import assert from 'node:assert/strict';
import {
  buildTicks,
  computeWindow,
  fmtClock,
  fmtDuration,
  fmtSpanShort,
  fmtTimeMs,
  pickStepMs,
  shiftDate,
  todayLocal,
} from '../src/lib/time.js';

const DAY = '2026-11-10';
const DAY_START = Date.parse(`${DAY}T00:00:00`);
const H = 3600_000;
const M = 60_000;
const at = (h, m = 0) => new Date(DAY_START + h * H + m * M).toISOString();
// `end: null` == run **en cours** (la fenêtre s'étire alors jusqu'à `nowMs`).
const run = (h, m = 0, endH = null, endM = 0) => ({
  start: at(h, m),
  end: endH === null ? null : at(endH, endM),
});
const done = (h, m = 0, dh = 0, dm = 30) => run(h, m, h + dh, dm); // run terminé sous `dh` h

/* ------------------------------- dates ------------------------------- */

assert.match(todayLocal(), /^\d{4}-\d{2}-\d{2}$/, 'todayLocal renvoie un ISO local AAAA-MM-JJ');
assert.equal(shiftDate('2026-11-10', 1), '2026-11-11', 'jour suivant');
assert.equal(shiftDate('2026-11-01', -1), '2026-10-31', 'jour précédent, change de mois');
assert.equal(shiftDate('2026-03-01', -1), '2026-02-28', 'borne de mois non bissextile');
assert.equal(shiftDate('2024-03-01', -1), '2024-02-29', 'borne de mois bissextile');

/* ------------------------------- formats ------------------------------- */

assert.equal(fmtDuration(0), '0s');
assert.equal(fmtDuration(59_000), '59s');
assert.equal(fmtDuration(65_000), '1m 5s', 'minutes + secondes');
assert.equal(fmtDuration(2 * H + 30 * M), '2h 30m');
assert.equal(fmtDuration(-1), '—', 'durée négative = tiret, pas « -1s »');
assert.equal(fmtDuration(Number.NaN), '—', 'durée non finie = tiret');

// fmtSpanShort = **une seule** unité, arrondie : c'est ce que lit la puce de fenêtre.
assert.equal(fmtSpanShort(9 * H), '9 h');
assert.equal(fmtSpanShort(29 * M), '29 min', 'sous la demi-heure, en minutes');
// **Quirk assumé** : l'arrondi se fait à l'heure dès 30 min — une fenêtre de 45 min
// s'affiche « 1 h ». Choix historique de la puce, gardé tel quel par le refactor.
assert.equal(fmtSpanShort(45 * M), '1 h');
assert.equal(fmtSpanShort(24 * H), '24 h');
assert.equal(fmtSpanShort(9 * H + 29 * M), '9 h', 'arrondi à l\'heure la plus proche');

// Locaux : on ne compare pas à une chaîne (l'hôte peut être en hour12), mais au format.
assert.equal((fmtClock(DAY_START + 7.5 * H).match(/:/g) || []).length, 1, 'fmtClock = HH:MM');
assert.equal((fmtTimeMs(DAY_START).match(/:/g) || []).length, 2, 'fmtTimeMs = HH:MM:SS');
assert.equal(fmtTimeMs(Number.NaN), '—', 'borne non finie = tiret');

/* ------------------------------- fenêtre ------------------------------- */

// Journée complète : bornes 00:00 → 24:00, `zoomed` faux.
const full = computeWindow([done(9), done(10, 0, 1, 0)], DAY_START, false, DAY_START + 12 * H);
assert.equal(full.windowStart, DAY_START, 'zoom journée : départ à minuit');
assert.equal(full.windowSpan, 24 * H, 'zoom journée : 24 h');
assert.equal(full.zoomed, false);

// Zoom auto : la fenêtre épouse les runs, avec un peu d'air de chaque côté.
const zoom = computeWindow([done(9), done(10, 0, 1, 0)], DAY_START, true, DAY_START + 23 * H);
assert.ok(zoom.zoomed, 'zoom auto signalé');
assert.equal(zoom.windowSpan, 3 * H, 'deux runs proches : plancher de 3 h, centré sur l\'activité');
assert.ok(zoom.windowStart < DAY_START + 9 * H, 'de l\'air avant le premier run');
assert.ok(zoom.windowStart + zoom.windowSpan > DAY_START + 11 * H, 'de l\'air après le dernier');

// Un run **en cours** doit entrer dans la fenêtre sinon la barre sort du cadre.
const live = computeWindow([run(9, 0, 9, 30), run(20)], DAY_START, true, DAY_START + 20.5 * H);
assert.ok(live.windowStart + live.windowSpan >= DAY_START + 20.5 * H, 'la fenêtre suit un run en cours');

// Sous le plancher de 3 h, on garde 3 h de large (une fenêtre d'une minute serait inutilisable).
const tiny = computeWindow([done(12, 0, 0, 10), done(12, 5, 0, 10)], DAY_START, true, DAY_START + 13 * H);
assert.ok(tiny.windowSpan >= 3 * H, `largeur minimale de 3 h, obtenu ${tiny.windowSpan / M} min`);

// Pas de run du tout : on retombe sur la journée, jamais sur un span nul (division par zéro
// dans le positionnement des barres).
const empty = computeWindow([], DAY_START, true, DAY_START + 12 * H);
assert.equal(empty.windowSpan, 24 * H, 'journée vide = 24 h');

/* ------------------------------- graduations ------------------------------- */

// Le plus petit palier qui garde <= 12 traits : 1 h = 12 traits de 5 min, 9 h = 9 traits
// d'une heure (le palier 30 min en ferait 18), une journée = 12 traits de 2 h.
assert.equal(pickStepMs(1 * H), 5 * M, 'une heure => un trait par 5 min');
assert.equal(pickStepMs(9 * H), H, '9 h => un trait par heure');
assert.equal(pickStepMs(24 * H), 2 * H, 'une journée => un trait par 2 h');
assert.equal(pickStepMs(100 * H), 4 * H, 'au-delà des paliers, on s\'arrête au plus grand');

const ticks = buildTicks({
  windowStart: DAY_START + 7 * H,
  windowSpan: 9 * H,
  dayStart: DAY_START,
});
assert.ok(ticks.length > 0 && ticks.length <= 12, `<= 12 graduations, obtenu ${ticks.length}`);
assert.deepEqual(
  ticks.map((t) => t.label),
  ['07h', '08h', '09h', '10h', '11h', '12h', '13h', '14h', '15h', '16h'],
  'traits alignés sur les heures rondes, pas décalés selon la fenêtre'
);
assert.ok(Math.abs(ticks[0].pct) < 1e-9, 'le premier trait est au bord gauche');
assert.ok(Math.abs(ticks[ticks.length - 1].pct - 100) < 1e-9, 'le dernier est au bord droit');

// En dessous de l'heure, le libellé passe à l'heure + minutes — via `toLocaleTimeString`,
// donc **dépendant du locale** du navigateur (en-US ajoute « AM ») : on assertheure +
// minutes, pas la chaîne exacte. Les libellés « HHh » au-dessus de l'heure, eux, sont
// formatés à la main et donc invariants.
const dense = buildTicks({ windowStart: DAY_START + 9 * H, windowSpan: 45 * M, dayStart: DAY_START });
assert.match(dense[0].label, /09:00/, `HH:MM contenu dans le libellé, obtenu ${dense[0].label}`);
assert.ok(dense.length >= 9, `un trait par palier de 5 min sur 45 min, obtenu ${dense.length}`);

console.log(`time.test.mjs : ${'formats, dates, fenêtre et graduations — ok'}`);
