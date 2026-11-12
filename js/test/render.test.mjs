/**
 * Rendu réel du widget dans un DOM — la partie qu'un test de fonctions pures ne peut pas prouver.
 *
 *   cd js && bun run test:dom
 *
 * Ce qui est vérifié ici, sur une journée dense synthétique (1126 runs d'un même DAG
 * sur ~14 h + 1 DAG calme) : le nombre de barres réellement rendues selon la granularité,
 * le fait qu'il n'y ait **plus un tooltip par barre**, et le comportement des rares liens
 * (nom du DAG, barres en échec) y compris la navigation SPA déléguée.
 *
 * Deux pièces détachées méritent une explication :
 *
 * - `@chakra-ui/react` et `react-router-dom` ne sont pas installés : en production ils sont
 *   fournies par l'UI Airflow via `globalThis` (webpack `externals`). Le build du test les
 *   remplace par des stubs équivalents (vrais DOM + `forwardRef`, comme le `Box` de l'hôte)
 *   et un `TooltipRoot` qui **compte** ses instances — c'est ce compteur qui prouve la
 *   suppression des tooltips unitaires.
 * - `react` et `react-dom` sont marqués `external` : si le bundle en embarquait sa propre
 *   copie, `createRoot` (notre copie) et les hooks (sa copie) ne partageraient plus le
 *   même dispatcher React — deux React dans l'arbre, exactement l'erreur que §2.3 du README
 *   explique pour le HMR.
 *
 * Toute `console.error` (avertissement React inclus) fait échouer le test : un `key` dupliqué
 * ou une prop DOM invalide ne doit pas passer inaperçu derrière un rendu qui « s'affiche ».
 */
import assert from 'node:assert/strict';
import { unlinkSync, writeFileSync } from 'node:fs';
import { Window } from 'happy-dom';

/* ------------------------------- DOM ------------------------------- */

const win = new Window({ url: 'http://localhost:8080/dag-gantt?date=2026-11-10' });
globalThis.window = win;
globalThis.document = win.document;
globalThis.navigator = win.navigator;
globalThis.HTMLElement = win.HTMLElement;
globalThis.Element = win.Element;
globalThis.Node = win.Node;

/* -------- stubs des externals (fournis par l'hôte en production) -------- */

const CHAKRA_STUB = `
const R = globalThis.React;
const KEEP = ['className','id','style','title','href','type','value','placeholder','disabled',
  'onChange','onClick','onMouseOver','onMouseLeave','role'];
const KEEP_TEXT = ['loading','checked','htmlFor']; // props Chakra valides, non DOM : à filtrer
// Traduction fidèle des props React vers le DOM : hidden est un **booleen** (l'attribut
// est retire quand il est faux), aria-expanded / aria-pressed sont des booleens DOM
// valides rendus "true"/"false". Sans ce traitement, le test ne verrait pas les panneaux
// masqués et confondrait ouverts / fermés.
const BOOL_ATTRS = { hidden: 'presence', 'aria-expanded': 'string', 'aria-pressed': 'string' };
const domProps = (p) => {
  const out = {};
  const entries = Object.entries(p).filter(([k]) => k !== 'children' && k !== 'ref');
  for (const [k, v] of entries) {
    if (KEEP_TEXT.includes(k)) continue;
    if (Object.prototype.hasOwnProperty.call(BOOL_ATTRS, k)) {
      if (!v && BOOL_ATTRS[k] === 'presence') continue; // attribut absent
      out[k] = BOOL_ATTRS[k] === 'presence' ? '' : String(Boolean(v));
      continue;
    }
    if (k === 'data-gk-ui') {
      out[k] = String(v); // clés du ruban : tab-filters, chip-tag, state-failed…
      continue;
    }
    if (KEEP.includes(k) || k.startsWith('data-') || k.startsWith('aria-')) out[k] = v;
  }
  return out;
};
// forwardRef : le Box de l'hôte en est un, et le widget y accroche un ref (ResizeObserver).
// as="button" (puce de filtre, cases d'état, en-tête de groupe) : la légende du Gantt
// s'en sert déjà, le stub doit le rendre comme l'hôte — sinon ces contrôles deviennent
// introuvables dans le DOM du test.
const mk = (el) =>
  R.forwardRef((p, ref) =>
    R.createElement(p.as === 'button' ? 'button' : el, { ...domProps(p), ref }, p.children)
  );
export const Box = mk('div');
export const Flex = mk('div');
export const HStack = mk('div');
export const VStack = mk('div');
export const Text = mk('span');
export const Badge = mk('span');
export const Spacer = () => R.createElement('div', null);
export const Input = mk('input');
export const Button = mk('button');
export const NativeSelectRoot = mk('div');
export const NativeSelectField = mk('select');
// Le widget ne doit plus jamais instancier de tooltip unitaire : on compte.
export const TooltipRoot = () => {
  globalThis.__tooltipRoots = (globalThis.__tooltipRoots || 0) + 1;
  return null;
};
export const TooltipTrigger = mk('span');
export const TooltipContent = mk('span');
`;

