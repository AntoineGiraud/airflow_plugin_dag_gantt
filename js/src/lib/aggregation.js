/**
 * Agrégation des runs en buckets — fonctions **pures**, sans React, testables
 * hors navigateur : `node js/test/aggregation.test.mjs`.
 *
 * Règle : des runs d'un même DAG qui démarrent dans la même tranche (`binMs`)
 * sont fusionnés en une seule barre. Les bornes du bucket sont les **vraies**
 * dates des runs (pas les bords de la tranche) : la barre reste fidèle.
 *
 * Le fichier tient aussi la **logique de la barre** (`barGeometry`, `barLabel`,
 * `barVisualProps`, `isLinkable`, à côté de `barHref` et `packLanes`) : ce sont des
 * calculs, pas du rendu — ils sortent donc du composant `Bar` pour être vérifiés sous
 * Node, ce que le composant ne peut pas être.
 */
import { fmtDuration } from './time.js';
import { BAR_HEIGHT, DEFAULT_COLOR, MIN_COUNT_PX, MIN_DUR_PX, ROW_HEIGHT, STATE_COLORS } from './constants.js';

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Valeurs du select « Agrégation » (`off` = une barre par run, comme avant). */
export const BIN_OPTIONS = [
  { value: 'auto', label: 'Agrégation : auto' },
  { value: 'off', label: 'Agrégation : off' },
  { value: '1m', label: 'Agrégation : 1 min' },
  { value: '5m', label: 'Agrégation : 5 min' },
  { value: '15m', label: 'Agrégation : 15 min' },
  { value: '30m', label: 'Agrégation : 30 min' },
  { value: '60m', label: 'Agrégation : 1 h' },
];

const BIN_MS = {
  '1m': MINUTE_MS,
  '5m': 5 * MINUTE_MS,
  '15m': 15 * MINUTE_MS,
  '30m': 30 * MINUTE_MS,
  '60m': HOUR_MS,
};

const BIN_NAMES = {
  [MINUTE_MS]: '1 min',
  [5 * MINUTE_MS]: '5 min',
  [15 * MINUTE_MS]: '15 min',
  [30 * MINUTE_MS]: '30 min',
  [HOUR_MS]: '1 h',
};

/** '5m' -> 300000 · 'off' -> null (désactivé) · 'auto'/inconnu -> undefined. */
export const parseBin = (value) => {
  if (value === 'off') return null;
  return Object.prototype.hasOwnProperty.call(BIN_MS, value) ? BIN_MS[value] : undefined;
};

/**
 * Granularité automatique selon la fenêtre affichée.
 * Plafond assumé : **jamais plus de 30 min** (1 h reste un choix manuel).
 */
export const autoBinMs = (spanMs) => {
  const hours = (Number.isFinite(spanMs) ? spanMs : 0) / HOUR_MS;
  if (hours <= 3) return MINUTE_MS;
  if (hours <= 6) return 5 * MINUTE_MS;
  if (hours <= 12) return 15 * MINUTE_MS;
  return 30 * MINUTE_MS;
};

/** Libellé lisible d'une granularité ('off' / '5 min' / '1 h'…). */
export const binLabel = (binMs) => {
  if (binMs == null) return 'off';
  return BIN_NAMES[binMs] || `${Math.round(binMs / MINUTE_MS)} min`;
};

/** Du plus « grave » au plus tranquille : un bucket rouge dès un run échoué. */
export const STATE_SEVERITY = ['failed', 'running', 'queued', 'planned', 'success'];

/**
 * État dominant d'un lot de runs.
 * `states` : tableau d'états ou `{etat: nombre}` ; un état inconnu (ex. `none`)
 * n'est jamais prioritaires -> on retombe sur le premier état rencontré.
 */
export const worstState = (states) => {
  const names = Array.isArray(states) ? states : Object.keys(states || {});
  for (const s of STATE_SEVERITY) {
    if (names.includes(s)) return s;
  }
  return names[0] || null;
};

