# Agrégation des runs en buckets + correction de latence

## Contexte

Sur la journée du 2026-11-10, le groupe `« autre »` contient **1 DAG / 1126 runs** (`ALIVE`), et le
groupe `spark` 145 runs : ~1270 barres rendues, chacune = un `Router.Link` + un `Box` + un
`Chakra.TooltipRoot` complet (contexte + floating-ui + presence). Résultat : latence visible au
chargement **et** tous les 5 s.

Ce que le code actuel coûte cher (`js/src/DagGanttWidget.jsx`) :

| Coût | Cause |
|---|---|
| ~1270 instances `TooltipRoot` | tooltip créé **par barre** (`GanttBar`, l.230-241) |
| ~1270 `Router.Link` | navigation câblée composant par composant |
| Re-render **total** toutes les 5 s | le tick `now` invalide `rows` (l.520, dépend de `now`) → `groups` → toutes les `DagRow` |
| Recalcul de toutes les positions | `computeWindow` prend `now` brut : dès qu'un run tourne, `t1 = now` et la fenêtre glisse au tick |
| 6 lanes × 1126 barres empilées | `DagRow` emballe les **runs**, pas des regroupements |

**Arbitrage de l'utilisateur (11/11)** — l'outil est une **vue d'ensemble statique** : « je veux la vue
d'ensemble de mes DAGs sur une page, un aperçu de ce qui a tourné dans la journée et quand, **pas de
navigation** ». Trois conséquences, intégrées ci-dessous :

- la navigation devient **marginale** : seul le **nom du DAG** (colonne de gauche) est un lien, et
  seules les **barres en échec** sont cliquables (voir §4) — les barres saines ne sont plus des liens
  (moins de DOM, moins de `Router.Link`) ;
- **aucun plafond** sur `/api/runs` : la journée complète est rendue, `RUN_LIMIT` saute (§6 bis) ;
- la journée longue garde le **scroll vertical** avec des lignes compactes (pas de « fit to screen »).

Deux chantiers complémentaires, validés avec l'utilisateur :

1. **Agrégation** : fusionner en une barre les runs d'un même DAG démarrant dans la même tranche
   (1 min / 5 min / 15 min / 30 min / 1 h / auto / off), couleur **rouge si au moins un run est en
   erreur**, clic → **liste des runs du DAG filtrée sur la tranche**.
2. **Perf invisible** : un seul tooltip partagé, navigation déléguée, gel du tick `now` — gain même
   sur les lignes peu chargées, et même agrégation désactivée.

Que du front-end : `/api/runs` (RUN_LIMIT 2000) n'est pas touché.

## Réponse au « 1 h sur 24 h, c'est sévère »

Tout à fait : c'est pour ça que **l'auto ne dépasse jamais 30 min** (tableau plus bas) et que 1 h
reste un choix manuel assumé dans le select. De plus une barre agrégée n'est jamais trompeuse :
elle affiche `N×`, et le tooltip donne la répartition par état.

## Approach

### 1. Module pur `js/src/aggregation.js` (nouveau)

Fonctions sans React, testables :

```js
BIN_OPTIONS      // [{value:'auto'|'off'|'1m'|'5m'|'15m'|'30m'|'60m', label}]
parseBin(value)        // '5m' -> 300000 | null (off) | undefined (auto)
autoBinMs(spanMs)      // ≤3 h -> 1 min · ≤6 h -> 5 min · ≤12 h -> 15 min · >12 h -> 30 min
bucketize(runs, dayStart, binMs, nowMs)  // -> [{kind:'run'|'bucket', ...}]
worstState(states)     // failed > running > queued > planned > success
```

`bucketize` (les `runs` arrivent déjà triés par `start`) :

- `binMs == null` (off) → un item par run, comportement actuel.
- sinon `clé = floor((start - dayStart) / binMs)` ; un groupe de 1 → item `run` **inchangé** ;
  un groupe de ≥2 → item `bucket`.
