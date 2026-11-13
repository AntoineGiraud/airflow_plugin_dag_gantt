/**
 * Dérivations du Gantt : ce qu'on garde, comment on trie, comment on dessine, et ce que
 * l'écran en **dit**.
 * **Fonctions pures**, sans React ni DOM — chacune est le corps d'un `useMemo` du conteneur,
 * testée sous Node dans `js/test/view.test.mjs`.
 *
 * Pipeline : runs d'une journée → `filterRuns` → `buildRows` (une ligne par DAG)
 * → `buildGroups` (tag principal) → `buildItemsByDag` (runs isolés + buckets) → barres.
 *
 * Deux familles ici, dans le même esprit :
 *
 * - **l'aller/retour URL ↔ vue** (`readInitialView` / `viewToQuery`) : tout ce que l'URL porte,
 *   et uniquement la VUE — l'onglet ouvert du ruban y reste étranger, volontairement ;
 * - **les textes du ruban** (`binHint`, `summaryLabel`, `summaryTitle`, `windowChipTitle`) :
 *   un libellé est une donnée, pas une branche de rendu — il est donc testable.
 *
 * Les dérivations prennent le **tableau de runs**, jamais l'objet `data` renvoyé par l'API : le
 * `useMemo` qui les appelle capture exactement ce qu'il déclare comme dépendance ( rien de
 * sous-déclaré, donc jamais de calcul périmé).
 */

import { autoBinMs, BIN_OPTIONS, binLabel, bucketize, parseBin } from './aggregation.js';
import { DEFAULT_SORT, SORT_OPTIONS, STATE_ORDER } from './constants.js';
import { buildGroups, computeTagRank, parseStages } from './grouping.js';
import { fmtClock, fmtDuration, todayLocal } from './time.js';

/** `?q=` sur dag_id ou run_id, tag exact, états : sélection vide = tout. */
export const filterRuns = (runs, nameFilter, tagFilter, stateFilter, stateSet) => {
  const needle = nameFilter.trim().toLowerCase();
  return runs.filter(
    (r) =>
      (!needle ||
        r.dag_id.toLowerCase().includes(needle) ||
        r.run_id.toLowerCase().includes(needle)) &&
      (!tagFilter || r.tags.includes(tagFilter)) &&
      (!stateFilter.length || stateSet.has(r.state || 'none'))
  );
};

/**
 * Nombre de runs par état **sur les filtres hors état** : ce que chaque case ajoutera ou
 * retirera (la légende du bas, elle, compte sur la journée entière).
 */
export const stateCounts = (runs, nameFilter, tagFilter) => {
  const needle = nameFilter.trim().toLowerCase();
  const out = {};
  runs.forEach((r) => {
    if (
      needle &&
      !(r.dag_id.toLowerCase().includes(needle) || r.run_id.toLowerCase().includes(needle))
    )
      return;
    if (tagFilter && !r.tags.includes(tagFilter)) return;
    const s = r.state || 'none';
    out[s] = (out[s] || 0) + 1;
  });
  return out;
};

export const listTags = (runs) => Array.from(new Set(runs.flatMap((r) => r.tags))).sort();

/** États présents dans les données, dans l'ordre de la légende, puis les états rares triés. */
export const listStates = (runs) => {
  const found = new Set(runs.map((r) => r.state || 'none'));
  return STATE_ORDER.filter((s) => found.has(s)).concat(
    Array.from(found)
      .filter((s) => !STATE_ORDER.includes(s))
      .sort()
  );
};

/** Légende = tous les états connus, même absents de la journée (grisés, non cliquables). */
export const mergeLegendStates = (allStates) =>
  STATE_ORDER.concat(allStates.filter((s) => !STATE_ORDER.includes(s)));

/** De quoi animer les barres en cours : sans mouvement, l'horloge tourne à 60 s au lieu de 5 s. */
export const hasLiveRuns = (runs) => runs.some((r) => r.state === 'running' || r.state === 'queued');

/**
 * Une ligne par DAG, triée selon le critère choisi (`nowQ` : temps gelé pour les runs en cours).
 *
 * Sens des critères chronologiques : `first` est **croissant** (le DAG qui démarre le plus tôt
 * de la journée en haut — la lecture suit l'ordre d'exécution), `last` est **décroissant** (la
 * dernière activité récente en haut). Départage par nom de DAG : deux lignes qui démarrent ou
 * finissent à la même seconde garderaient sinon l'ordre arbitraire renvoyé par l'API, et
 * danseraient d'un rafraîchissement à l'autre.
 */