const ROUTER_STUB = `
export const Link = (p) => globalThis.React.createElement('a', { href: p.to }, p.children);
export const useNavigate = () => (href) => {
  globalThis.__navigated = globalThis.__navigated || [];
  globalThis.__navigated.push(href);
};
export const useSearchParams = () => [new URLSearchParams(globalThis.window.location.search), () => {}];
`;

globalThis.React = (await import('react')).default;
const React = globalThis.React;

const built = await Bun.build({
  entrypoints: ['./src/index.js'],
  target: 'browser',
  format: 'esm',
  write: false,
  external: ['react', 'react-dom', 'react-dom/client'],
  plugins: [
    {
      name: 'externals-en-stubs',
      setup(b) {
        for (const spec of ['^@chakra-ui\\/react$', '^react-router-dom$']) {
          b.onResolve({ filter: new RegExp(spec) }, (args) => ({ path: args.path, namespace: 'stub' }));
        }
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents: args.path === '@chakra-ui/react' ? CHAKRA_STUB : ROUTER_STUB,
          loader: 'js',
        }));
      },
    },
  ],
});
if (!built.success) {
  console.error(built.logs);
  process.exit(1);
}
// Le bundle est écrit **dans js/test** pour que son `import 'react'` résolve notre
// node_modules (du /tmp, il ne trouverait rien), puis supprimé.
const bundlePath = new URL('./.render-test-bundle.mjs', import.meta.url);
writeFileSync(bundlePath, await built.outputs[0].text());
let Widget;
try {
  const mod = await import(bundlePath.pathname);
  Widget = mod.default ?? globalThis.AirflowPlugin;
} finally {
  unlinkSync(bundlePath);
}

const { createRoot } = await import('react-dom/client');

/* ------------------------------- jeu de données ------------------------------- */

const DAY = '2026-11-10';
const DAY_START = Date.parse(`${DAY}T00:00:00`);
const RUN_COUNT = 1126;
const STEP_S = 44.8; // un run toutes les ~45 s -> ~14 h d'activité