- un run sans `start` parsable n'est jamais fusionné.
- item `bucket` : `{kind:'bucket', dagId, start: min(start), end: max(end||now), count,
  states: {failed:2, success:10}, state: worstState(...)}` — les bornes sont les **vraies**
  dates des runs (pas les bords du bucket) : la barre reste fidèle.

Point important : `computeWindow` continue de consommer les **runs bruts filtrés**, jamais les
buckets → pas de boucle de rétroaction fenêtre ↔ granularité.

### 2. Rendu d'une barre (remplace `GanttBar`)

`Bar` consomme un *item* (`run` ou `bucket`) au lieu d'un run :

- `left`/`width`/couleur/durée : même calcul ; couleur = `STATE_COLORS[item.state]`, donc
  **rouge dès qu'un run du bucket a échoué** (`worstState`).
- Label : `12×` si `count > 1` et largeur ≥ 24 px, puis la durée si ≥ 55 px (`12× · 4m 12s`).
  Bordure `running.solid` si le bucket contient un run en cours.
- Lane packing (`MAX_LANES`) appliqué aux **items** : `ALIVE` passe de 3 lanes/1126 barres à
  ≤ 1 lane et ~168 barres max sur une fenêtre de 14 h en buckets de 5 min.
- Fini `run._lane = lane` (mutation des données de l'API) : le lane vit dans l'item recréé par
  `bucketize`, mémoïsé.
- `DagRow` : signature inchangée, reçoit `items` au lieu de `runs` (le badge `Nx` garde le
  **nombre de runs**, pas de buckets) ; en-tête de groupe `N failed` inchangé (calculé sur les runs).

### 3. Select « Agrégation » dans la toolbar

- `<Select value={bin} options={BIN_OPTIONS} />`, défaut **`auto`** ; `off` = rendu actuel à 100 %.
- Persisté dans l'URL : `URL_KEYS` += `'bin'` (écrit seulement si ≠ auto → URL par défaut propre).
- Info-bulle de l'auto : « granularité choisie d'après la fenêtre affichée, 30 min maximum ».
- À droite, dans la ligne d'info existante, on ajoute la granularité effective quand au moins une
  fusion a eu lieu : `14:02 → 18:10 · 4h 08m · buckets 5 min`.

### 4. Navigation minimale : le DAG, et ce qui a échoué

Le Gantt n'est pas un lanceur : **une barre saine n'est pas un lien**. Restent deux façons d'aller
voir plus loin, quand c'est utile :

- **Nom du DAG** (colonne de gauche) → `/dags/<dag_id>` (1 lien par ligne, au lieu d'un lien par run).
- **Barre en échec** (`state === 'failed'`, run isolé **ou** bucket contenant ≥ 1 échec) →
  - run isolé : `/dags/<dag_id>/runs/<run_id>` (la grille du run, comme avant),
  - bucket : `/dags/<dag_id>/runs?run_after_gte=<start>&run_after_lte=<end>&state=failed`, i.e. la
    liste des runs du DAG bornée sur la tranche **et sur l'échec**.

Paramètres `snake_case` **vérifiés dans le bundle de l'hôte** (Airflow 3.3.2+astro, bundle UI
`index-BqCw3gZp.js`) : l'enum `SearchParamsKeys` expose `RUN_AFTER_GTE='run_after_gte'`,
`RUN_AFTER_LTE='run_after_lte'`, `STATE='state'` — la page de runs lit
`h.get(FB.RUN_AFTER_GTE)` / `h.get(FB.RUN_AFTER_LTE)` / `h.get(FB.STATE)`. Il n'y a **pas** de
`run_state` (ce serait `dag_run_state`, qui filtre la *liste des DAGs*) : le bon paramètre d'état est
`state`. Une clé inconnue reste ignorée par l'hôte → le lien ouvre au pire la liste du DAG.

Deux caveats assumés et documentés dans le code :

- la liste native filtre sur `run_after`, le Gantt dessine d'après `start_date` → bornes légèrement
  plus larges que le bucket ;
- cette page native pagne 10 runs par défaut (`limit=10`) : on ne touche pas à `limit`, le bucket
  n'est pas une liste exhaustive mais un point d'entrée.

Les barres non cliquables restent **inspectables au survol** : le tooltip unique (§5) porte le compte,
les bornes, la durée, la répartition par état et 5 runs détaillés — c'est lui qui porte le détail,
pas le clic.

### 5. Perf : un seul tooltip, une seule poignée de composants

- Suppression de `Chakra.TooltipRoot` par barre : **un** `HoverTip` rendu par le widget
  (`position="fixed"`, `pointerEvents="none"`, `whiteSpace="pre-line"`, borné au viewport).
- **Délégation** sur le conteneur du Gantt : `onMouseOver` → `e.target.closest('[data-gk]')` →
  `hoverKey` ; l'état ne change **que** si la clé change (pas de re-render au `mousemove`).
  Le texte est construit à la demande depuis une `Map` clé→item (plus de concaténation de
  ~1270 chaînes à chaque render).
- Contenu tooltip d'un bucket :
  `ALIVE · 12 runs · 14:05:00 → 14:09:30 · 4m 30s` / `failed 2 · success 10` / 5 lignes de runs au
  plus + `… +7 autres`.
- **Navigation déléguée, sur les seuls liens qui subsistent** (§4) : `<Router.Link>` composant par
  barre supprimé ; les barres en échec sont de simples `<a href>` (clic molette / nouvel onglet
  toujours possibles), le nom du DAG aussi ; un `onClick` **unique** sur le conteneur intercepte
  `[data-gk]`/`[data-nav]` et appelle `Router.useNavigate()` (SPA). Sans `useNavigate` sur l'hôte, on
  laisse le `<a>` faire son travail.
- **Gel du temps** :
  - `nowQ = floor(now / 60000) * 60000` alimente `rows`, `computeWindow` et les barres → plus de
    glissement de fenêtre ni de re-render pour 3 s de running ; seule la ligne « maintenant » (1
    élément) garde le `now` brut.
  - le tick de 5 s n'est armé **que** si `data.runs` contient du `running`/`queued`, sinon 60 s.
- `React.memo` sur `DagRow` et `Bar` : avec `nowQ`, `windowStart`, `windowSpan`, `binMs`,
  `chartWidth` comme props, un tick qui ne change rien ne re-render plus rien.

### 6 bis. `/api/runs` : plus de plafond journalier

`RUN_LIMIT = 2000` tronquait la journée (message « (tronqué, limite API) ») — inacceptable pour une
vue d'ensemble : **une journée, la totalité des runs**. Suppression de la limite (et du flag
`truncated` du payload, plus de la mention côté JS) ; le `ORDER BY started_at` reste. La densité est
absorbée par l'agrégation côté front (§1), plus par un plafond arbitraire côté base.

