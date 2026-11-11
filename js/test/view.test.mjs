/**
 * Tests du pipeline de dérivation — **sans React ni DOM** :
 *
 *   bun ./test/view.test.mjs
 *
 * Chaque fonction correspond à un `useMemo` du composant. Le composant reste couvert par le
 * test de rendu (`render.test.mjs`), mais celui-ci ne peut pas explorer les cas limites :
 * ex æquo de tri, filtre d'état unique, granularité `auto`, course entre une minute gelée
 * et un run en cours.
 */
import assert from 'node:assert/strict';
import { BIN_OPTIONS } from '../src/lib/aggregation.js';
import {
  buildGroupingInputs,
  buildItemsByDag,
  buildRows,
  buildTipIndex,
  filterRuns,
  hasLiveRuns,
  listStates,
  listTags,
  mergeLegendStates,
  resolveBinMs,
  stateCounts,
} from '../src/lib/view.js';

const DAY = '2026-11-10';
const DAY_START = Date.parse(`${DAY}T00:00:00`);
const H = 3600_000;
const M = 60_000;
const at = (h, m = 0, s = 0) => new Date(DAY_START + h * H + m * M + s * 1000).toISOString();
const NOW = DAY_START + 20 * H;

const mk = (dagId, i, { state = 'success', h = 9, m = 0, dur = 5, tags = ['spark'] } = {}) => ({
  dag_id: dagId,
  run_id: `run_${dagId}_${String(i).padStart(3, '0')}`,
  state,
  start: at(h, m),
  end: state === 'running' || state === 'queued' ? null : at(h, m + dur),
  logical_date: at(h, m),
  tags,
});

const runs = [
  mk('alpha', 1, { h: 9 }),
  mk('alpha', 2, { h: 10, state: 'failed' }),
  mk('ALPHA', 3, { h: 11, tags: ['spark', 'nuit'] }), // DAG distinct, casse différente
  mk('beta', 1, { h: 8, state: 'running', dur: 0, tags: ['nuit'] }),
];
const data = { runs, count: runs.length };

/* ------------------------------- filtres ------------------------------- */

// Signature positionnelle, calquée sur les variables d'état du composant :
// filterRuns(data, nameFilter, tagFilter, stateFilter, stateSet).
const states = (sel) => [sel].flat();
const setOf = (sel) => new Set(states(sel));
assert.equal(filterRuns(data, '', '', [], null).length, 4, 'aucun filtre = tout');
assert.equal(filterRuns(data, 'alp', '', [], null).length, 3, 'aiguille sur dag_id');
assert.equal(filterRuns(data, 'RUN_BETA_001', '', [], null).length, 1, 'aiguille non sensible à la casse');
assert.equal(filterRuns(data, '  ', '', [], null).length, 4, 'aiguille blanche = pas un filtre');
assert.equal(filterRuns(data, '', 'nuit', [], null).length, 2, 'tag exact');
assert.equal(filterRuns(data, '', '', states('failed'), setOf('failed')).length, 1, 'un état sélectionné');
assert.equal(filterRuns(data, '', '', states(['failed', 'running']), setOf(['failed', 'running'])).length, 2, 'plusieurs états = OU');
assert.equal(filterRuns(data, '', '', [], new Set(['failed'])).length, 4, 'sélection vide = pas de filtre (le set seul ne filtre pas)');
assert.equal(filterRuns(data, 'alp', 'nuit', [], null).length, 1, 'filtres combinés = ET');

/* ------------------------------- compteurs par état ------------------------------- */

const counts = stateCounts(data, '', '');
assert.deepEqual(counts, { success: 2, failed: 1, running: 1 }, 'répartition de la journée');
// Ces comptes préfigurent ce que **chaque case** ajoutera ou retirera : ils intègrent les
// autres filtres, mais jamais le filtre d'état.
assert.deepEqual(stateCounts(data, '', 'nuit'), { running: 1, success: 1 }, 'comptes restreints au tag');
assert.deepEqual(stateCounts(data, 'alp', ''), { success: 2, failed: 1 }, 'aiguille insensible à la casse : alpha + ALPHA');

/* ------------------------------- tags & états connus ------------------------------- */

assert.deepEqual(listTags(data), ['nuit', 'spark'], 'tags uniques triés');
assert.deepEqual(listStates(data), ['queued', 'running', 'success', 'failed'].filter((s) => ['running', 'success', 'failed'].includes(s)), 'dans l\'ordre de la légende');
assert.deepEqual(mergeLegendStates(listStates(data)), ['queued', 'running', 'success', 'failed'], 'la légende montre aussi un état absent de la journée');
assert.equal(hasLiveRuns({ runs: [mk('z', 1)] }), false, 'rien en cours = pas de tick rapide');
assert.equal(hasLiveRuns(data), true, 'un run running ou queued déclenche le tick de 5 s');