const runs = [];
for (let i = 0; i < RUN_COUNT; i += 1) {
  const start = DAY_START + Math.round((9 * 3600 + i * STEP_S) * 1000); // 09:00 -> ~23:00
  const state = i % 17 === 0 ? 'failed' : i % 40 === 3 ? 'running' : 'success';
  runs.push({
    dag_id: 'ALIVE',
    // run_id unique (contrainte Airflow (dag_id, run_id)) : un doublon ferait une clé
    // React dupliquée — et le filet à avertissements plus bas la dénoncerait.
    run_id: `manual__2026-11-10T${String(i).padStart(5, '0')}+00:00`,
    state,
    start: new Date(start).toISOString(),
    end: state === 'running' ? null : new Date(start + 45_000).toISOString(),
    logical_date: new Date(start).toISOString(),
    tags: ['spark'],
  });
}
runs.push({
  dag_id: 'spark_nightly',
  run_id: 'scheduled__2026-11-10T02:00:00+00:00',
  state: 'success',
  start: new Date(DAY_START + 2 * 3600_000).toISOString(),
  end: new Date(DAY_START + 2 * 3600_000 + 900_000).toISOString(),
  logical_date: new Date(DAY_START + 2 * 3600_000).toISOString(),
  tags: ['spark'],
});
const FAILED = runs.filter((r) => r.state === 'failed').length;

globalThis.fetch = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ date: DAY, window: {}, count: runs.length, runs }),
});

/* ------------------------------- filet à avertissements ------------------------------- */

const complaints = [];
const realError = console.error;
console.error = (...args) => {
  const text = args.map(String).join(' ');
  if (/ReactDOMTestUtils|not wrapped in act/.test(text)) return; // artéfact du harnais
  complaints.push(text);
};

/* ------------------------------- outillage ------------------------------- */

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
const roots = [];

const mount = async (search) => {
  win.location.search = search;
  const container = win.document.createElement('div');
  win.document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  root.render(React.createElement(Widget));
  await tick(80); // fetch stubbé + effets
  return container;
};

const bars = (c) => c.querySelectorAll('[data-gk]');
// Noms des DAGs dans l'ordre des lignes : les liens de nom portent `data-nav` et un href sans
// `/runs/` (ceux des barres pointent sur la grille d'un run).
const rowNames = (c) =>
  [...c.querySelectorAll('a[data-nav][href^="/dags/"]:not([href*="/runs"])')].map((a) =>
    decodeURIComponent(a.getAttribute('href').slice('/dags/'.length))
  );
// Le résumé de la ligne du haut (runs + runs fusionnés), à droite des onglets.
const summaryNode = (c) => c.querySelector('[data-gk-ui="summary"]');
const links = (c) => c.querySelectorAll('a');
// `data-gk` est la clé des **barres** (tooltip délégué + tests de rendu) : les éléments
// d'interface du ruban portent donc `data-gk-ui`, pour ne pas être confondus avec elles.
// Correspondance **exacte**, sauf pour les onglets (`tab-filters` / `tab-view`) où le
// code passé sert de préfixe — sinon `panel-filters` correspondrait aussi à `panel-`.
const UI = (code) => (code.endsWith('-') ? `[data-gk-ui^="${code}"]` : `[data-gk-ui="${code}"]`);
const uiNodes = (root, code) => [...root.querySelectorAll(UI(code))];
const uiNode = (root, code) => root.querySelector(UI(code));
// Le ruban masque (il ne démonte pas) avec `hidden` (display:none côté navigateur) et
// pose `data-visible="yes|no"`, relisible ici : happy-dom ne rend pas l'attribut booléen
// `hidden` reçu en prop React. Les attributs data-* passant en camelCase dans le dataset
// HTML, les deux écritures sont acceptées.
const attr = (el, name) =>
  el ? el.getAttribute(name) ?? el.getAttribute(name.replace(/-(\w)/g, (_, c) => c.toUpperCase())) : null;
const hidden = (el) => !el || attr(el, 'data-visible') === 'no';
// État coché relu depuis le DOM (même raison que data-hidden ; aria-pressed reste posé
// pour l'accessibilité réelle).
// État coché : lu sur data-state (le stub happy-dom ne rend pas les booléens ARIA).
const pressed = (root, name) => uiNode(root, `state-${name}`).getAttribute('data-state') === 'on';
const byText = (nodes, re) =>
  nodes.find((n) => re.test(n.textContent || '') || re.test(n.getAttribute('data-gk-ui') || ''));
