# React Doctor — top 3 des constats, refactor v0.7.3

## Contexte

`bunx npx react-doctor@latest` (v0.9.22, lancé depuis `js/`) donne **score 49/100, 17 constats**
sur `dag-gantt-react-plugin` (28 fichiers). Reproduit localement : `js && npx -y react-doctor@latest
--verbose` → 1,4 s de scan, ~13 s avec le téléchargement npx.

Les quatre règles retenues, dans l'ordre demandé :

| # | Règle | Nb | Sites |
| --- | --- | --- | --- |
| 1 | `no-high-complexity-react-function` | 3 | `DagGanttWidget.jsx:38` (CC 27/29), `components/Bar.jsx:16` (CC 19/19), `components/ControlRibbon.jsx:118` (CC 20/19) |
| 2 | `rerender-lazy-state-init` | 4 | `DagGanttWidget.jsx:43, 48, 49, 67` |
| 3 | `exhaustive-deps` | 5 | `DagGanttWidget.jsx:100, 101, 113, 118`, `hooks/useRuns.js:51` |
| 4 | `rules-of-hooks` (**erreurs**) | 4 | `DagGanttWidget.jsx:177`, `hooks/useUrlSync.js:22, 23, 35` |

Les quatre erreurs `rules-of-hooks` sont **incluses dans ce pass** sur décision utilisateur : ce
sont les seuls constats en sévérité *error*, donc sans elles un hook `prek` react-doctor serait
rouge dès le premier commit. Reste hors périmètre : `js-set-map-lookups`, 1 avertissement
(`components/StateLegend.jsx:12`) → §Suite.

Recettes canoniques lues **sans cache** (`curl -H 'Cache-Control: no-cache'` + fetch) sur
`react.doctor/docs/rules/react-doctor/<règle>` :

- **complexity** : « extraire les branches de rendu indépendantes en composants, et la logique
  d'état cohesive en hooks ; **ne pas découper juste pour faire baisser le nombre** si
  l'indirection rend le comportement plus dur à suivre ». Seuil : complexité cyclomatique **ou**
  cognitive > 15.
- **lazy-state-init** : « envelopper l'initialiseur **pur et répétable** dans une fléchée :
  `useState(() => cher())` ». Le détecteur ne tire que sur un *CallExpression* direct en 1er
  argument (les coerceurs triviaux `Boolean/String/Number/Array/Object/parseInt/parseFloat` sont
  exclus).
- **exhaustive-deps** : « ajouter **toute** capture réactive quand on fournit un tableau de deps ;
  déplacer ou stabiliser ce qui est recréé à chaque rendu ; ne pas ajouter à l'aveugle ».
- **rules-of-hooks** : « appeler les hooks au niveau supérieur d'un composant ou d'un hook custom,
  pour que React voie le même ordre de hooks à chaque rendu ».

## Explication en clair (ce que chaque règle veut dire, et à quel point c'est grave)

1. **Complexité** — trois fonctions « savent trop de choses à la fois ». Rien ne casse aujourd'hui :
   c'est un coût **d'entretien**, pas un bug. Concrètement : `DagGanttWidget` décide à la fois de
   l'hydratation URL, de 11 états, de 15 calculs, du libellé des infobulles et de trois états de
   rendu — une modif de libellé y croise du calcul de fenêtre. Chaque branche en trop est une
   combinaison de plus à tester mentalement quand on touche au Gantt : c'est là que naissent les
   régressions qu'aucun test n'attrape. Sévérité : **confort/robustesse du code, zéro impact
   utilisateur visible**.
2. **State initializer** — `useState(f())` **exécute** `f()` à *chaque* rendu alors que React
   jette le résultat après le premier montage. Ici les quatre appels sont
   `initialQuery.get('date' | 'q' | 'tag' | 'stages')` : une recherche dans une chaîne de ~100
   caractères. Coût réel : **négligeable** (quelques microsecondes × 4 par rendu) — l'utilisateur
   ne verra jamais la différence. Ce qui compte est le *réflexe* : la même ligne écrite sur
   `JSON.parse(localStorage...)` ou sur un tri de 1 127 runs coûterait vraiment le rendu. Le détecteur
   a raison sur le motif, et la correction est gratuite. Sévérité : **nettoyage, pas d'impact mesurable**.
