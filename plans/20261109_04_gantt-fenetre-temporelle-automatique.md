# Fenêtre temporelle automatique du Gantt (zoom sur les runs filtrés) + petits ajouts UI

## Context

La ligne de temps couvre toujours 24 h : `windowStart`/`windowSpan` sont figés sur la
journée dans `js/src/DagGanttWidget.jsx` (memo « Fenetre = journee locale »), les ticks
sont fixes (1 grad / heure, label / 2 h) et les barres sont projetées en `%` de 24 h.
Or la plupart des DAGs tournent sur quelques heures : barres minuscules, illisibles.

**Objectif** : la largeur affichée s'adapte aux runs **filtrés** (nom, tag, état) —
fenêtre = `[1er run, dernier run]` avec une **largeur minimale de 3 h**, recalculée
instantanément quand les filtres changent (aucun nouvel appel API, tout est déjà
client-side). Plus quelques petits ajouts UI validés.

## Décisions actées

- Toggle **« Zoom auto ⟷ Journée complète »**, auto par défaut ; la vue 24 h reste accessible.
- Bornes **arrondies sur des graduations propres** (palier choisi selon le span) + ~5 % de marge.
- Pas de zoom manuel (glisser-sélectionner) — garder simple.
- Ajouts inclus : ticks adaptatifs, label durée dans les barres, tri des lignes
  paramétrable, filtre état **multi-sélection** via la légende cliquable, état des
  filtres synchronisé dans l'URL.

## Approche

### 1. Fenêtre auto-zoom (le cœur)

Nouveau `useMemo timeWindow(filtered, zoomAuto, now, date)` qui remplace le memo figé :