const click = (el, init = {}) =>
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, button: 0, ...init }));
const hover = (el) => el.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));

/* ------------------------------- 1. agrégation ------------------------------- */

const off = await mount('?date=2026-11-10&bin=off');
assert.equal(bars(off).length, runs.length, 'bin=off : une barre par run, comportement historique');
// Liens = 1 par DAG (le nom) + 1 **par barre cliquable**, et avec bin=off chaque run est
// une barre => tout le monde est cliquable (run unique). Les échecs ne sont plus un cas
// particulier : c'est `count === 1` qui ouvre le lien.
assert.equal(links(off).length, 2 + runs.length, `liens = noms de DAG + runs uniques (${runs.length} attendus)`);

const five = await mount('?date=2026-11-10&bin=5m');
// 1126 runs * 44,8 s depuis 09:00 = 14 h pile -> 169 tranches de 5 min + la barre du DAG calme.
assert.equal(bars(five).length, 170, 'buckets 5 min : une barre par tranche occupée');

const auto = await mount('?date=2026-11-10');
assert.ok(bars(auto).length <= 40, `agrégation auto inefficace : ${bars(auto).length} barres`);
assert.ok(
  bars(auto).length * 10 < bars(off).length,
  'l’agrégation doit diviser le nombre de barres par au moins 10'
);
// La ligne du haut ne garde que ce que l'axe du Gantt ne dit pas : le nombre de RUNS
// (pas de buckets) et ce que l'agrégation en a fusionnés. Fenêtre et granularité
// effective se lisent dans l'infobulle, pas dans la ligne (elles sont sur l'axe).
assert.match(auto.textContent, /· \d+ fusionnés/, 'le nombre de runs fusionnés doit être visible');
assert.match(
  attr(summaryNode(auto), 'title'),
  /tranche de \d+ min/,
  'la granularité effective doit rester accessible (infobulle)'
);
assert.match(
  attr(summaryNode(auto), 'title'),
  // Format d'heure local (12 h + AM/PM sur cette instance) : bornes + durée + mode, pas le masque.
  /→.*\(\d+h.*m?, (journée complète|fenêtre ajustée aux runs filtrés)\)/,
  'la fenêtre affichée doit rester accessible (infobulle)'
);
assert.match(auto.textContent, /1126/, 'le badge de la ligne doit compter des RUNS, pas des buckets');
assert.equal(globalThis.__tooltipRoots || 0, 0, 'des Chakra.TooltipRoot ont été instanciés par barre');

// Tri par défaut = « 1er run » **croissant** : le DAG qui démarre le plus tôt de la journée est
// la première ligne (spark_nightly à 02:00 avant ALIVE à 09:00). Écrit décroissant, il triait
// dans le même ordre que « Dernier run » et le sélecteur de tri semblait mort.
assert.deepEqual(
  rowNames(auto),
  ['spark_nightly', 'ALIVE'],
  `le 1er run le plus tôt doit être en haut, obtenu ${rowNames(auto)}`
);
const byLast = await mount('?date=2026-11-10&sort=last');
assert.deepEqual(
  rowNames(byLast),
  ['ALIVE', 'spark_nightly'],
  '« Dernier run » garde son sens décroissant : les deux critères sont donc bien différents'
);

/* ------------------------------- 2. tooltip unique ------------------------------- */

hover(bars(auto)[3]);
await tick(200); // TIP_DELAY_MS = 100
const tips = auto.querySelectorAll('[data-tip]');
assert.equal(tips.length, 1, `un seul tooltip partagé, obtenu ${tips.length}`);
const tipText = tips[0].textContent;
assert.match(tipText, /ALIVE · \d+ runs · \d/, `contenu inattendu : ${tipText.slice(0, 60)}`);
assert.match(tipText, /success \d+ .*failed \d+|failed \d+/, 'répartition par état absente');
assert.match(tipText, /\n {2}manual__/, 'liste de runs absente du tooltip');
assert.match(tipText, /… \+\d+ autres/, 'la troncature à 5 runs doit être annoncée');