Gain de rendu induit : les ~1270 `Router.Link` + `TooltipRoot` disparaissent (§4/§5), donc laisser
5 000 ou 10 000 runs arriver ne se traduit plus par 10 000 composants — après agrégation, quelques
centaines de barres.

### 7. Version & doc

- `src/airflow_dag_gantt/__init__.py` : `0.5.0` → `0.6.0` (feature).
- README : une puce « runs agrégés par tranche (auto/1 min…1 h/off), rouge si au moins un échec,
  détail au survol » + le paramètre `bin` dans la section partage d'URL + une ligne « vue complète de
  la journée, sans plafond API » et le fait que **seuls le nom du DAG et les échecs sont cliquables**.

## Files to modify

- `js/src/aggregation.js` — **nouveau** : `BIN_OPTIONS`, `parseBin`, `autoBinMs`, `bucketize`,
  `worstState`.
- `js/src/DagGanttWidget.jsx` — `GanttBar` → `Bar` sur items, `DagRow` (items + lanes + badge),
  suppression du tooltip par barre, `HoverTip` + délégation `mouseover`/`click`, select
  « Agrégation », `nowQ` + tick conditionnel, `URL_KEYS`, info-bulle fenêtre.
- `js/test/aggregation.test.mjs` — **nouveau** : assertions `node:assert` sur `bucketize` /
  `autoBinMs` / `worstState` (fusion, rouge dominant, run isolé, `off`, runs sans start), lancé par
  `node js/test/aggregation.test.mjs` (zéro dépendance, jest non installé).
