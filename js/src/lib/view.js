/**
 * Dérivations du Gantt : ce qu'on garde, comment on trie, comment on dessine.
 * **Fonctions pures**, sans React ni DOM — chacune est le corps d'un `useMemo` du conteneur,
 * testée sous Node dans `js/test/view.test.mjs`.
 *
 * Pipeline : runs d'une journée → `filterRuns` → `buildRows` (une ligne par DAG)
 * → `buildGroups` (tag principal) → `buildItemsByDag` (runs isolés + buckets) → barres.
 *
 * Les corps sont recopiés **tels quels** du composant : les paramètres reprennent les mêmes
 * noms que les variables d'état (`data`, `nameFilter`, `tagFilter`, `stateFilter`, `stateSet`,
 * `filtered`, `rows`…) pour qu'aucune réécriture d'identifiant ne se glisse ici.
 */

import { autoBinMs, bucketize, parseBin } from './aggregation.js';
import { DEFAULT_SORT, STATE_ORDER } from './constants.js';
import { buildGroups, computeTagRank, parseStages } from './grouping.js';

/** `?q=` sur dag_id ou run_id, tag exact, états : sélection vide = tout. */
export const filterRuns = (data, nameFilter, tagFilter, stateFilter, stateSet) => {
  const needle = nameFilter.trim().toLowerCase();
  return data.runs.filter(
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
export const stateCounts = (data, nameFilter, tagFilter) => {
  const needle = nameFilter.trim().toLowerCase();
  const out = {};
  data.runs.forEach((r) => {
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

export const listTags = (data) => Array.from(new Set(data.runs.flatMap((r) => r.tags))).sort();

/** États présents dans les données, dans l'ordre de la légende, puis les états rares triés. */
export const listStates = (data) => {
  const found = new Set(data.runs.map((r) => r.state || 'none'));
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
export const hasLiveRuns = (data) =>
  data.runs.some((r) => r.state === 'running' || r.state === 'queued');

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