// Survol d'une barre de l'autre vue : toujours un seul tooltip, dans ce contenant.
hover(bars(off)[0]);
await tick(200);
assert.equal(off.querySelectorAll('[data-tip]').length, 1, 'toujours un seul tooltip par vue');

/* ------------------------------- 3. liens et navigation déléguée ------------------------------- */

// Avec bin=off, **tout** est cliquable (un run par barre) : le lien d'un run reste sa grille.
globalThis.__navigated = [];
// Ancré sur ALIVE et non sur la 1re barre du DOM : l'ordre des lignes est un fait d'un autre
// test, ce qu'on vérifie ici est qu'un run isolé est un lien vers sa grille.
const soloBar = off.querySelector('a[data-gk][href^="/dags/ALIVE/runs/"]');
assert.ok(soloBar, 'un run isolé doit être un lien');
click(soloBar);
await tick();
assert.equal(globalThis.__navigated.length, 1, 'le clic na pas été intercepté par le délégataire');
assert.match(globalThis.__navigated[0], /^\/dags\/ALIVE\/runs\/manual__/, 'lien de run attendu');

globalThis.__navigated = [];
click(off.querySelector('a[href="/dags/ALIVE"]'));
await tick();
assert.deepEqual(globalThis.__navigated, ['/dags/ALIVE'], 'le nom du DAG mène à sa page');

// En buckets : une barre saine et multiple ne doit **pas** être un lien (vue, pas lanceur).
globalThis.__navigated = [];
const healthyBar = [...five.querySelectorAll('[data-gk]')].find((b) => b.tagName !== 'A');
assert.ok(healthyBar, 'au moins un bucket multiple et sain ne doit pas être un lien');
click(healthyBar);
await tick();
assert.equal(globalThis.__navigated.length, 0, 'un bucket sain ne navigue pas : vue, pas lanceur');

globalThis.__navigated = [];
const bucketLink = [...five.querySelectorAll('a[data-gk]')].find((a) => a.getAttribute('href').includes('?'));
assert.ok(bucketLink, 'un bucket doit être un lien des qu il porte un echec ou un run unique');
const url = new URL(`http://h${bucketLink.getAttribute('href')}`);
assert.equal(url.pathname, '/dags/ALIVE/runs', 'un bucket mène à la liste des runs du DAG');
// Le filtre porte sur **la journée de la page**, plus sur la tranche ni sur un état.
const HOUR = 3600_000;
assert.equal(url.searchParams.get('run_after_gte'), new Date(DAY_START - HOUR).toISOString(), 'borne basse = minuit du jour');
assert.equal(url.searchParams.get('run_after_lte'), new Date(DAY_START + 24 * HOUR + HOUR).toISOString(), 'borne haute = minuit du lendemain');
assert.equal(url.searchParams.get('state'), null, 'plus aucun filtre d état dans le lien');
// Toutes les barres **agrégées** du DAG partagent la même URL : une journée, un lien
// (les barres d'un seul run pointent sur leur grille, et le DAG calme n'a qu'un run).
const dayHrefs = new Set(
  [...five.querySelectorAll('a[data-gk]')]
    .map((a) => a.getAttribute('href'))
    .filter((h) => h.includes('?'))
);
assert.equal(dayHrefs.size, 1, `une seule URL de journée, obtenues : ${[...dayHrefs].join(' | ')}`);

globalThis.__navigated = [];
click(bucketLink, { ctrlKey: true, button: 1 });
await tick();
assert.equal(globalThis.__navigated.length, 0, 'clic molette / nouvel onglet laissé au navigateur');

/* ------------------- 5. ruban : onglets, panneaux, puces, filtres ------------------- */