3. **Hook appelé dans une condition** — `HasNavigate ? Router.useNavigate() : null` et, dans
   `useUrlSync`, un `if/else` qui contient **deux `useEffect` différents**. React compte les hooks
   dans l'ordre : si le nombre change entre deux rendus, un état se retrouve attaché au mauvais hook
   et l'UI devient incohérente de façon imprévisible (un filtre qui répond au mauvais champ, un
   intervalle qui ne se nettoie plus). **Gravité réelle ici : théorique**, parce que la condition est
   une constante calculée une fois au chargement du module (`HasNavigate`, `HasSearchParams`) — elle
   ne peut pas changer entre deux rendus. Mais c'est une faute de règle de React, la seule en
   `error`, et elle ferait échouer n'importe quel contrôle bloquant. Coût du vrai fix : dix lignes.
4. **Dépendances manquantes** — les `useMemo` lisent `data` (l'objet complet renvoyé par l'API)
   mais ne déclarent `[data.runs]`. Aujourd'hui ça marche **par chance** : chaque refresh fabrique
   un nouveau `runs`, donc le calcul repart. Le piège est latent et classique : demain, quelqu'un
   écrit `listStates(data)` en utilisant `data.count` (ou mutte le payload en place), le memo ne se
   re-déclenche plus, et **l'écran affiche des données périmées sans erreur dans la console** — le
   genre de bug qui passe en revue, se « corrige » en rechargeant, et revient chez un autre. C'est
   le seul des trois qui est une vraie **bombe à retardement de correction**, d'où sa priorité P2
   chez react-doctor. Sévérité : **faible aujourd'hui, sérieux si on garde le motif**.

## Approche

Quatre corrections de **cause**, pas de façade (aucun `eslint-disable`, aucun
`// react-doctor-ignore`) — A, B, C pour le top 3 demandé, D pour les quatre erreurs :

### A. L'hydratation URL devient une fonction pure (règle 2 + une partie de la règle 1)

Plutôt que d'envelopper mécaniquement quatre `useState(() => initialQuery.get(...))`, on déplace
**toute** la lecture de l'URL dans deux fonctions pures de `lib/view.js`, testables sous Node :

- `readInitialView(search)` → un objet plat `{ date, nameFilter, tagFilter, stateFilter, zoomAuto,
  sortKey, bin, grouped, stagesText, collapsed }` avec les valeurs par défaut déjà appliquées ;
- `viewToQuery(view)` → l'inverse (déjà écrit à la main dans l'appel à `useUrlSync`), avec les
  « défauts → chaîne vide » qui évitent de polluer l'URL.

Dans le conteneur :

```jsx
const [view0] = useState(() => readInitialView(readInitialQuery())); // appelé 1 fois par React
const [date, setDate] = useState(view0.date);                        // plus d'appel dans useState()
...
useUrlSync(viewToQuery({ date, nameFilter, /* … */ }));
```

Un `useState(view0.date)` reçoit une **expression de membre**, plus d'appel → la règle 2 ne peut
plus tirer, et les ~8 `||` / `?:` / `.some()` de l'hydratation quittent le composant (règle 1).
Bonus : `viewToQuery` ne rappelle plus `todayLocal()` que quand la vue a vraiment changé, et
l'aller-retour URL ↔ état devient couvert par des assertions.