const parseMs = (iso) => {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

const uniqKey = (runs) => `${runs[0].dag_id}:${runs[0].run_id}`;

/** Item « un run » : rendu identique à l'ancien GanttBar, avec ses bornes pré-calculées. */
const runItem = (run, nowMs) => {
  const startMs = parseMs(run.start);
  const endMs = parseMs(run.end);
  const state = run.state || 'none';
  return {
    kind: 'run',
    key: `r:${run.dag_id}:${run.run_id}`,
    dagId: run.dag_id,
    state,
    states: { [state]: 1 },
    count: 1,
    startMs,
    // running / queued : étiré jusqu'à `nowMs` (le tick gelé à la minute)
    endMs: endMs != null && startMs != null && endMs > startMs ? endMs : nowMs,
    open: endMs == null,
    running: run.state === 'running',
    run,
    runs: [run],
  };
};

/** Item « bucket » : ≥ 2 runs du même DAG démarrés dans la même tranche. */
const bucketItem = (runs, binKey, nowMs) => {
  let startMs = null;
  let lastEndMs = null;
  let open = false;
  const states = {};
  runs.forEach((run) => {
    const s = parseMs(run.start);
    const e = parseMs(run.end);
    if (s != null) startMs = startMs == null ? s : Math.min(startMs, s);
    if (e != null) lastEndMs = lastEndMs == null ? e : Math.max(lastEndMs, e);
    else open = true;
    const state = run.state || 'none';
    states[state] = (states[state] || 0) + 1;
  });
  // Un run non terminé étire la barre jusqu'à maintenant.
  const endMs = Math.max(lastEndMs == null ? 0 : lastEndMs, open ? nowMs : 0);
  return {
    kind: 'bucket',
    key: `b:${uniqKey(runs)}:${binKey}:${startMs}`,
    dagId: runs[0].dag_id,
    state: worstState(states),
    states,
    count: runs.length,
    startMs,
    endMs,
    open,
    running: runs.some((r) => r.state === 'running'),
    run: runs[0],
    runs,
  };
};

/**
 * Lane packing glouton : chaque item dans la premiere lane libre. Le lane vit dans
 * l'item (plus de mutation `run._lane` sur les donnees de l'API) et un item dont le
 * lane ne bouge pas garde son identite -> `React.memo` sur la barre reste efficace.
 *
 * Retourne `{ packed, lanes }` : `lanes` porte la hauteur de la ligne.
 */
export const packLanes = (items, maxLanes = 6) => {
  const laneEnds = [];
  const packed = (items || []).map((item) => {
    const startMs = item.startMs == null ? -Infinity : item.startMs;
    const endMs = item.endMs == null ? startMs : item.endMs;
    let lane = laneEnds.findIndex((end) => end <= startMs);
    if (lane === -1) {
      if (laneEnds.length < maxLanes) {
        laneEnds.push(endMs);
        lane = laneEnds.length - 1;
      } else {
        lane = Math.max(maxLanes - 1, 0); // surcharge : on empile dans la derniere
      }
    } else {
      laneEnds[lane] = endMs;
    }
    return item.lane === lane ? item : { ...item, lane };
  });
  return { packed, lanes: Math.max(laneEnds.length, 1) };
};

/** Marge (ms) appliquée aux bornes UTC du filtre de journée, voir `barHref`. */
export const DAY_FILTER_MARGIN_MS = 60 * 60 * 1000;

/**
 * Lien d'une barre — **fonction pure** : aucune dépendance à l'état (plus de filtre
 * par état ni de bornes de tranche), seule la journée de la page compte.
 *
 * - run isolé -> grille du run `/dags/<dag_id>/runs/<run_id>` ;
 * - bucket (ou run isolé sans `run_id`) -> liste des runs du DAG filtrée sur **la
 *   journée concernée par la page Gantt** : `run_after_gte` = minuit local du jour,
 *   `run_after_lte` = minuit local du jour suivant (`dayStartMs` + 24 h, ce qui suit
 *   le Gantt y compris les jours de 23/25 h autour d'un changement d'heure).
 *   `dayStartMs` est facultatif : absent, on retombe sur les bornes de la barre.
 *
 * Clés vérifiées dans le bundle UI de l'hôte (Airflow 3.3.2+astro) : l'enum
 * `SearchParamsKeys` expose `RUN_AFTER_GTE` / `RUN_AFTER_LTE` — donc **plus** de
 * `state` (le filtre d'état est volontairement retiré) et jamais `run_state`, qui
 * n'existe pas sur cette page (son équivalent réel, `dag_run_state`, filtre la liste
 * des DAGs).
 * Les bornes sont élargies d'1 h côté UTC : la page native filtre `run_after` en
 * UTC alors que le Gantt dessine d'après `start_date` en heure locale — sans marge,
 * un run démarré juste après minuit local disparaîtrait de la liste (1 h couvre
 * tous les fuseaux utiles à une instance ; élargir ne peut qu'inclure un run de
 * plus, jamais en cacher).
 *
 * Caveat conservé : la page native pagine 10 runs par défaut.
 */
export const barHref = (item, dayStartMs) => {
  const listUrl = `/dags/${encodeURIComponent(item.dagId)}/runs`;
  if (item.kind !== 'bucket' && item.run && item.run.run_id) {
    return `${listUrl}/${encodeURIComponent(item.run.run_id)}`;
  }
  const params = new URLSearchParams();
  if (Number.isFinite(dayStartMs)) {
    params.set('run_after_gte', new Date(dayStartMs - DAY_FILTER_MARGIN_MS).toISOString());
    params.set('run_after_lte', new Date(dayStartMs + DAY_MS + DAY_FILTER_MARGIN_MS).toISOString());
  } else {
    if (item.startMs != null) params.set('run_after_gte', new Date(item.startMs).toISOString());
    if (item.endMs != null) params.set('run_after_lte', new Date(item.endMs).toISOString());
  }
  const query = params.toString();
  return query ? `${listUrl}?${query}` : listUrl;
};

/**
 * Géométrie d'une barre : position et largeur en **%** de la zone de temps, plus les px
 * estimés. Un run sans date (`startMs`/`endMs` absents) ou mal né (fin < début) est ramené
 * à un point : une barre ultra-fine plutôt qu'un calcul négatif qui casserait le rendu.
 *
 * `widthPx` vaut `null` tant que la largeur de la zone n'est pas mesurée (`useChartWidth`) :
 * c'est ce qui oblige `barLabel` à un seuil approximatif en % pour la première peinture.
 * `0,35 %` au plancher : une barre de quelques secondes doit rester **visible et survolable**.
 */
export const barGeometry = (item, { windowStart, windowSpan, chartWidth }) => {
  const startMs = item.startMs == null ? windowStart : item.startMs;
  const endMs = item.endMs == null || item.endMs < startMs ? startMs : item.endMs;
  const left = Math.max(0, ((startMs - windowStart) / windowSpan) * 100);
  const right = Math.min(100, ((endMs - windowStart) / windowSpan) * 100);
  const width = Math.max(right - left, 0.35);
  return {
    startMs,
    endMs,
    left,
    width,
    // Label dans la barre sans mesure (ResizeObserver absent) : seuil approximatif.
    widthPx: chartWidth ? (width / 100) * chartWidth : null,
  };
};

/**
 * Ce que la barre écrit en elle-même : `▶` si un run y tourne, le nombre de runs du bucket,
 * la durée — chacun **seulement si ça rentre** (`MIN_COUNT_PX`, `MIN_DUR_PX`). Une barre de
 * deux minutes vide est plus lisible qu'une barre tronquée en « 4m 1… ».
 */
export const barLabel = (item, geometry) => {
  const { width, widthPx, startMs, endMs } = geometry;
  const fits = (px) => (widthPx != null ? widthPx >= px : width >= 8);
  const parts = [];
  if (item.count > 1 && fits(MIN_COUNT_PX)) parts.push(`${item.count}×`);
  if (fits(MIN_DUR_PX)) parts.push(fmtDuration(endMs - startMs));
  return `${item.running ? '▶' : ''}${parts.length ? `${item.running ? ' ' : ''}${parts.join(' · ')}` : ''}`;
};

/**
 * Apparence d'une barre : couleur de l'état **le plus grave** du bucket, opacité, bordure
 * quand un run y tourne. Les couleurs sont des tokens du thème de l'hôte, jamais des hex.
 */
export const barVisualProps = (item) => ({
  bg: STATE_COLORS[item.state] || DEFAULT_COLOR,
  color: 'white',
  borderRadius: '3px',
  fontSize: '10px',
  lineHeight: `${BAR_HEIGHT}px`,
  px: 1,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  opacity: item.state && item.state !== 'success' ? 1 : 0.9,
  border: item.running ? '1px solid' : 'none', // bucket contenant un run en cours
  borderColor: 'running.solid',
});

/**
 * Seule une barre **utile en clic** est un lien : un échec (y compris dans un bucket, pour
 * aller voir les logs) ou un run unique (sa grille). Les buckets réussis restent muets :
 * moins de `<a>` dans le DOM, pas de fausse affordance, et le tooltip donne déjà le détail.
 */
export const isLinkable = (item) => item.state === 'failed' || item.count === 1;

/** Position absolue d'une barre dans sa ligne (`lane` = colonne verticale assignée par `packLanes`). */
export const barStyle = (item, geometry) => ({
  position: 'absolute',
  top: `${(item.lane || 0) * ROW_HEIGHT}px`,
  left: `${geometry.left}%`,
  width: `${geometry.width}%`,
  height: `${BAR_HEIGHT}px`,
  // `<a>` est inline par défaut : sans bloc, la largeur/position en % ne suivent pas.
  display: 'block',
});

/**
 * Fuseau : `runs` (triés par start, `rows` les trie déjà) -> items à dessiner.
 *
 * - `binMs == null` (agrégation `off`) -> un item par run, comportement historique.
 * - tranche = `floor((start - dayStart) / binMs)` ; un groupe d'**un** run reste un
 *   item `run` (donc un lien direct vers la grille du run).
 * - un run sans start parsable n'est **jamais** fusionné.
 *
 * `computeWindow` consomme toujours les runs bruts, jamais ces items : pas de
 * boucle de rétroaction fenêtre <-> granularité.
 */
export const bucketize = (runs, dayStart, binMs, nowMs) => {
  const list = runs || [];
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  if (binMs == null || binMs <= 0) return list.map((run) => runItem(run, now));

  const origin = Number.isFinite(dayStart) ? dayStart : 0;
  const out = [];
  let group = [];
  let groupKey = null;

  const flush = () => {
    if (group.length === 1) out.push(runItem(group[0], now));
    else if (group.length > 1) out.push(bucketItem(group, groupKey, now));
    group = [];
    groupKey = null;
  };

  list.forEach((run) => {
    const startMs = parseMs(run.start);
    if (startMs == null) {
      out.push(runItem(run, now)); // jamais fusionné
      return;
    }
    // Cle = tranche + DAG : `bucketize` est appele par ligne (donc par DAG), mais
    // on ne fusionne jamais deux DAGs, meme si l'appelant melange les runs.
    const key = `${run.dag_id}|${Math.floor((startMs - origin) / binMs)}`;
    if (group.length && key !== groupKey) flush();
    groupKey = key;
    group.push(run);
  });
  flush();
  return out;
};