// Ouvert par défaut sur l'onglet Filtres ; le panneau Affichage est présent mais masqué
// (`hidden`) — le ruban ne démonte rien, il masque.
const ribbonView = await mount('?date=2026-11-10');
assert.ok(!hidden(uiNode(ribbonView, 'panel-filters')), "le ruban s'ouvre sur l'onglet Filtres");
assert.ok(hidden(uiNode(ribbonView, 'panel-view')), "l'onglet Affichage est masqué au départ");
const tabs = uiNodes(ribbonView, 'tab-');
assert.equal(tabs.length, 2, 'deux onglets de contrôles');
assert.equal(byText(tabs, /tab-filters/).getAttribute('aria-expanded'), 'true', 'onglet actif marqué comme tel');

// Onglet actif + aucun filtre -> re-cliquer replie (les deux panneaux masqués).
click(byText(tabs, /tab-filters/));
await tick();
assert.ok(hidden(uiNode(ribbonView, 'panel-filters')), "cliquer l'onglet actif replie le panneau");
assert.ok(hidden(uiNode(ribbonView, 'panel-view')), 'le panneau Affichage reste masqué');
assert.equal(bars(ribbonView).length, bars(auto).length, 'replier le ruban ne change pas la vue');
click(byText(tabs, /tab-view/));
await tick();
assert.ok(!hidden(uiNode(ribbonView, 'panel-view')), "un onglet masqué s'ouvre au clic");
assert.ok(hidden(uiNode(ribbonView, 'panel-filters')), 'un seul panneau visible à la fois');
const viewPanel = uiNode(ribbonView, 'panel-view').textContent;
for (const needle of ['Ordre des lignes', 'Agrégation', 'Zoom auto', 'Groupes', 'Rafraîchir']) {
  assert.ok(viewPanel.includes(needle), `« ${needle} » attendu dans l'onglet Affichage`);
}
assert.ok(uiNode(ribbonView, 'refresh'), 'le bouton Rafraîchir vit dans l\'onglet Affichage');
assert.equal(uiNodes(ribbonView, 'chip-').filter((c) => !hidden(c)).length, 0, 'aucune puce visible sans filtre actif');

// Puces des filtres actifs (masquées plutôt que démontées), retirables par ✕.
const tagged = await mount('?date=2026-11-10&tag=spark&state=failed');
const chipNodes = (root) => uiNodes(root, 'chip-').filter((c) => !hidden(c));
assert.deepEqual(
  chipNodes(tagged).map((c) => c.getAttribute('data-gk-ui')),
  ['chip-tag', 'chip-state'],
  'une puce par filtre actif (tag, états)'
);
assert.ok(chipNodes(tagged).some((c) => /spark/.test(c.textContent)), 'la puce porte la valeur du filtre');
// L'état arrivé par l'URL est coché (à vérifier **avant** de retirer la puce plus bas).
assert.ok(pressed(tagged, 'failed'), '?state=failed arrive coché');
click(uiNode(tagged, 'chip-state'));
await tick(80);
assert.deepEqual(chipNodes(tagged).map((c) => c.getAttribute('data-gk-ui')), ['chip-tag'], "le ✕ retire le filtre d'état");
assert.ok(hidden(uiNode(tagged, 'chip-state')), 'la puce retirée reste dans le DOM, masquée');
assert.ok(chipNodes(tagged).some((c) => /spark/.test(c.textContent)), 'les autres filtres restent actifs');

/* Cases d'état de l'onglet Filtres : **le même `stateFilter`** que la légende cliquable
   du bas. Vue fraîche : l'URL porte failed, et le ruban est ouvert sur Filtres. */
const boxes = await mount('?date=2026-11-10&state=failed');
const boxesOf = (root) =>
  uiNodes(root, 'state-').filter((b) => /^state-(queued|running|success|failed)$/.test(b.getAttribute('data-gk-ui')));