Pureté vérifiée (exigence de la recette) : `readInitialQuery` a déjà son `try/catch` hors
navigateur, ne consomme aucun aléa, ne mute rien — donc l'initialiseur lazy reste StrictMode-safe
(React peut l'appeler deux fois en dev), et `view0` n'est jamais réécrit après le montage
(comportement actuel inchangé).

### B. Les `useMemo` ne capturent plus que `runs` (règle 3, cause racine)

Les cinq sites signalés ont la même forme : le callback prend `data`, le tableau de deps ne dit
que `data.runs`. Or `lib/view.js` ne se sert **que** de `data.runs` (jamais de `data.count`).
On change donc la signature des pures pour qu'elles prennent le **tableau** :

- `filterRuns(runs, …)`, `stateCounts(runs, …)`, `listTags(runs)`, `listStates(runs)`,
  `hasLiveRuns(runs)` ;
- côté composants : `const { runs } = data;` puis `useMemo(() => listTags(runs), [runs])`.

La capture et la dépendance deviennent la **même chose** : plus rien de sous-déclaré, et les pures
perdent un paramètre-enveloppe qui ne servait à rien. Les 5 sites (4 dans le conteneur,
`hasLiveRuns` dans `useRuns.js:51`) sont réglés par ce seul changement.

*Plan B si le linter refuse `[runs]` (dépendance locale dérivée) :* écrire `useMemo(() => listTags(data.runs), [data.runs])`
— capture et dep identiques au caractère près. C'est la vérification react-doctor qui tranche.

### C. Découpe des trois fonctions trop denses (règle 1)

- **`Bar.jsx`** — tout ce qui n'est pas du rendu part dans `lib/aggregation.js` (le module qui
  contient déjà `barHref` et `packLanes`) : `barGeometry(item, { windowStart, windowSpan,
  chartWidth })` → `{ left, width, top }`, `barLabel(item, fits)` (le `▶` + `N×` + durée),
  `barVisualProps(item)` (couleur/opacité/bordure), `isLinkable(item)`. `Bar` ne garde que :
  géométrie + libellé + « lien ou pas lien ». Ces fonctions sont pures → **nouvelles assertions**
  dans `aggregation.test.mjs` (elles étaient jusqu'ici inaccessibles au test).
- **`ControlRibbon.jsx`** — le fichier applique déjà le motif « sous-composants dans le même
  fichier » (`Field`, `FilterChip`, `StateChecks`). On continue : `DateNav` (⬅️ / date / ➡️),
  `RibbonFiltersPanel` (panneau Filtres), `RibbonViewPanel` (panneau Affichage). Le ruban devient
  l'assemblage ligne-du-haut + puces. **Interface publique inchangée** (mêmes props de
  `ControlRibbon`) → le test DOM, qui ne parle que par `data-gk-ui`, n'a pas bougé.
- **`DagGanttWidget.jsx`** — après A, il reste les branches de rendu et les textes d'infobulle :
  - les textes (`binTitle`, `summaryLabel`, `summaryTitle`, `windowChipTitle`) passent dans
    `lib/view.js` (fonctions pures + assertions) — ~8 branches de moins ;
  - un composant `components/GanttChart.jsx` prend les trois états de rendu (chargement / vide /
    graphique groupé ou à plat). Le conteneur ne garde que `ribbon → GanttChart → HoverTip →
    StateLegend`, dans le **même ordre DOM** (le test compte les `[data-tip]` et l'ordre des nœuds).
  - *filet de sécurité* : si la mesure ressort > 15 malgré tout, la chaîne de `useMemo` de
    dérivation est regroupée dans `hooks/useGanttModel.js` (une seule indirection, pas une par
    memo). Décision prise **après** re-mesure, pas par principe.

### D. Les hooks sont choisis au niveau du module, pas dans le composant (`rules-of-hooks`)

Le `?:` qui décide « est-ce que l'hôte fournit ce hook ? » descend d'un cran, **hors de toute
fonction React** — la garde existante de `lib/host.js` devient une sélection d'implémentation :

```js
// lib/host.js — HasNavigate / HasSearchParams restent les gardes, à un cran plus haut
export const useNavigateSafe = HasNavigate ? Router.useNavigate : () => null;
```

- `DagGanttWidget.jsx:177` → `const navigate = useNavigateSafe();` (appel inconditionnel ; en
  l'absence d'hôte, `navigate` vaut `null` et `onChartClick` retourne déjà plus tôt, comportement
  actuel conservé au détail près qu'il n'y a plus de branchement de hook).
- `hooks/useUrlSync.js` → deux variantes de module `useUrlSyncRouter` (le `useSearchParams` + son
  `useEffect`) et `useUrlSyncHistory` (le `history.replaceState`), et
  `export const useUrlSync = HasSearchParams ? useUrlSyncRouter : useUrlSyncHistory;`. Chaque
  variante appelle ses hooks inconditionnellement ; le choix est figé au chargement du module, donc
  l'ordre des hooks est **identique à chaque rendu** par construction. Comportement conservé :
  routeur si l'hôte le fournit, `replaceState` sinon (c'est le chemin du test DOM, qui stube
  `useSearchParams`).

