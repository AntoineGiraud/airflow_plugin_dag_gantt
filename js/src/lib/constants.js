/**
 * Réglages du Gantt : palette, géométrie, options des sélecteurs, onglets du ruban.
 *
 * Copie **conforme** des blocs qui vivaient dans `DagGanttWidget.jsx` (seul `export` a été
 * ajouté) : les couleurs sont des tokens du thème de l'hôte (`success.solid`, `stone.solid`…),
 * jamais des hex — c'est le branding Airflow qui les définit.
 */

export const API_URL = '/dag-gantt-plugin/api/runs';

// Palette officielle Airflow 3 (verifiee dans le bundle UI :
// {failed:'failed.solid', planned:'stone.solid', queued:'queued.solid',
//  running:'running.solid', success:'success.solid'})
export const STATE_COLORS = {
  success: 'success.solid',
  failed: 'failed.solid',
  running: 'running.solid',
  queued: 'queued.solid',
  planned: 'stone.solid',
};
export const DEFAULT_COLOR = 'gray.solid';
export const STATE_ORDER = ['queued', 'running', 'success', 'failed'];

export const LABEL_WIDTH = 280; // colonne de gauche : 150 px garantis au nom + place pour les badges
export const BAR_HEIGHT = 14;
export const BAR_GAP = 3;
export const ROW_HEIGHT = BAR_HEIGHT + BAR_GAP; // pas vertical d'une lane (px)
export const MAX_LANES = 6;
export const NO_ITEMS = []; // array partagé : garde l'identity stable pour React.memo
export const REFRESH_MS = 30000; // rafraichissement leger (barres running + donnees)

export const MIN_COUNT_PX = 24; // place pour « 12× »
export const MIN_DUR_PX = 55; // place pour « 4m 12s »

// Tri des rangees de DAGs (valeurs partagees avec l'URL, cf. step URL sync)
export const SORT_OPTIONS = [
  { value: 'first', label: 'Tri : 1er run' },
  { value: 'last', label: 'Tri : Dernier run' },
  { value: 'name', label: 'Tri : Nom DAG' },
  { value: 'count', label: 'Tri : Nb de runs' },
  { value: 'duration', label: 'Tri : Durée max' },
];
export const DEFAULT_SORT = 'first';

export const PANEL_TABS = [
  { key: 'filters', label: 'Filtres', icon: '🔍' },
  { key: 'view', label: 'Affichage', icon: '⚙️' },
];


export const NBSP = '\u00a0';
