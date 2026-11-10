# Groupement des DAGs par tag principal + vue compacte

## Context

La vue Global Dag Gantt affiche une ligne par DAG avec jusqu'à 3 badges de tags + un badge
« Nx » (cf. `DagRow`). Avec ~30 DAGs qui orchestrent des étapes de raffinement de données
(collecte → normalisation → raffinement/croisement → export), la liste est longue (~44 px par
ligne, 2 lignes de label), les tags génériques (`collecte`, `ingestion`) sont répétés sur
toutes les lignes, et l'ordre (tri par run) ne reflète pas les étapes du pipeline.

Objectif validé avec l'utilisateur :
1. **Grouper par « tag principal »** — détection auto (tag le plus fréquent) + override par une
   liste d'étapes priorisées saisissable ; **groupé par défaut**, sections avec en-tête
   cliquable pour replier.
2. **Condenser** : lignes compactes (barre 14 px, label mono-ligne à 200 px, padding réduit) et
   badge du tag principal masqué dans un groupe (redondant avec l'en-tête).

Tout est front-end ; l'API renvoie déjà les tags par DAG.

## Approach

Une seule règle de calcul du tag principal (`primaryTag`), un seul composant de section, et des
constantes de densité ajustées — le mode « liste plate » actuel reste accessible.

### 1. Tag principal d'un DAG

Nouveau contrôle dans la toolbar : un `Input` « Étapes (tags, ordre de priorité) » — liste
séparée par des virgules, ex. `collecte, normalisation, raffinement, export`.

- **Override (liste non vide)** : tag principal = premier tag de la liste présent dans
  `dag.tags` (comparaison insensible à la casse et aux espaces). DAG sans aucun tag de la liste
  → groupe `« autre »` (placé en dernier).
- **Auto (liste vide, défaut)** : classer les tags par fréquence décroissante sur les DAGs
  affichés (égalité → alphabétique, déterministe) ; tag principal = le tag le mieux classé du
  DAG. Caveat accepté : si `collecte` et `ingestion` sont sur presque tous les DAGs, presque
  tout tombe dans le même groupe — c'est justement ce que signale l'override.

### 2. Rendu en sections

- Nouveau `useMemo groups` : partage `rows` par tag principal ; ordre des groupes = ordre de la
  liste d'étapes, puis fréquence décroissante, puis `« autre »` en dernier. Le tri choisi
  (`SORT_OPTIONS`) s'applique **à l'intérieur** de chaque groupe.
- `GroupHeader` : bande `bg="bg.subtle"` avec ▶/▼, badge du tag, `N DAGs · M runs` et pastille
  rouge `F failed` si F > 0 ; clic = replier/déplier. Bouton « tout replier / tout déplier » à
  droite de la toolbar (visible en mode groupé).
- État plié : `Set` dans un `useState`, persisté dans l'URL (clé `collapsed`, tags séparés par
  `,`). Groupe plié = en-tête seul.

### 3. Mode groupé par défaut, sortie vers la liste plate

- `grouped` booléen, défaut `true` ; URL clé `group=0` pour la liste plate (comportement
  actuel, badges complets).
- `URL_KEYS` devient `['date','q','tag','state','sort','zoom','group','stages','collapsed']` ;
  `stages` n'est écrit que si non vide, `group` que si `0`, `collapsed` que si non vide —
  URL propre par défaut, partageable sinon.

### 4. Condensation des lignes (toujours active, groupé ou plat)

- Constantes : `LABEL_WIDTH 240→200`, `BAR_HEIGHT 18→14`, `BAR_GAP 4→3` ; `DagRow` : `py={1}→0`
  + `px` conservé, hauteur de bloc `lanes*17 + 2`. Ligne de label mono-ligne : nom du DAG +
  badges + compteur « Nx » sur la même ligne (`alignItems="center"`), `fontSize 12px`.
- Badges par ligne : max **2 tags secondaires** (les tags non-principal, ex. `satin`, `meteo` —
  utile pour discriminer dans un groupe) ; en mode groupé le tag principal est retiré (déjà
  dans l'en-tête), en mode plat il est conservé (1 badge principal + 1 secondaire). Liste
  complète des tags dans le `title` existant de la ligne.
- `fontSize` des barres `11px→10px`, `lineHeight` suit `BAR_HEIGHT` (déjà dérivé).
- Échelle de temps : hauteur `22px→20px` pour rester alignée.

## Files to modify

- `js/src/DagGanttWidget.jsx` — tout : constantes de densité, `primaryTag`/`tagRank`,
  `groups` useMemo, `GroupHeader`, refactor `DagRow` (badges + hauteur), toolbar (Input
  étapes + bouton replier/déplier), `URL_KEYS`.
- `src/airflow_dag_gantt/__init__.py` — bump version mineure (`0.5.0`) comme pour les plans
  précédents.
- `README.md` — 2-3 lignes sur le groupement + paramètres d'URL (`group`, `stages`,
  `collapsed`) dans la section existante sur le partage d'URL.

Pas de changement API : `/api/runs` renvoie déjà `tags` triés par DAG (`api.py`).

## Reuse

- `SORT_OPTIONS` + `comparators` (`DagGanttWidget.jsx` ~l.265/450) : réutilisés tels quels pour
  l'ordre intra-groupe.
- `useUrlSync` / `URL_KEYS` (~l.270-320) : persistance `stages`/`group`/`collapsed` sans nouveau
  mécanisme.
- `STATE_COLORS` / `rows` existants : le compteur `failed` des en-têtes se calcule sur
  `row.runs` déjà groupés par dag_id.
- Structure `Flex` label + zone relative de `DagRow` : conservée, seuls padding/badges changent.

## Steps

- [x] Constantes de densité (`LABEL_WIDTH`, `BAR_HEIGHT`, `BAR_GAP`) + `DagRow` mono-ligne avec
      badges conditionnels (principal masqué si groupé, max 2 secondaires).
- [x] Helper `normalizeTag` + `computeTagRank(rows, stages)` + `primaryTagOf(row)` (pur, en-dehors
      du composant pour rester testable).
- [x] `useMemo groups` (partage + ordre) et composant `GroupHeader` ; état `collapsed: Set` +
      bouton tout replier/déplier.
- [x] Toolbar : Input « étapes » (débounce inutile, filtrage déjà instantané) ; passage de
      `grouped` dans le rendu (sections vs `rows.map` actuel).
- [x] `URL_KEYS` : ajout `group`, `stages`, `collapsed` (+ hydratation au montage via
      `initialQuery`).
- [x] `git commit` local (pas de push) + bump `0.5.0` + README.

## Verification

1. `cd js && npx webpack --mode production` (ou `./build.sh`) — build sans erreur.
2. `./dev.sh`, recharger `/dag-gantt` dans l'UI Airflow (screenshot de référence : journée
   2026-11-10, ~30 DAGs) :
   - défaut : groupes formés (ex. `collecte`/`ingestion` dominants), en-têtes corrects
     (nb DAGs, runs, failed), clic sur un en-tête = repli, hauteur de ligne visiblement réduite ;
   - taper `collecte, normalisation, export` → regroupement immédiat selon cet ordre, DAGs hors
     liste dans « autre » ;
   - `?group=0` rouvre la liste plate ; copier l'URL groupée + filtrée et la rouvrir dans un
     onglet privé → même vue ;
   - regressions : filtres nom/tag/état, zoom auto vs journée, boutons ⬅️/➡️, liens run → grid,
     tooltip barre avec la liste complète des tags, barres running qui s'étirent (tick 5 s).
3. `pytest tests/` (packaging) + `ruff check` inchangés.