Vérification ciblée après ce point : `react-doctor why src/DagGanttWidget.jsx:177` doit répondre
« plus de diagnostic », et le test DOM (qui exercise les deux chemins selon le stub) reste vert.

## Fichiers à modifier

| Fichier | Changement |
| --- | --- |
| `js/src/lib/view.js` | signatures `runs` au lieu de `data` ; + `readInitialView`, `viewToQuery`, textes du ruban (`binHint`, `summaryLabel`, `summaryTitle`, `windowChipTitle`) |
| `js/src/lib/aggregation.js` | + `barGeometry`, `barLabel`, `barVisualProps`, `isLinkable` (à côté de `barHref`/`packLanes`) |
| `js/src/DagGanttWidget.jsx` | hydratation via `readInitialView`, `useState(view0.x)`, `useUrlSync(viewToQuery(…))`, mémos sur `runs`, rendu délégué à `GanttChart` |
| `js/src/hooks/useRuns.js` | `const { runs } = data;` + `hasLiveRuns(runs)` |
| `js/src/lib/host.js` | + `useNavigateSafe` (choix du hook au niveau module) |
| `js/src/hooks/useUrlSync.js` | deux variantes `useUrlSyncRouter` / `useUrlSyncHistory`, `useUrlSync` = sélection de module |
| `.pre-commit-config.yaml` | + hook `js-react-doctor` (`--staged`, bloquant sur les erreurs) |
| `.github/workflows/ci.yml` | + job `lint-js` avec la **même** commande, `--blocking error` |
| `js/src/components/Bar.jsx` | ne garde que le rendu (lien / non-lien) |
| `js/src/components/ControlRibbon.jsx` | + `DateNav`, `RibbonFiltersPanel`, `RibbonViewPanel` |
| `js/src/components/GanttChart.jsx` | **nouveau** — les trois états de rendu du graphique |
| `js/test/view.test.mjs` | appels mis à jour (`data` → `data.runs`) + assertions `readInitialView`/`viewToQuery`/textes |
| `js/test/aggregation.test.mjs` | assertions `barGeometry`/`barLabel`/`isLinkable` |
| `pyproject.toml`, `src/airflow_dag_gantt/__init__.py` | `0.7.2` → `0.7.3` (les **deux**, sinon `tests/test_plugin_packaging.py:186` est rouge) |
| `README.md` | §3.4/§3.5 : mention du scan react-doctor (+ hook prek si ajouté dans ce pass) |

## Réutilisation (rien de réécrit)

- `lib/view.js` — module des « dérivations » pures, déjà testé dans `view.test.mjs` : c'est là que
  vont `readInitialView`/`viewToQuery`/textes, pas dans un nouveau module.
- `lib/aggregation.js` — contient déjà `barHref` et `packLanes`, i.e. **la logique de barre pure
  vit déjà ici** ; `barGeometry`/`barLabel`/`barVisualProps`/`isLinkable` les rejoignent.