export const buildRows = (filtered, sortKey, nowQ) => {
  const byDag = new Map();
  filtered.forEach((r) => {
    if (!byDag.has(r.dag_id)) byDag.set(r.dag_id, []);
    byDag.get(r.dag_id).push(r);
  });
  const list = Array.from(byDag.entries()).map(([dagId, runs]) => {
    runs.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const lastRun = runs[runs.length - 1];
    const lastEnd = Date.parse(lastRun.end) || Date.parse(lastRun.start) || nowQ;
    // Reduce et non Math.max(...runs) : sans plafond API, une journée peut porter
    // assez de runs pour faire exploser la pile avec un spread.
    let maxDuration = 0;
    runs.forEach((r) => {
      const duration = (r.end ? Date.parse(r.end) : nowQ) - Date.parse(r.start);
      if (Number.isFinite(duration) && duration > maxDuration) maxDuration = duration;
    });
    return {
      dagId,
      runs,
      tags: runs[0].tags || [],
      firstStart: Date.parse(runs[0].start),
      lastEnd,
      count: runs.length,
      maxDuration,
    };
  });
  const comparators = {
    first: (a, b) => a.firstStart - b.firstStart || a.dagId.localeCompare(b.dagId),
    last: (a, b) => b.lastEnd - a.lastEnd || a.dagId.localeCompare(b.dagId),
    duration: (a, b) => b.maxDuration - a.maxDuration,
    count: (a, b) => b.count - a.count || a.dagId.localeCompare(b.dagId),
    name: (a, b) => a.dagId.localeCompare(b.dagId),
  };
  return list.sort(comparators[sortKey] || comparators[DEFAULT_SORT]);
};

/** Étapes saisies + rangs de fréquence : les deux entrées de `buildGroups`. */
export const buildGroupingInputs = (rows, stagesText) => {
  const stages = parseStages(stagesText);
  const tagRank = computeTagRank(rows);
  return { stages, tagRank };
};

/** Granularité effective : `auto` dépend de la fenêtre affichée, sinon la tranche fixe. */
export const resolveBinMs = (bin, windowSpan) => {
  const fixed = parseBin(bin);
  return fixed === undefined ? autoBinMs(windowSpan) : fixed;
};

/**
 * Ce qu'on dessine, par DAG : runs isolés + buckets. `mergedCount` alimente le compteur
 * « N fusionnés » (runs réels - éléments affichés).
 */
export const buildItemsByDag = (rows, dayStart, binMs, nowQ) => {
  const map = new Map();
  let runs = 0;
  let items = 0;
  rows.forEach((row) => {
    const list = bucketize(row.runs, dayStart, binMs, nowQ);
    map.set(row.dagId, list);
    runs += row.count;
    items += list.length;
  });
  return { itemsByDag: map, mergedCount: runs - items };
};

/** Clé -> item : le texte de l'infobulle n'est construit que pour la barre survolée. */
export const buildTipIndex = (itemsByDag) => {
  const map = new Map();
  itemsByDag.forEach((list) => list.forEach((item) => map.set(item.key, item)));
  return map;
};

export { buildGroups };

/* ------------------------------------------------------------------ */
/* URL partageable ⇄ réglages de la vue                                */
/* ------------------------------------------------------------------ */

// Une tranche par défaut : `auto` (granularité selon la fenêtre, 30 min max). C'est LA valeur
// qui ne s'écrit jamais dans l'URL — d'où sa constante, lue par `readInitialView` et
// `viewToQuery` pour qu'ils restent l'inverse l'un de l'autre.
export const DEFAULT_BIN = 'auto';

/** `''` → `[]`, `'a,,b'` → `['a', 'b']` : la forme des listes portées par l'URL. */
const listOf = (raw) => (raw || '').split(',').filter(Boolean);

