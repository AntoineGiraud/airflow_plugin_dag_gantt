/**
 * Tests du pipeline de dérivation — **sans React ni DOM** :
 *
 *   bun ./test/view.test.mjs
 *
 * Chaque fonction correspond à un `useMemo` du composant. Le composant reste couvert par le
 * test de rendu (`render.test.mjs`), mais celui-ci ne peut pas explorer les cas limites :
 * ex æquo de tri, filtre d'état unique, granularité `auto`, course entre une minute gelée
 * et un run en cours.
 *
 * Les dérivations prennent le **tableau de runs** (pas l'objet `data` renvoyé par l'API) :
 * c'est exactement ce que le `useMemo` du conteneur capture et déclare comme dépendance.
 */
import assert from 'node:assert/strict';
import { BIN_OPTIONS } from '../src/lib/aggregation.js';
import { DEFAULT_SORT, SORT_OPTIONS } from '../src/lib/constants.js';
import { fmtClock, todayLocal } from '../src/lib/time.js';
import {
  binHint,
  buildGroupingInputs,
  buildItemsByDag,
  buildRows,
  buildTipIndex,
  DEFAULT_BIN,
  filterRuns,
  hasLiveRuns,
  listStates,
  listTags,
  mergeLegendStates,
  readInitialView,
  resolveBinMs,
  stateCounts,
  summaryLabel,
  summaryTitle,
  viewToQuery,
  windowChipTitle,
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

/* ------------------------------- filtres ------------------------------- */

// Signature positionnelle, calquée sur les variables d'état du composant :
// filterRuns(runs, nameFilter, tagFilter, stateFilter, stateSet).
const states = (sel) => [sel].flat();
const setOf = (sel) => new Set(states(sel));
assert.equal(filterRuns(runs, '', '', [], null).length, 4, 'aucun filtre = tout');
assert.equal(filterRuns(runs, 'alp', '', [], null).length, 3, 'aiguille sur dag_id');
assert.equal(filterRuns(runs, 'RUN_BETA_001', '', [], null).length, 1, 'aiguille non sensible à la casse');
assert.equal(filterRuns(runs, '  ', '', [], null).length, 4, 'aiguille blanche = pas un filtre');
assert.equal(filterRuns(runs, '', 'nuit', [], null).length, 2, 'tag exact');
assert.equal(filterRuns(runs, '', '', states('failed'), setOf('failed')).length, 1, 'un état sélectionné');
assert.equal(filterRuns(runs, '', '', states(['failed', 'running']), setOf(['failed', 'running'])).length, 2, 'plusieurs états = OU');
assert.equal(filterRuns(runs, '', '', [], new Set(['failed'])).length, 4, 'sélection vide = pas de filtre (le set seul ne filtre pas)');
assert.equal(filterRuns(runs, 'alp', 'nuit', [], null).length, 1, 'filtres combinés = ET');

/* ------------------------------- compteurs par état ------------------------------- */

const counts = stateCounts(runs, '', '');
assert.deepEqual(counts, { success: 2, failed: 1, running: 1 }, 'répartition de la journée');
// Ces comptes préfigurent ce que **chaque case** ajoutera ou retirera : ils intègrent les
// autres filtres, mais jamais le filtre d'état.
assert.deepEqual(stateCounts(runs, '', 'nuit'), { running: 1, success: 1 }, 'comptes restreints au tag');
assert.deepEqual(stateCounts(runs, 'alp', ''), { success: 2, failed: 1 }, 'aiguille insensible à la casse : alpha + ALPHA');

/* ------------------------------- tags & états connus ------------------------------- */

assert.deepEqual(listTags(runs), ['nuit', 'spark'], 'tags uniques triés');
assert.deepEqual(listStates(runs), ['queued', 'running', 'success', 'failed'].filter((s) => ['running', 'success', 'failed'].includes(s)), 'dans l\'ordre de la légende');
assert.deepEqual(mergeLegendStates(listStates(runs)), ['queued', 'running', 'success', 'failed'], 'la légende montre aussi un état absent de la journée');
assert.equal(hasLiveRuns([mk('z', 1)]), false, 'rien en cours = pas de tick rapide');
assert.equal(hasLiveRuns(runs), true, 'un run running ou queued déclenche le tick de 5 s');

/* ------------------------------- lignes par DAG ------------------------------- */

const byFirst = buildRows(runs, 'first', NOW);
assert.deepEqual(
  byFirst.map((r) => r.dagId),
  ['beta', 'alpha', 'ALPHA'], // 8 h, 9 h, 11 h
  'tri par 1er run croissant : le DAG qui démarre le plus tôt est en haut'
);
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

// Ex æquo sur le critère : sans départage, les lignes ex æquo gardent l'ordre renvoyé par
// l'API (ici zoulou avant alpha, mike avant charlie) et dansent d'un rafraîchissement à
// l'autre. Deux paires construites pour être strictement égales sur firstStart, puis sur lastEnd.
const tied = {
  runs: [
    mk('zoulou', 1, { h: 7 }),
    mk('alpha', 1, { h: 7 }),
    mk('mike', 1, { h: 6, dur: 60 }), // finit à 7 h comme zoulou et alpha démarrent
    mk('charlie', 1, { h: 6, dur: 60 }),
  ],
};
assert.deepEqual(
  buildRows(tied.runs, 'first', NOW).map((r) => r.dagId),
  ['charlie', 'mike', 'alpha', 'zoulou'],
  '1er run à égalité = nom de DAG croissant'
);
assert.deepEqual(
  buildRows(tied.runs, 'last', NOW).map((r) => r.dagId),
  ['alpha', 'zoulou', 'charlie', 'mike'],
  'dernier run décroissant, et nom croissant à égalité de fin'
);

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

/* ------------------------------- URL partageable ⇄ vue ------------------------------- */

// Une URL vide donne la vue par défaut, et RIEN d'autre : ces quatre valeurs sont ce que voit
// un collègue à qui l'on envoie le lien sans paramètre.
const empty = readInitialView(new URLSearchParams(''));
assert.deepEqual(
  empty,
  {
    date: todayLocal(),
    nameFilter: '',
    tagFilter: '',
    stateFilter: [],
    zoomAuto: true,
    sortKey: DEFAULT_SORT,
    bin: DEFAULT_BIN,
    grouped: true,
    stagesText: '',
    collapsed: new Set(),
  },
  'URL vide = vue par défaut (zoom auto, groupé, agrégation auto)'
);

// Une URL chargée se relit champ par champ — dont l'état en multi-sélection et les groupes
// repliés, tous deux portés par des listes séparées par des virgules.
const loaded = readInitialView(
  new URLSearchParams(
    'date=2026-11-02&q= nuit &tag=nuit&state=failed,,running&sort=count&zoom=day&bin=15m&group=0&stages=collecte&collapsed=a,,b'
  )
);
assert.equal(loaded.date, '2026-11-02', 'la date de l\'URL prime sur aujourd\'hui');
assert.deepEqual(loaded.stateFilter, ['failed', 'running'], 'états : une virgule vide ne crée pas un état fantôme');
assert.deepEqual([...loaded.collapsed], ['a', 'b'], 'groupes repliés relus comme un Set');
assert.equal(loaded.zoomAuto, false, '?zoom=day = journée complète');
assert.equal(loaded.grouped, false, '?group=0 = liste plate');
assert.equal(loaded.bin, '15m', 'tranche fixe relue');

// Valeur inconnue = repli sur le défaut, jamais une valeur qui traverserait jusqu'au sélecteur.
assert.equal(readInitialView(new URLSearchParams('sort=nimporte-quoi')).sortKey, DEFAULT_SORT, 'tri inconnu = tri par défaut');
assert.ok(
  readInitialView(new URLSearchParams('sort=name')).sortKey === 'name' &&
    SORT_OPTIONS.some((o) => o.value === 'name'),
  'un tri connu passe'
);
assert.equal(readInitialView(new URLSearchParams('bin=99m')).bin, DEFAULT_BIN, 'tranche inconnue = auto');
assert.ok(BIN_OPTIONS.some((o) => o.value === readInitialView(new URLSearchParams('bin=60m')).bin), 'tranche connue = conservée');

// `viewToQuery` est l'inverse de `readInitialView` : une vue par défaut ne laisse **aucun**
// paramètre dans l'URL (sinon le lien de partage ressemble à ?date=…&sort=first&bin=auto…). 
assert.deepEqual(
  viewToQuery(empty),
  { date: '', q: '', tag: '', state: '', sort: '', zoom: '', bin: '', group: '', stages: '', collapsed: '' },
  'vue par défaut = URL propre'
);
assert.deepEqual(viewToQuery(loaded), {
  date: '2026-11-02',
  q: 'nuit', // l'aiguille est tronquée avant d'être écrite
  tag: 'nuit',
  state: 'failed,running',
  sort: 'count',
  zoom: 'day',
  bin: '15m',
  group: '0',
  stages: 'collecte',
  collapsed: 'a,b',
});
// Aller/retour : ce qui a été écrit dans l'URL se relit à l'identique — à l'aiguille près,
// qui repart déjà tronquée (`viewToQuery` la `trim` avant de l'écrire, pour une URL propre).
const roundTripQuery = new URLSearchParams();
Object.entries(viewToQuery(loaded))
  .filter(([, v]) => v)
  .forEach(([k, v]) => roundTripQuery.set(k, v));
const roundTrip = readInitialView(roundTripQuery);
assert.deepEqual(roundTrip, { ...loaded, nameFilter: 'nuit' }, 'écriture puis relecture de l\'URL redonne la même vue');
// Et une seconde écriture ne change plus rien : la sync URL est un point fixe dès le 2e passage.
assert.deepEqual(viewToQuery(roundTrip), viewToQuery(loaded), 'réécrire la même vue ne change pas l\'URL');

/* ------------------------------- textes du ruban ------------------------------- */

assert.ok(binHint('auto').includes('30 min maximum'), 'auto explique sa granularité');
assert.equal(binHint('off'), 'Une barre par run : aucune agrégation.');
assert.equal(binHint('15m'), 'Une barre par tranche de 15 min ; rouge dès qu\'un run du bucket a échoué.');
assert.equal(summaryLabel(1, 0), '1 run', 'un seul run reste au singulier');
assert.equal(summaryLabel(1270, 0), '1270 runs', 'sans fusion, rien de plus à dire');
assert.equal(summaryLabel(1270, 1097), '1270 runs · 1097 fusionnés');
assert.equal(
  summaryTitle({ windowStart: DAY_START + 8 * H, windowSpan: 2 * H, zoomed: false, mergedCount: 0, binMs: 5 * M }),
  `${fmtClock(DAY_START + 8 * H)} → ${fmtClock(DAY_START + 10 * H)} (2h 00m, journée complète)`,
  'aucun fusion = la title ne parle pas de tranche'
);
// Les heures viennent de `fmtClock`, donc de la locale du navigateur : l'assertion les reprend
// telles quelles, seule la **forme** du texte est vérifiée (sinon le test rouge selon la machine).
assert.ok(
  summaryTitle({ windowStart: DAY_START + 8 * H, windowSpan: 2 * H, zoomed: true, mergedCount: 3, binMs: 5 * M }).includes('· 3 runs fusionnés par tranche de 5 min'),
  'des fusions = la tranche est nommée'
);
assert.ok(
  summaryTitle({ windowStart: DAY_START + 8 * H, windowSpan: 2 * H, zoomed: true, mergedCount: 3, binMs: 5 * M }).includes('fenêtre ajustée aux runs filtrés'),
  'zoom auto = la fenêtre le dit'
);
assert.ok(windowChipTitle({ windowStart: DAY_START + 8 * H, windowSpan: 2 * H, zoomAuto: true }).includes('afficher les 24 h'), 'le zoom auto propose la journée');
assert.ok(windowChipTitle({ windowStart: DAY_START + 8 * H, windowSpan: 2 * H, zoomAuto: false }).includes('zoomer sur les runs filtrés'), 'la journée propose le zoom');

console.log('view.test.mjs : filtres, compteurs, lignes, granularité, buckets, URL, textes — ok');
