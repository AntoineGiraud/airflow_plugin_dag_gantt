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
const domProps = (p) => {
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    if (KEEP.includes(k) || k.startsWith('data-') || k.startsWith('aria-')) out[k] = v;
  }
  return out;
};
// forwardRef : le Box de l'hôte en est un, et le widget y accroche un ref (ResizeObserver).
const mk = (el) => R.forwardRef((p, ref) => R.createElement(el, { ...domProps(p), ref }, p.children));
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
const links = (c) => c.querySelectorAll('a');
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
assert.match(auto.textContent, /· buckets \d+ min/, 'granularité effective absente de la ligne d’info');
assert.match(auto.textContent, /1126/, 'le badge de la ligne doit compter des RUNS, pas des buckets');
assert.equal(globalThis.__tooltipRoots || 0, 0, 'des Chakra.TooltipRoot ont été instanciés par barre');

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
const soloBar = off.querySelector('a[data-gk]');
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

/* ------------------------------- 4. filets ------------------------------- */

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
