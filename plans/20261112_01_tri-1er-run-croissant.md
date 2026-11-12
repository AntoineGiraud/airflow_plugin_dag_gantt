# Tri « 1er run » : le rendre chronologique (v0.7.2)

## Context

Le tri par défaut des lignes de DAG est `Tri : 1er run`. Dans `js/src/lib/view.js`, **tous**
les comparateurs sont écrits décroissants, celui-là compris :

```js
// js/src/lib/view.js:100-105
const comparators = {
  first: (a, b) => b.firstStart - a.firstStart,   // ← décroissant : le 1er run le PLUS TARDIF en haut
  last: (a, b) => b.lastEnd - a.lastEnd,          // décroissant : voulu (activité récente en haut)
  duration: (a, b) => b.maxDuration - a.maxDuration,
  count: (a, b) => b.count - a.count || a.dagId.localeCompare(b.dagId),
  name: (a, b) => a.dagId.localeCompare(b.dagId),
};
```

Conséquence vécue : « 1er run » ne ressemble à rien de chronologique et **se confond avec
« Dernier run » décroissant** — un DAG qui n'a qu'un run dans la journée a `firstStart` et
`lastEnd` alignés, donc les deux critères trient dans le même ordre et basculer de l'un à
l'autre ne change rien à l'écran. D'où « le tri 1er run ne fonctionne pas du tout ».

Rien n'est cassé mécaniquement : c'est le **sens** qui est faux. Le sens attendu est
`firstStart` **croissant** — le DAG qui démarre le plus tôt en haut, la lecture du graphique
suit l'ordre d'exécution de la journée (collecte → … → export). « Dernier run » garde son
décroissant, qui lui va.

## Décisions actées

- `first` → **croissant simple**, sans bouton d'inversion.
- Libellés qui disent le sens : `Tri : 1er run (ancien → récent)` et
  `Tri : Dernier run (récent → ancien)`. Les `value` (`first`, `last`) ne bougent pas →
  les URL déjà partagées (`?sort=first`) restent valides.
- Mode groupé : **ordre des groupes inchangé** (étapes saisies, puis fréquence, « autre » en
  dernier) ; le tri ne joue qu'à l'intérieur de chaque groupe. `js/src/lib/grouping.js`
  n'est pas touché.
- Livraison en **0.7.2** (patch) + rebuild du bundle.
- Terminologie du commit : c'est un **`fix`**, pas un `refactor` — un refactor ne change pas
  le comportement observable, or ici l'ordre à l'écran change et le symptôme était un bug.
  Proposition : `fix(gantt): tri « 1er run » chronologique (v0.7.2)`.

## Approach

Un seul comparateur à retourner, plus un départage déterministe : aujourd'hui deux lignes qui
démarrent (ou finissent) à la même seconde gardent l'ordre arbitraire renvoyé par l'API, ce
qui rend l'ordre instable d'un rafraîchissement à l'autre. Le départage par nom de DAG existe
déjà sur `count`, on l'applique à `first` et `last`.

```js
first: (a, b) => a.firstStart - b.firstStart || a.dagId.localeCompare(b.dagId),
last: (a, b) => b.lastEnd - a.lastEnd || a.dagId.localeCompare(b.dagId),
```

`duration` et `name` restent tels quels. Aucun champ nouveau dans `buildRows`, aucun appel API
nouveau : `firstStart`, `lastEnd`, `maxDuration`, `count` sont déjà calculés.

## Files to modify

| Fichier | Changement |
| --- | --- |
| `js/src/lib/view.js` | `first` croissant + départage ; `last` + départage ; commentaire à jour (« croissant : le plus tôt de la journée en haut »). |
| `js/src/lib/constants.js` | Libellés `SORT_OPTIONS` avec le sens ; `DEFAULT_SORT = 'first'` inchangé. |
| `js/test/view.test.mjs` | Assertion `:88` (`['ALPHA','alpha','beta']` → `['beta','alpha','ALPHA']`, message « décroissant » → « croissant ») + cas d'ex æquo. |
| `pyproject.toml`, `src/airflow_dag_gantt/__init__.py` | `0.7.1` → `0.7.2` (les deux, sinon `tests/test_plugin_packaging.py:186` rouge). |
| `js/src/lib/grouping.js` | **non touché** (décision groupes). |

## Reuse

- Départage `|| a.dagId.localeCompare(b.dagId)` : même ligne, comparateur `count`.
- `Select` (`js/src/components/Select.jsx`) rend `label` tel quel → aucun composant à adapter,
  le ruban (`ControlRibbon.jsx:329`) passe déjà `SORT_OPTIONS`.
- `DagGanttWidget.jsx:54` valide l'hydratation par `SORT_OPTIONS.some(o => o.value === …)` :
  inchangé puisque seules les valeurs stables comptent.
- `js/test/grouping.test.mjs` (ordre des groupes) et `js/test/render.test.mjs` (rendu headless
  sur 1127 runs) : garde-fous déjà en place, à relancer tels quels.

## Steps

- [x] 1. `view.js` : `first` croissant, `last` inchangé de sens, départage sur les deux, à jour de commentaire.
- [x] 2. `constants.js` : libellés `(ancien → récent)` / `(récent → ancien)`.
- [x] 3. `view.test.mjs` : sens attendu inversé + deux DAGs à `firstStart` égal (attendu : nom croissant) + un contrôle ex æquo sur `lastEnd`.
- [x] 4. Version `0.7.2` dans `pyproject.toml` **et** `__init__.py`.
- [x] 5. `cd js && bun run test && bun run test:dom`, puis `./build.sh`.
- [x] 6. `git commit` (pas de push — c'est toi qui pousses).

## Verification

- `cd js && bun run test && bun run test:dom` → vert, dont la nouvelle assertion de sens.
- `./build.sh` puis `./dev.sh`, journée chargée (ex. `gantt_demo`) :
  - `Tri : 1er run (ancien → récent)` : les DAGs du matin en haut, les derniers en bas ;
  - basculer sur `Dernier run (récent → ancien)` **réordonne visiblement** la liste
    (c'était exactement le symptôme inverse) ;
  - en mode groupé, l'ordre des groupes ne bouge pas, seules les lignes à l'intérieur suivent ;
  - le rafraîchissement de 30 s ne fait plus danser les lignes ex æquo.
- URL : `?sort=first` et `?sort=last` toujours reconnus ; `sort` absent par défaut
  (`DEFAULT_SORT` jamais réécrit, `DagGanttWidget.jsx:92`).
- `.venv/bin/pytest -q tests` pour le test d'égalité des versions.