assert.deepEqual(
  boxesOf(boxes).map((b) => b.getAttribute('data-gk-ui')),
  ['state-running', 'state-success', 'state-failed'],
  'une case par état présent dans la journée ou sélectionné'
);
assert.equal(uiNode(boxes, 'state-queued'), null, 'un état sans run et non sélectionné na pas de case');
assert.ok(pressed(boxes, 'failed'), "l'état venu de l'URL est coché");
click(uiNode(boxes, 'state-success'));
await tick(80);
assert.ok(pressed(boxes, 'success'), 'la case se coche au clic');
assert.ok(
  chipNodes(boxes).some((c) => /success/.test(c.textContent) && /failed/.test(c.textContent)),
  'la puce cumule les deux états'
);
click(uiNode(boxes, 'state-failed'));
await tick(80);
assert.ok(!pressed(boxes, 'failed'), 're-cliquer décoche (retrait par la case)');
assert.ok(
  chipNodes(boxes).every((c) => !/failed/.test(c.textContent)),
  'la puce suit le retrait'
);
// La légende du bas reste présente et pilotable : un seul état partagé entre les deux UI.
const legendLabels = [...boxes.querySelectorAll('button')].filter(
  (b) => !uiNode(boxes, 'panel-filters').contains(b) && /^\s*(✓\s*)?\w+\s*$/.test(b.textContent || '')
);
assert.ok(
  legendLabels.some((b) => /running|success/.test(b.textContent || '')),
  'la légende du bas garde ses pastilles cliquables'
);

/* Replier le panneau avec des filtres actifs est **voulu** : c'est la place rendue au Gantt
   qui compte, et rien n'est perdu — les puces restent visibles et chacune se retire par
   son ✕, sans jamais rouvrir le panneau. Vue fraîche pour ne pas dépendre des clics
   précédents. */
const folded = await mount('?date=2026-11-10&state=failed');
assert.ok(bars(folded).length < bars(auto).length, 'la vue est bien filtrée sur failed');
assert.equal(chipNodes(folded).length, 1, 'une puce « états » visible');
click(byText(uiNodes(folded, 'tab-'), /tab-filters/)); // onglet actif -> repli
await tick();
assert.ok(hidden(uiNode(folded, 'panel-filters')), 'le panneau se replie même avec des filtres actifs');
assert.equal(chipNodes(folded).length, 1, 'la puce survit au repli : la vue reste explicable');
const barsFolded = bars(folded).length;
click(uiNode(folded, 'chip-state')); // retirer le filtre SANS ouvrir le panneau
await tick(80);
assert.equal(chipNodes(folded).length, 0, 'la puce se retire ruban replié');
assert.ok(bars(folded).length > barsFolded, 'le retrait du filtre change bien la vue');
click(byText(uiNodes(folded, 'tab-'), /tab-filters/));
await tick();
assert.ok(!hidden(uiNode(folded, 'panel-filters')), 'le rouvrir reste un clic');

/* Puce d'état de la fenêtre : l'étendue affichée en deux caractères, le mode, et un clic
   qui bascule zoom auto / 24 h. Elle ne **duplique** pas le bouton de l'onglet Affichage :
   elle pilote le même état `zoomAuto` — vérifié dans les deux sens. Elle reste accessible
   ruban replié, contrairement au bouton. */
