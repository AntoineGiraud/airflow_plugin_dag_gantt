# 📋 Plan : Plugin Airflow 3.3 — Global DAG Gantt

> Révision du plan initial (Gemini) — réécriture après vérification directe dans l'image
> Astro Runtime `3.3-12` (Airflow **3.3.2+astro.3**) utilisée par `astro dev start`.

## Context

Le Gantt natif d'Airflow est limité à un seul DAG (ses TaskInstances). Besoin : une vue
macro **"Global Gantt"** affichant les `DagRun` d'une journée sur une ligne de temps unique,
pour repérer goulots d'étranglement et chevauchements entre DAGs, avec filtrage par
nom/tag.

Le repo sert de bac à sable : les 24 DAGs `day_1..day_24` de l'advent calendar de Tamara
(Fork `TJaniF/airflow-advent-calendar`). Le plugin advent (`plugins/advent_calendar_plugin.py`)
fonctionne déjà en local → on réutilise la même tuyauterie, déjà copiée dans
`plugins/dag_gantt_plugin.py` + `plugins/react-src-dag-gantt/` (copie brute, pas encore
adaptée : le widget JSX fait encore du calendar-status et fetch l'API advent).

Environnement local : projet Astro CLI, image `astrocrpublic.azurecr.io/runtime:3.3-12`,
UI sur `http://localhost:8080` (admin/admin). Build frontend avec **bun** (`bun install`,
`bun run build` — comme pour le plugin advent, `bun.lock` de référence).

**Décisions actées avec l'utilisateur :** Chakra de l'hôte (externals globals) ·
fenêtre = journée courante + date picker · peuplement local via DAGs de démo dédiés ·
API **publique** comme advent (pas de GetUserDep pour l'instant, durcissement ultérieur).

## Faits vérifiés dans le runtime (faisabilité) ✅

1. **`GetUserDep`** : importable depuis `airflow.api_fastapi.core_api.security`
   (c'est un module unique, **pas** `security.user` — corriger le plan Gemini).
2. **Montage FastAPI** : `app.mount(url_prefix, subapp)` dans
   `airflow/api_fastapi/app.py` — le plugin est monté **à la racine** à
   `/dag-gantt-plugin` (le fetch du frontend fonctionne sans préfixe `/plugins`).
   Préfixes réservés : `/api/v2`, `/ui`, `/execution`, `/auth`, `/pluginsv2`.
3. **Chargement du bundle React par l'UI** (dans le bundle UI minifié) :
   `import(bundle_url)` puis lookup `globalThis[react_app.name]` (fallback
   `globalThis.AirflowPlugin`). Le composant exporté doit être une **fonction**.
   ⚠️ Le nom global doit être **exactement** `"Dag Gantt"` (name du react_app).
4. **Bibliothèques exposées par l'UI Airflow 3.3 sur `globalThis`** :
   `React`, `ReactDOM`, `ReactJSXRuntime`, `ReactRouterDOM`, **`ChakraUI`**,
   `EmotionReact`. → On peut **externaliser** ces libs dans webpack et réutiliser
   Chakra UI + les tokens de thème natifs (`success.solid`, etc.) sans bundle de libs.
   En revanche **TanStack Query n'est PAS exposé** → fetch natif simple.
5. **Le composant Gantt natif n'est pas réutilisable directement** : il est interne au
   bundle UI minifié, non exposé. → **réimplémentation légère** inspirée de sa logique
   (échelle de temps, barres positionnées en %), pas un fork.
6. **Modèle `DagRun`** (3.3) : colonnes utiles `dag_id, run_id, state, start_date,
   end_date, run_after, logical_date, run_type, data_interval_start/end`. Tags via
   `DagModel.tags`. Session : `airflow.utils.session.create_session` ✅.
7. `react_apps` (schéma `ReactAppResponse` 3.3) : `name`, `bundle_url`,
   `destination` (`nav` par défaut, accepte aussi `dashboard`), `category`,
   `url_route`, `icon`, `nav_top_level`. La config actuelle du plugin copié est valide.
8. Pas de `node_modules` ni `dist` dans `plugins/react-src-dag-gantt/` → build à lancer
   (bun ou npm, comme pour advent).

## Approach

**Garder la chaîne webpack de Tamara** (prouvée fonctionnelle dans ce runtime) plutôt que
Vite (Étape 3 du plan Gemini) : config déjà copiée, seul le mapping `externals` change.

### Backend — `plugins/dag_gantt_plugin.py`

- Nettoyer la copie advent (supprimer calendar-status/img/links.json qui n'ont pas de sens ici).
- `GET /dag-gantt-plugin/api/runs?date=YYYY-MM-DD` :
  - **Pas d'auth** (décision : public comme advent). La route `GetUserDep` reste documentée
    dans ce plan (import vérifié `airflow.api_fastapi.core_api.security`) pour un
    durcissement futur avant déploiement partagé.
  - `create_session()` : requête `DagRun` joint `DagModel` (+ tags), filtre
    `start_date` (fallback `run_after`) ∈ [début, fin] de la journée demandée (UTC,
    paramètre `date`, défaut = aujourd'hui), `limit` défensif (ex. 2000 runs).
  - Réponse JSON par run : `{dag_id, run_id, state, start, end, tags, logical_date}`
    (ISO 8601 ; `end` = null si running).
  - Ajouter `external_import` : `logical_date` **ne suffit pas** — prévoir le renvoi des
    champs nécessaires au lien direct vers la page Grid du run (voir Risques).
- Garder la route qui sert `dag-gantt-widget.js` (FileResponse, no-cache).

### Frontend — `plugins/react-src-dag-gantt/src/DagGanttWidget.jsx`

Réécrire le widget (la copie actuelle est encore le calendrier advent) :

- **Externe les libs de l'hôte** (webpack `externals` mappé sur les globals vérifiés) :
  `react → React`, `react-dom → ReactDOM`, `react/jsx-runtime → ReactJSXRuntime`,
  `@chakra-ui/react → ChakraUI`, `react-router-dom → ReactRouterDOM`.
  → zéro lib bundle dans le JS, thème/branding D2B du `.env` automatiquement cohérent.
- **Fetch unique** au chargement vers `/dag-gantt-plugin/api/runs?date=…`, stockage en
  state ; filtres **client-side** via `useMemo` : texte (dag_id/run_id), multi-tag, état.
- **Rendu Gantt** :
  - Ligne = DAG (tri par 1ʳᵉ start) ; sous-lignes = runs si plusieurs dans la journée
    (ou toutes les lignes aplaties — décision UI à trancher, voir Questions).
  - Barre par run : `left% = (start - windowStart) / windowSpan`, idem width ;
    running → `end = Date.now()`, rafraîchir périodiquement (setInterval léger).
  - Couleurs via **tokens Chakra natifs** (`success.solid`, `failed.solid`, …) pour coller
    à l'UI ; tooltip (chakra `Tooltip`) au survol : run_id, start→end, durée, tags ;
    clic → navigation Grid du run via `ReactRouterDOM`.
  - Échelle de temps horizontale : graduations horaires auto selon zoom (24h → 1h/2h).
- **Barre de contrôle** : date picker (input `type="date"`, défaut aujourd'hui),
  input filtre nom, sélecteur tags, sélecteur états, bouton refresh.

### Bundler — `plugins/react-src-dag-gantt/webpack.config.js`

- Déjà correct (filename `dag-gantt-widget.js`, library window + `export default`).
- **Compléter `externals`** avec les globals vérifiés (cf. Frontend ci-dessus).
- Build : `cd plugins/react-src-dag-gantt && bun install && bun run build`
  (dist servi depuis `plugins/` monté par astro dev).

## Files to modify

| Fichier | Action |
|---|---|
| `plugins/dag_gantt_plugin.py` | Réécrire : API `/api/runs` (SQLAlchemy), servir le bundle, nettoyer les restes advent (API publique, décision « Décisions actées » ; GetUserDep documenté pour plus tard) |
| `plugins/react-src-dag-gantt/src/DagGanttWidget.jsx` | Réécrire intégralement (Gantt + filtres + Chakra global) |
| `plugins/react-src-dag-gantt/src/index.js` | OK tel quel (`globalThis['Dag Gantt']`) — vérifier égalité exacte avec `name` |
| `plugins/react-src-dag-gantt/webpack.config.js` | Étendre `externals` (ChakraUI, jsx-runtime, router, emotion) |
| `plugins/react-src-dag-gantt/src/DAGToggleWidget.jsx` | Supprimer (copie morte) |
| `dags/gantt_demo.py` | **Nouveau** : DAG de démo multi-runs + tags pour peupler le Gantt |

## Reuse

- `plugins/advent_calendar_plugin.py` → gabarit exact du `AirflowPlugin` (fastapi_apps +
  react_apps + FileResponse no-cache), déjà prouvé en production locale.
- `plugins/react-src-dag-gantt/webpack.config.js` (déjà copié) → chaîne babel/webpack.
- Globals UI (`globalThis.ChakraUI`, tokens `success.solid`…) → design system natif,
  palette d'états identique à l'UI Airflow.
- Modèle `DagRun`/`DagModel.tags` + `create_session` → pas de migration, pas d'API v2.

## Risques & points de vigilance

1. **API publique** (décision) : toute personne atteignant le host peut lire les méta-données
   des runs (dag_id, run_id, états, dates). Accepté en local ; avant tout déploiement
   partagé, brancher `Depends(GetUserDep)` (import vérifié) — la route JSON étant déjà
   séparée du bundle, ce ne sera qu'un one-liner à ré-évaluer (auth cookie same-origin à
   tester à ce moment-là).
2. **URL exacte de la page Grid d'un run** en 3.3 (`/projects/.../dags/{dag_id}/grid?...`) :
   à vérifier dans le routeur UI avant de câbler le clic sur les barres (option MVP :
   lien vers la page DAG). → **RÉSOLU** voir « Points confirmés » ci-dessous.
3. **Version Chakra** : en externalisant le global, il n'y a AUCUNE version à aligner
   (on consomme celui de l'hôte) — c'est l'avantage de l'approche externals.
4. **Perf** : une journée × N DAGs × M runs peut grossir → `limit` côté SQL +
   affichage groupé par DAG ; pas de polling lourd (refresh manuel + interval léger
   optionnel 30 s pour les runs running).
5. **Chargement plugin** : Airflow charge les plugins au démarrage des processus →
   après chaque modif Python, `astro dev restart` (ou redémarrer les containers
   api-server/dag-processor côté astro).
6. Le bundle est chargé en **ESM natif** (`import()`) : un bundle webpack IIFE qui écrit
   dans `globalThis` fonctionne (prouvé par advent), mais `library.type: 'window'` doit
   rester — ne pas passer en `module`.

## Points confirmés pendant l'implémentation

- **Route Grid d'un run (risque 2, résolu)** : le routeur UI 3.3 contient
  `path:'dags/:dagId'` avec un enfant `path:'dags/:dagId/runs/:runId'` → lien direct
  `/dags/{dag_id}/runs/{run_id}` (run_id encodé), câblé sur le clic des barres via le
  `Link` de l'hôte (ReactRouterDOM).
- **Palette d'états native (confirmée dans le bundle UI)** :
  `{failed: failed.solid, planned: stone.solid, queued: queued.solid,
  running: running.solid, success: success.solid}` → copiée telle quelle dans le widget.
- **Composants Chakra v3 utilisés avec garde-fous** : `NativeSelectRoot/NativeSelectField`
  et `TooltipRoot/TooltipTrigger/TooltipContent` sont consommés depuis le namespace hôte ;
  en l'absence de l'un d'eux, repli natif (`<select>`, attribut `title`).
- **Validation `date`** : le `Query(pattern=…)` de FastAPI rejette une date mal formée par
  un **422** (avant le HTTPException 400 du code) — comportement accepté.
- **Ports locaux** : `astro dev restart` annonce l'UI sur
  `http://airflow-advent-calendar.localhost:6563`, mais le mapping historique
  `localhost:8080` du conteneur api-server répond toujours — API testée accessible sur
  les deux.
- **Nouveaux DAGs = en pause par défaut** : le scheduler ne crée aucun run tant que les
  DAGs de démo sont pausés. De plus, le dag-processor a figé sa liste de fichiers au
  démarrage (`dag_discovery_safe_mode`) → `docker restart <conteneur-dag-processor>`
  pour découvrir un nouveau fichier, puis unpause. Piloter le local via **`astro dev run
  dags list / unpause / trigger`** (astuce utilisateur) plutôt que psql.

## Steps

- [x] 1. Backend : réécrire `dag_gantt_plugin.py` (route `/api/runs` avec `date`,
      SQL DagRun×DagModel×tags, limit ; suppression des routes advent résiduelles)
- [x] 2. Smoke test API : `astro dev restart` puis `curl localhost:8080/dag-gantt-plugin/api/runs?date=…`
      → ✅ renvoie le run `day_1` du jour ; 422 sur date invalide ; 404 sur bundle non buildé
- [x] 3. Webpack : compléter `externals` (React/ReactDOM/jsx-runtime/ChakraUI/EmotionReact/
      ReactRouterDOM) ; `bun install` + `bun run build` → ✅ bundle 5.9 KiB, zéro lib bundlée
- [x] 4. Widget : squelette (fetch + state + date picker) puis rendu barres + échelle
      → ✅ build 12.4 KiB sans aucune lib (externals globals vérifiés dans le bundle)
- [x] 5. Filtres client-side (nom, tags, états) via `useMemo`
      → ✅ sélecteurs tags/états + recherche nom, zéro rappel API
- [x] 6. Tooltip + clic barre → lien Grid/DAG
      → ✅ Tooltip hôte (garde-fous title) + `Link` ReactRouterDOM →
      `/dags/{dag_id}/runs/{run_id}`
- [x] 7. DAGs de démo `dags/gantt_demo*.py` (tags + catchup pour générer des runs variés)
      → ✅ 44 runs du jour en API : 32 success, 11 failed (quality_gate heures paires),
      1 running ; après restart dag-processor + `astro dev run dags unpause`
- [x] 8. Runs running : barre étirée jusqu'à `Date.now()` + refresh périodique
      → ✅ `gantt_demo_slow` déclenché : API renvoie `state=running, end=null` ;
      le widget étire la barre (tick 5 s) et re-fetch toutes les 30 s
- [x] 9. Nettoyage (DAGToggleWidget.jsx, images inutiles) + README de la section plugin
      → ✅ fichier mort supprimé, `img/` vide retiré, section « Global Dag Gantt » dans
      le README ; `.gitignore` existant couvre bien `node_modules` (vérifié)

> Étapes 4-6 & 8 : implémentées d'un bloc dans `DagGanttWidget.jsx` (même fichier) ;
> cochées au fil de la vérification build + navigateur.

## Verification

1. `astro dev start` → UI `http://localhost:8080`, Browse → **Dag Gantt** apparaît dans la nav.
2. `curl` de `/dag-gantt-plugin/api/runs` renvoie les runs du jour (après avoir déclenché
   des DAGs advent ou le DAG de démo).
3. Lancer `day_1` (etc.) manuellement → la barre apparaît, positionnée à l'heure du run ;
   pendant le run, barre "running" qui s'étire, puis repasse en couleur success.
4. Filtres : taper un tag → seules les lignes concernées restent ; filtre état failed.
5. Changer la date → vue vide ou runs d'un autre jour ; retour à aujourd'hui.
6. Cohérence visuelle : couleurs d'état identiques au Grid natif ; le thème brand
   orangé du `.env` s'applique aux composants Chakra du plugin (preuve que les
   externals `ChakraUI`/`EmotionReact` sont bien câblés).
7. Console navigateur propre : pas d'erreur de chargement du bundle ni de 404 API.

## Bilan d'exécution (2026-11-08)

Les 9 étapes sont faites. Vérifications serveur passées :
`/api/runs` → 200 avec 44 runs du jour (32 success / 11 failed / 1 running end=null) ;
bundle → 200 (12.4 KiB, seul `window.React/ChakraUI/ReactRouterDOM` référencés) ;
plugin advent toujours 200 (cohabitation OK) ; scheduler healthy.
Reste à valider **dans le navigateur** (étapes Verification 1, 3-7) :
`http://localhost:8080` → Browse → **Dag Gantt** (le run `gantt_demo_slow` dort ~3 min,
barre running visible si regardé tout de suite ; sinon `astro dev run dags trigger
gantt_demo_slow`). Travail 100 % local, non commité non poussé.