/* ------------------------------- lignes par DAG ------------------------------- */

const byFirst = buildRows(runs, 'first', NOW);
assert.deepEqual(byFirst.map((r) => r.dagId), ['ALPHA', 'alpha', 'beta'], 'tri par 1er run décroissant');
const alpha = byFirst.find((r) => r.dagId === 'alpha');
assert.equal(alpha.count, 2, 'une ligne par DAG, tous ses runs dedans');
assert.deepEqual(alpha.runs.map((r) => r.run_id), ['run_alpha_001', 'run_alpha_002'], 'runs triés par démarrage croissant');
assert.equal(alpha.tags.join(','), 'spark', 'les tags viennent du premier run');
assert.equal(alpha.firstStart, DAY_START + 9 * H);
assert.equal(alpha.maxDuration, 5 * M, 'durée max des runs de la ligne');

// Un run sans fin doit être traité avec le **temps gelé**, sinon la durée dépend de l'heure.
const beta = byFirst.find((r) => r.dagId === 'beta');
assert.equal(beta.maxDuration, NOW - (DAY_START + 8 * H), 'run en cours étiré jusqu\'au temps gelé');
assert.equal(buildRows(runs, 'first', NOW + 10 * M).find((r) => r.dagId === 'beta').maxDuration, NOW + 10 * M - (DAY_START + 8 * H), 'et suit ce temps gelé');

assert.deepEqual(buildRows(runs, 'count', NOW).map((r) => r.dagId)[0], 'alpha', 'tri par nombre de runs');
assert.deepEqual(
  buildRows(runs, 'name', NOW).map((r) => r.dagId),
  ['ALPHA', 'alpha', 'beta'].sort((a, b) => a.localeCompare(b)),
  'tri par nom'
);
assert.equal(buildRows(runs, 'inexistant', NOW).length, 3, 'critère inconnu = repli sur le tri par défaut');

/* ------------------------------- groupes ------------------------------- */

const { stages, tagRank } = buildGroupingInputs(byFirst, 'nuit,spark');
assert.deepEqual(stages, ['nuit', 'spark']);
// spark et nuit portent chacun 2 lignes (ALPHA a les deux) : égalité → alphabétique.
assert.equal(tagRank.get('nuit'), 0, 'à fréquence égale, « nuit » passe avant « spark »');
assert.equal(tagRank.get('spark'), 1);

/* ------------------------------- granularité ------------------------------- */

assert.equal(resolveBinMs('5m', 9 * H), 5 * M, 'tranche fixe : la fenêtre ne change rien');
assert.equal(resolveBinMs('off', 9 * H), null, 'off = aucune agrégation');
assert.ok(BIN_OPTIONS.some((o) => o.value === 'auto'), 'auto reste une option connue');
const autoSmall = resolveBinMs('auto', 30 * M);
const autoBig = resolveBinMs('auto', 20 * H);
assert.ok(autoSmall <= 5 * M && autoBig <= 30 * M, `auto grossit avec la fenêtre, plafonné à 30 min (${autoSmall / M} / ${autoBig / M})`);
assert.ok(resolveBinMs('nimporte-quoi', 9 * H) <= 30 * M, 'valeur inconnue = repli sur auto');

/* ------------------------------- items dessinés ------------------------------- */

const off = buildItemsByDag(byFirst, DAY_START, null, NOW);
assert.equal(off.mergedCount, 0, 'sans agrégation, rien n\'est fusionné');
assert.equal([...off.itemsByDag.values()].reduce((n, l) => n + l.length, 0), runs.length, 'une barre par run');

const binned = buildItemsByDag(byFirst, DAY_START, 5 * M, NOW);
assert.ok(binned.mergedCount === 0, 'runs espacés de plus d\'une tranche : rien à fusionner');

// Deux runs dans la même tranche de 5 min → un seul item, qui porte les deux états.
const tight = [{ ...runs[0], start: at(9, 0), end: at(9, 2) }, { ...runs[0], run_id: 'run_alpha_999', state: 'failed', start: at(9, 1), end: at(9, 4) }];
const tightRows = buildRows(tight, 'first', NOW);
const merged = buildItemsByDag(tightRows, DAY_START, 5 * M, NOW);
const items = merged.itemsByDag.get('alpha');
assert.equal(items.length, 1, 'les deux runs tombent dans la même tranche');
assert.equal(items[0].kind, 'bucket');
assert.equal(items[0].count, 2);
assert.deepEqual(items[0].states, { success: 1, failed: 1 }, 'le bucket garde la répartition des états');
assert.equal(merged.mergedCount, 1, '2 runs, 1 barre = 1 fusionné');

const index = buildTipIndex(merged.itemsByDag);
assert.equal(index.get(items[0].key), items[0], 'l\'index du tooltip pointe sur le même objet');

console.log('view.test.mjs : filtres, compteurs, lignes, granularité, buckets — ok');