const zoom = await mount('?date=2026-11-10&zoom=day');
const zoomChip = () => uiNode(zoom, 'window-chip');
assert.match(zoomChip().textContent, /\d+ h/, 'la puce porte l\'étendue de la fenêtre');
assert.ok(zoomChip().textContent.includes('🕐'), 'journée complète = horloge');
assert.ok(attr(zoomChip(), 'title').includes('Journée complète'), 'le mode annoncé vient bien de ?zoom=day');
click(zoomChip());
await tick(80);
assert.ok(zoomChip().textContent.includes('🔍'), 'un clic passe en zoom auto');
assert.match(uiNode(zoom, 'panel-view').textContent, /Zoom auto/, 'le bouton de langlet Affichage a suivi la puce');
assert.ok(attr(zoomChip(), 'title').includes('Cliquer pour afficher les 24 h'), "l'infobulle annonce la bascule inverse");
click(zoomChip());
await tick(80);
assert.ok(zoomChip().textContent.includes('🕐'), 'second clic : retour à la journée complète');
assert.match(uiNode(zoom, 'panel-view').textContent, /Journée complète/, 'et le bouton de langlet suit aussi');
// Repliée, la puce reste le seul moyen d'agir sur la fenêtre : elle doit continuer à répondre.
click(byText(uiNodes(zoom, 'tab-'), /tab-view/));
await tick();
click(byText(uiNodes(zoom, 'tab-'), /tab-view/));
await tick();
assert.ok(hidden(uiNode(zoom, 'panel-view')), 'panneau replié');
click(zoomChip());
await tick(80);
assert.ok(zoomChip().textContent.includes('🔍'), 'la bascule fonctionne aussi ruban replié');

/* Les étapes sont un réglage de **regroupement**, pas un filtre : elles vivent dans
   l'onglet Affichage, ne produisent pas de puce retirables, et survivent à la
   réinitialisation des filtres (mais voyagent toujours dans l'URL, `?stages=`). */
click(byText(uiNodes(ribbonView, 'tab-'), /tab-filters/));
await tick();
assert.ok(!uiNode(ribbonView, 'panel-filters').textContent.includes('grupes'), 'plus de champ Étapes dans langlet Filtres');
click(byText(uiNodes(ribbonView, 'tab-'), /tab-view/));
await tick();
assert.ok(uiNode(ribbonView, 'panel-view').textContent.includes('Ordre des groupes'), 'Étapes rangé dans langlet Affichage');

const dirty = await mount('?date=2026-11-10&tag=spark&state=failed&q=alive&stages=collecte');
assert.deepEqual(
  chipNodes(dirty).map((c) => c.getAttribute('data-gk-ui')),
  ['chip-q', 'chip-tag', 'chip-state'],
  'trois puces : les étapes ne sont pas un filtre'
);
click(byText(uiNodes(dirty, 'tab-'), /tab-filters/));
await tick();
const reset = [...dirty.querySelectorAll('button')].find((b) => /Réinitialiser les filtres/.test(b.textContent || ''));
assert.ok(reset && !reset.disabled, "réinitialisation active dès qu'un filtre est actif");
click(reset);
await tick(80);
assert.equal(chipNodes(dirty).length, 0, 'plus aucune puce visible après réinitialisation');
assert.match(dirty.textContent, /2026-11-10/, 'la date survit à la réinitialisation des filtres');
click(byText(uiNodes(dirty, 'tab-'), /tab-view/));
await tick();
assert.ok(
  uiNode(dirty, 'panel-view').querySelector('[data-gk-ui="stages-input"]').value === 'collecte',
  'le réglage des groupes survit, lui aussi, à la réinitialisation'
);
const resetAgain = [...dirty.querySelectorAll('button')].find((b) => /Réinitialiser les filtres/.test(b.textContent || ''));
assert.ok(resetAgain.disabled, "réinitialisation désactivée quand aucun filtre n'est actif");

/* ------------------------------- 6. filets ------------------------------- */

// Chiffres relevés **avant** de démonter : après `unmount`, les conteneurs sont vides.
const measured = { off: bars(off).length, five: bars(five).length, auto: bars(auto).length };
for (const root of roots) root.unmount();
console.error = realError;
assert.deepEqual(complaints, [], `avertissements React pendant le rendu :\n${complaints.join('\n')}`);

console.log(
  `\nrender.test.mjs : assertions passées — ${measured.off} barres avec bin=off, ` +
    `${measured.five} en buckets 5 min, ${measured.auto} en auto, ` +
    `pour ${runs.length} runs et 1 seul tooltip`
);