/**
 * Query string → réglages de la vue, défauts appliqués.
 *
 * Un seul endroit lit l'URL : les valeurs inconnues (`?sort=nope`, `?bin=99m`) retombent sur le
 * défaut au lieu de traverser jusqu'aux sélecteurs. Appelé **une fois** au montage, dans un
 * initialiseur `useState` — jamais sur un tableau de runs, donc jamais coûteux.
 */
export const readInitialView = (query) => {
  const sort = query.get('sort');
  const rawBin = query.get('bin');
  return {
    date: query.get('date') || todayLocal(),
    nameFilter: query.get('q') || '',
    tagFilter: query.get('tag') || '',
    stateFilter: listOf(query.get('state')), // multi-sélection via la légende
    zoomAuto: query.get('zoom') !== 'day', // false = journée complète 24 h
    sortKey: SORT_OPTIONS.some((o) => o.value === sort) ? sort : DEFAULT_SORT,
    bin: BIN_OPTIONS.some((o) => o.value === rawBin) ? rawBin : DEFAULT_BIN,
    grouped: query.get('group') !== '0', // défaut : groupé
    stagesText: query.get('stages') || '', // ex. « collecte, normalisation, export »
    collapsed: new Set(listOf(query.get('collapsed'))), // clés = tags normalisés (ou « autre »)
  };
};

/**
 * Vue → paramètres d'URL. Un réglage **à son défaut donne une chaîne vide**, donc disparaît de
 * l'URL : une vue par défaut se partage sans paramètre parasite. Ni la date d'aujourd'hui ni
 * l'onglet ouvert du ruban n'y figurent.
 */
export const viewToQuery = (view) => ({
  date: view.date !== todayLocal() ? view.date : '',
  q: view.nameFilter.trim(),
  tag: view.tagFilter,
  state: view.stateFilter.join(','),
  sort: view.sortKey !== DEFAULT_SORT ? view.sortKey : '',
  zoom: view.zoomAuto ? '' : 'day',
  bin: view.bin !== DEFAULT_BIN ? view.bin : '',
  group: view.grouped ? '' : '0',
  stages: view.stagesText.trim(),
  collapsed: Array.from(view.collapsed).join(','),
});

/* ------------------------------------------------------------------ */
/* Textes du ruban : des données, pas des branches de rendu            */
/* ------------------------------------------------------------------ */

/** Ce que fait la granularité choisie (infobulle du sélecteur `Agrégation des runs`). */
export const binHint = (bin) => {
  if (bin === 'auto')
    return "Fusionne les runs d'un même DAG démarrés dans la même tranche ; granularité choisie d'après la fenêtre affichée, 30 min maximum. Rouge dès qu'un run du bucket a échoué.";
  if (bin === 'off') return 'Une barre par run : aucune agrégation.';
  return `Une barre par tranche de ${binLabel(parseBin(bin))} ; rouge dès qu'un run du bucket a échoué.`;
};

/** La ligne du haut : combien de runs survivent aux filtres, combien l'agrégation en a fusionnés. */
export const summaryLabel = (filteredCount, mergedCount) =>
  `${filteredCount} run${filteredCount > 1 ? 's' : ''}` +
  (mergedCount > 0 ? ` · ${mergedCount} fusionnés` : '');

/** Ce que la ligne du haut ne dit pas : bornes, étendue et tranche, en infobulle. */
export const summaryTitle = ({ windowStart, windowSpan, zoomed, mergedCount, binMs }) =>
  `${fmtClock(windowStart)} → ${fmtClock(windowStart + windowSpan)} ` +
  `(${fmtDuration(windowSpan)}, ${zoomed ? 'fenêtre ajustée aux runs filtrés' : 'journée complète'})` +
  (mergedCount > 0 ? ` · ${mergedCount} runs fusionnés par tranche de ${binLabel(binMs)}` : '');

/** La puce d'état de la fenêtre, qui est aussi le bouton de bascule du zoom auto. */
export const windowChipTitle = ({ windowStart, windowSpan, zoomAuto }) =>
  `${fmtClock(windowStart)} → ${fmtClock(windowStart + windowSpan)} · ${fmtDuration(windowSpan)}\n` +
  `${zoomAuto ? 'Zoom auto sur les runs filtrés (3 h minimum)' : 'Journée complète'}\n` +
  `Cliquer pour ${zoomAuto ? 'afficher les 24 h' : 'zoomer sur les runs filtrés'}`;