- `hooks/useUrlSync.js#readInitialQuery` — le seul point qui touche `window.location` ; on le garde
  comme accesseur, `readInitialView` ne prend que ce qu'il renvoie.
- Motif « sous-composants dans le même fichier » de `ControlRibbon.jsx` (`Field`, `FilterChip`,
  `StateChecks`) pour les deux panneaux.
- Marqueurs DOM existants (`data-gk`, `data-gk-ui`, `data-tip`) : le refactor ne doit **rien**
  renommer, tout le test DOM s'appuie dessus.
- Gardes `HasNavigate` / `HasSearchParams` de `lib/host.js` (et `HasNativeSelect`, même motif) : on
  les garde telles quelles, on ajoute seulement la sélection de hook qu'elles permettent.

## Étapes

- [x] 1. `lib/view.js` : signatures `runs` + `readInitialView` / `viewToQuery` + textes du ruban.
- [x] 2. `lib/aggregation.js` : `barGeometry` / `barLabel` / `barVisualProps` / `isLinkable`.
- [x] 3. `DagGanttWidget.jsx` : A + B + rendu délégué.
- [x] 4. `Bar.jsx` : rendu seul.
- [x] 5. `ControlRibbon.jsx` : `DateNav` + deux panneaux.
- [x] 6. `components/GanttChart.jsx` (nouveau).
- [x] 7. `hooks/useRuns.js` : mémo sur `runs`.
- [x] 8. Tests : mettre à jour `view.test.mjs` / `aggregation.test.mjs`, ajouter les assertions.
- [x] 9. `cd js && bun run test && bun run test:dom` → vert, **sans avertissement React**.
- [x] 10. `npx -y react-doctor@latest --verbose` → les **16** constats des 4 règles ont disparu ;
      vérifier le score et l'absence de **régression croisée** (les autres règles ne doivent pas
      grossir).
- [x] 11. Si un site ressort > 15 : appliquer le filet (`hooks/useGanttModel.js`) et re-mesurer.
- [x] 12. `lib/host.js` : `useNavigateSafe` ; `useUrlSync.js` : deux variantes de module ;
      `DagGanttWidget.jsx:177` → appel inconditionnel.
- [x] 13. `prek` + CI : hook `js-react-doctor` (`npx -y react-doctor@0.9.22 --staged --no-score
      --no-supply-chain`, `files: ^js/`, `pass_filenames: false`) et job CI `lint-js` sur la **même
      commande sans `--staged`**, `--blocking error` (défaut).
- [x] 14. Version `0.7.3` (2 fichiers) + `./build.sh` (bundle + wheel) + README §3.4/§3.5 (+ ligne
      de hook dans le tableau §3.5).
- [x] 15. `prek run --all-files` vert, puis `git add` + commit local
      `refactor(gantt): découplage react-doctor + hooks d'hôte stables (v0.7.3)` — **pas de push**.

## Vérification

```bash
cd js && bun run test && bun run test:dom          # ~120 assertions pures + rendu sur 1127 runs
npx -y react-doctor@latest --verbose               # les 4 règles doivent avoir disparu
prek run --all-files                                # les hooks, dont le nouveau scan react-doctor
cd .. && ./build.sh                                 # bundle + wheel (le hook pre-push de prek)
AIRFLOW_HOME=$PWD/.airflow-home .venv/bin/pytest -q -rs tests   # contrat wheel + version 0.7.3
```

Contrôles manuels sur `./dev.sh` (le seul endroit où l'URL se lit vraiment) :

- `/dag-gantt` nu → mêmes réglages qu'avant (zoom auto, groupé, `bin=auto`, tri `first`) ;
- une URL chargée (`?date=…&q=…&tag=…&state=failed,running&sort=count&zoom=day&bin=15m&group=0&stages=…&collapsed=…`)
  → **mêmes** réglages réhydratés, et le `replaceState` ne réécrit pas l'URL au premier rendu ;
- un clic dans l'onglet Filtres puis F5 → l'URL porte la vue, **jamais** l'onglet ouvert ;
- survol d'une barre → tooltip unique identique (libellés de barre et d'infobulle déplacés, pas réécrits).