- `src/airflow_dag_gantt/api.py` — suppression de `RUN_LIMIT` / `truncated`.
- `src/airflow_dag_gantt/__init__.py`, `README.md`.

Pas de nouvelle dépendance JS, pas de changement de schéma de payload autre que `truncated`.

## Reuse

- `STATE_COLORS` / `STATE_ORDER` / `DEFAULT_COLOR` : la priorité `worstState` s'appuie sur
  `STATE_ORDER` étendu, aucune nouvelle palette.
- `Select` (déjà utilisé pour tags et tri) : le select « Agrégation » est le même composant.
- `useUrlSync` / `URL_KEYS` : persistance de `bin` sans nouveau mécanisme.
- `computeWindow`, `pickStepMs`, lane packing existant : conservés, ils changent juste d'input
  (items au lieu de runs pour le packing).
- `fmtDuration` / `fmtTime` / `fmtClock` : réutilisés pour le tooltip des buckets.

## Steps

- [x] 1. `js/src/aggregation.js` + test node ; `node js/test/aggregation.test.mjs` vert (19 tests).
- [ ] 2. `DagRow`/`Bar` sur items + lanes sur items ; agrégation visible sur `ALIVE`.
- [ ] 3. Select `bin` + `URL_KEYS` + mention de la granularité dans la ligne d'info.
- [ ] 4. `HoverTip` unique + délégation `mouseover` ; suppression de `TooltipRoot` par barre.
- [ ] 5. Liens **réservés au nom du DAG et aux barres en échec** + navigation déléguée (`useNavigate`).
- [ ] 6. `nowQ`, tick conditionnel, `React.memo` sur `DagRow`/`Bar`.
- [ ] 6 bis. `api.py` : suppression du plafond `RUN_LIMIT` et du flag `truncated`.
- [ ] 7. `./dev.sh js` pour itérer, puis `./build.sh` en dernier mot ; bump `0.6.0` + README.
- [ ] 8. `git commit` local (**pas de push**) et résumé de ce qui est prêt à pousser.
- [x] 9. (ajout 11/11) `prek` : `.pre-commit-config.yaml` rejoue CI + `./build.sh`, dont la wheel à
      l'étage `pre-push` — la loi « dernier mot au build » devient mécanique.

## Vérification

1. `node js/test/aggregation.test.mjs` + `cd js && bun run build` sans erreur.
2. `./dev.sh js`, recharger `/dag-gantt` (journée 2026-11-10, ~1270 runs) :
   - **ressenti** : scroll et survol fluides ; dans les devtools, le DOM du Gantt doit passer de
     ~1270 barres + tooltips à quelques centaines de barres et **1** tooltip ;
   - agrégation par défaut sur `ALIVE` : barres larges portant `N×`, **rouge** dès qu'un run du
     bucket a échoué, `« autre » · 1126 runs · 325 failed` toujours exact dans l'en-tête ;
   - select : `Off` ↔ `5 min` ↔ `1 min` change visiblement la densité ; `?bin=off` rouvre la vue
     détaillée ; l'URL par défaut reste sans `bin` ; sur « Journée complète » l'auto plafonne à
     30 min ;
   - **une barre saine n'est pas cliquable** (aucun lien, curseur normal) ; clic sur une barre rouge →
     grille du run (run isolé) ou `/dags/ALIVE/runs` **borné sur la tranche + `state=failed`**
     (bucket) ; si l'hôte ignore les paramètres, le lien doit au moins ouvrir la liste du DAG —
     consigner et ajuster ; clic sur le **nom du DAG** → `/dags/<dag_id>` ; clic molette sur un lien →
     nouvel onglet ;
   - tooltip bucket : compte, bornes, durée, répartition par état, liste tronquée à 5 runs ;
   - `curl …/api/runs?date=2026-11-10 | jq .count` > 2000 s'il existe plus de runs ce jour-là et plus
     aucun « (tronqué, limite API) » à l'écran.