- `t0 = min(Date.parse(r.start))` des runs visibles ; `t1 = max(Date.parse(r.end ?? now))`
  (les runs running/queued étirent déjà jusqu'à `now` — même règle ici).
- marge ~5 % du span de chaque côté ; si `t1 - t0 < MIN_SPAN = 3 h` : élargir
  symétriquement autour du milieu, puis **clamped dans la journée** `[00:00, 24:00)`
  (si collision d'un bord, glisser la fenêtre de 3 h de l'autre côté).
- arrondir `t0` vers le bas / `t1` vers le haut sur le **palier de graduation** retenu
  (voir §2) → les graduations tombent sur des heures/minutes rondes.
- cas particuliers : 0 run filtré ou tous les runs sans `start` → retomber sur la journée ;
  un run isolé très court → fenêtre 3 h centrée sur lui.
- le toggle (`zoomAuto`, state) bascule entre cette fenêtre et `[00:00, 24:00)`.
- dans la toolbar, afficher la plage courante : `07:15 → 11:45 · 4h30` (via `fmtTime`/`fmtDuration`).
- `windowStart`/`windowSpan` calculés sont passés tels quels à `DagRow`/`GanttBar`/
  ticks/ligne « maintenant » : la projection en `%` avec clampLeft/right existe déjà,
  les barres qui commencent avant la fenêtre restent collées au bord gauche.

### 2. Graduations adaptatives

- `pickStep(spanMs)` : le plus petit palier de `[5, 10, 15, 30, 60, 120, 240]` min tel que
  `span / step ≤ 12` graduations. En vue 24 h ça donne 2 h (≈ ce qu'on a aujourd'hui).
- label : `HH:mm` si palier < 60 min, sinon `HHh` comme actuellement (`String(h % 24)`).
- la ligne « maintenant » garde sa logique (affichée seulement si `now` est dans la fenêtre).

### 3. Label durée dans les barres

- un `ResizeObserver` (guard : fallback seuil en % s'il manque) sur le conteneur du grid
  donne `chartWidth` en px, transmis aux `GanttBar`.
- si `width% × chartWidth ≥ ~55 px`, afficher `fmtDuration(duration)` dans la barre à la
  place du contenu actuel (le ▶ running est conservé, ex. `▶ 12m 30s`).

### 4. Tri des lignes paramétrable

- un `Select` « Tri » dans la toolbar (réutilise le composant `Select` local) avec options :
  `1er run (défaut)` · `Dernier run` · `Nom DAG` · `Nb de runs` · `Durée max`.
- le memo `rows` calcule déjà `firstStart` ; y ajouter `lastEnd`, `count`, `maxDuration`
  et trier selon le critère choisi (ordre : `1er run`/`Dernier run`/`Durée max` décroissants,
  `Nom`/`Nb de runs`… au choix le plus lisible, nb de runs décroissant).

### 5. Filtre état multi-sélection (légende cliquable)

- supprimer le `Select` état unique ; la **légende en bas devient le filtre** :
  chaque pastille état est un bouton toggle ; sélection vide = tous les états.
  Aucun composant Chakra additionnel nécessaire (un `Box` cliquable suffit), donc pas de
  risque de compat version hôte.
- états passés en `Set` ; `filtered` teste `stateSet.size === 0 || stateSet.has(...)`.
- les états absents de la journée restent affichés en légende, grisés et non cliquables.

### 6. État des filtres dans l'URL

- sérialiser `date, q, tag, state` (CSV), `sort`, `zoom` dans la query string de la route
  du widget (`dag-gantt`), en **lecture au montage + `replaceState` à chaque changement**
  (pas d'historique spam).
- implémentation : `Router.useSearchParams` si présent dans `ReactRouterDOM` (external déjà
  configuré), sinon fallback `URLSearchParams(window.location.search)` +
  `window.history.replaceState` dans un `useEffect`.
- au chargement, l'URL hydrate les states (les valeurs par défaut ne sont pas écrites dans l'URL).

## Files to modify

- `js/src/DagGanttWidget.jsx` — seuls changements (fenêtre, ticks, barre, légende, toolbar, URL).
- Aucune modification API (`src/airflow_dag_gantt/api.py` inchangé : le filtrage est déjà client-side).

## Reuse

- Projection des barres : `GanttBar` (clamp `left/width` en %) — inchangée, bénéficie du zoom gratuitement.
- `fmtTime` / `fmtDuration` pour la plage affichée et les labels de barres.
- Composant `Select` local (avec fallback natif) pour le menu de tri.
- Memos `filtered` / `rows` existants : la fenêtre en dérive directement, sans nouveau fetch.
- Guard pattern `HasTooltip`/`HasNativeSelect` pour la détection `useSearchParams` / `ResizeObserver`.

## Steps

- [x] `MIN_SPAN_MS = 3h` + memo `timeWindow` (min/max, marge 5 %, min 3 h centré, clamp journée, arrondi palier).
- [x] Toggle zoom dans la toolbar + affichage de la plage courante ; `windowStart/windowSpan` propagés.
- [x] `pickStep` + `ticks` adaptatifs (format `HH:mm` / `HHh`).
- [x] `ResizeObserver` sur le grid → `chartWidth` ; label durée dans `GanttBar` si ≥ ~55 px.
- [x] State `sortKey` + Select de tri + extension du memo `rows`.
- [x] `stateFilter` → `Set` + légende cliquable ; suppression du Select état.
- [x] Hydratation/synchronisation URL (`date, q, tag, state, sort, zoom`) avec fallback sans Router.
- [x] `npm run build` (via `./build.sh`) et vérification du bundle copié.

## Verification

- [x] `./build.sh` puis `./dev.sh js` ; ouvrir la vue « Global Dag Gantt » dans l'UI Airflow.
- [x] Sans filtre sur une journée chargée : fenêtre ≈ min→max arrondie, jamais < 3 h ; toggle ↔ vue 24 h OK.
- [x] Filtrer par tag / état : l'échelle se resserre immédiatement, graduations rondes, ticks ≤ ~12.
- [x] Un run running : sa barre et la borne droite s'étirent toutes les 5 s (tick `now` existant).
- [x] DAG sans run en vue 24 h (heure de nuit) : barres avant/après fenêtre clampées aux bords, rien de cassé.
- [x] Légende : clic sur `failed` puis `queued` → les deux états combinés ; re-clic → tous.
- [x] Copier l'URL filtrée dans un nouvel onglet → mêmes filtres/tri/zoom restaurés.
- [x] `pytest tests/` inchangé (aucun changement API/packaging).

## Notes hors périmètre

- Décalage UTC (API) vs local (UI) de la journée : existe déjà, non traité ici.
- Zoom manuel par glisser-sélectionner : écarté volontairement, extensible plus tard sur
  `timeWindow` sans toucher au reste.