## Hook `prek` + CI (décidés : commit bloquant sur les erreurs + CI)

La loi affichée de `.pre-commit-config.yaml` est *relancer les MÊMES commandes qu'en CI* : le scan
est donc ajouté **des deux côtés**.

```yaml
# .pre-commit-config.yaml, après js-tests-dom
- id: js-react-doctor
  name: react-doctor — santé React (mêmes règles qu'en CI)
  entry: npx -y react-doctor@0.9.22 --staged --no-score --no-supply-chain
  language: system
  files: ^js/
  pass_filenames: false
```

```yaml
# .github/workflows/ci.yml — nouveau job, après `lint`
react-doctor:
  name: Santé React (react-doctor)
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@<même SHA épinglé que les autres jobs>
      with: { persist-credentials: false }
    - run: npx -y react-doctor@0.9.22 --no-score --no-supply-chain --blocking error
      working-directory: js
```

Pourquoi ces flags (vérifiés dans `react-doctor --help`) :

- `--staged` : ne scanne que ce qui est dans l'index, et **sort en 0 si rien de `js/` n'est
  indexé** — exactement le comportement voulu dans un hook ;
- `--no-score` (alias `--no-telemetry`) : pas d'appel au service de score, au lien de partage ni à
  Sentry à chaque commit ;
- `--no-supply-chain` : le scan Socket.dev des dépendances est **activé par défaut** ; hors du
  commit (il demande réseau et parle de `package.json`, pas du diff). Il pourra être réactivé en CI
  plus tard ;
- `--blocking error` (défaut explicite en CI) : le commit rougit sur une faute de type « Bugs »,
  les avertissements restent des avis. Une fois les 12 avertissements de ce pass corrigés, on
  pourra durcir en `--blocking warning` (puis `--warning-exit-code`) sans casser la boucle ;
- version **épinglée** `react-doctor@0.9.22`, comme `ruff@0.16.1` — sinon le hook change de règles
  tout seul entre deux commits.

Ce qu'il faut dire honnêtement sur le coût : `npx -y` **consulte le réseau** à chaque commit pour
vérifier la version. Mesure locale : ~13 s la première fois (téléchargement), ~1,5 s de scan une
fois le paquet en cache — mais le `npx` lui-même garde un aller-retour npm. Sorties de secours, à
choisir à l'usage : `react-doctor` en `devDependency` de `js/` (`bunx react-doctor --staged`, hors
ligne et version verrouillée par `bun.lock`), ou `--max-duration 10` pour que le hook ne bloque
jamais plus de dix secondes. `react-doctor install` (qui pose son propre hook + un skill agent) **ne
sera pas utilisé** : on garde la main dans `prek`.

## Suite (follow-up)

| Constat | Nb | Sévérité réelle | Ce qu'il faudrait |
| --- | --- | --- | --- |
| `js-set-map-lookups` (`StateLegend.jsx:12`) | 1 | cosmétique : `legendStates` ≈ 8 états, donc 8 `includes` sur ≈ 8 éléments — invisible à l'œil. | Passer un `Set` construit une fois (`allStates` → `presentStates`) ; même motif que `stateSet` déjà dans le conteneur. |
| Score react-doctor | 49 → ? | indicateur | Re-mesurer après ce pass et durcir le hook en `--blocking warning` quand le score ne bouge plus. |
| `useRuns` renvoie `refresh: () => fetchData()` | non signalé | cosmétique | Recréé à chaque rendu ; sans `React.memo` sur `ControlRibbon`, aucun coût mesurable. Un `useCallback` suffirait si un jour le ruban est mémoïsé. |
| Eventuels constats **apparus** par le refactor | ? | à mesurer | L'étape 10 (scan complet sans filtre) est là pour ça : un nouveau composant peut déclencher une règle qui ne tirait pas avant. |