3. Non-régression : filtres nom/tag/état (le bucket se recalcule après filtrage), tri, groupes et
   repli, ⬅️/➡️, zoom auto vs journée complète, barres `running` qui avancent, ligne « maintenant ».
4. `pytest tests/` (packaging) + `ruff check` inchangés ; `./dev.sh full` avant de committer.

## Preuves déjà récoltées

- **Agrégation et rendu mesurés, en CI** : `js/test/render.test.mjs` (`bun run test:dom`, happy-dom)
  monte **le vrai composant** sur 1127 runs d'une même journée (~14 h d'activité) : `bin=off` →
  **1127 barres**, `bin=5m` → **170**, `auto` → **30**, **0 `TooltipRoot`** instancié et **1** tooltip
  `[data-tip]`, liens = 1 par DAG + 1 par barre en échec (69 pour 67 `failed` + 2 noms), clic délégé
  sur une barre en échec → `/dags/ALIVE/runs/<run_id>`, barre saine → **rien**, nom du DAG →
  `/dags/ALIVE`, bucket → `?run_after_gte=…&run_after_lte=…&state=failed`, ctrl+clic **non** intercepté.
  Le test échoue en outre sur **tout avertissement React** (il a déjà démasqué une clé `run_id`
  dupliquée dans le jeu de données du test, et le `ref` posé sur le `Box` de l'hôte).
- **Le bump de version a deux sources** : `pyproject.toml` (`version = `) ET
  `src/airflow_dag_gantt/__init__.py` ; seul le second nommait le wheel —
  `test_version_is_consistent_between_pyproject_and_package` l'a attrapé. Les deux à `0.6.0`.
- `pytest -q -rs tests` → **9 passed** (8 + le nouveau contrat « plus de plafond ») ;
  `ruff check` + `ruff format --check` verts ; `./build.sh` → `airflow_dag_gantt-0.6.0-py3-none-any.whl`.
- `/api/runs?date=2026-11-10` (conteneur de dev) renvoie `count`, `date`, `runs`, `window` — plus de
  clé `truncated`. Le `Math.max(...runs.map(…))` de `rows` est devenu un `reduce` : sans plafond API,
  un spread de plusieurs dizaines de milliers d'arguments serait un `RangeError`.
- Clés d'URL de la page runs de l'hôte : `run_after_gte`, `run_after_lte`, `state` (bundle UI
  `airflow/ui/dist/assets/index-BqCw3gZp.js`, Airflow `3.3.2+astro.3`) — le `run_state` du plan
  initial n'existe pas.
- `node js/test/aggregation.test.mjs` : **27 tests** verts (le `.js` en ESM est chargé par détection de
  syntaxe Node ≥ 23 ; `--disable-warning=MODULE_TYPELESS_PACKAGE_JSON` pour une sortie propre).
  `bun run test` (script ajouté à `js/package.json`) fait la même chose sans avertissement.
- `prek run --all-files` → 6 hooks verts en ~3 s ; `--hook-stage manual` (+ wheel) → ~6 s.
- Le harnais headless a été **promu en test commité** (choix de l'utilisateur) : `happy-dom` est une
  devDependency (`js/package.json`, jamais dans la wheel — `hatch_build.py` ne copie que `js/dist`),
  l'étape est en CI et en hook `pre-commit`.
