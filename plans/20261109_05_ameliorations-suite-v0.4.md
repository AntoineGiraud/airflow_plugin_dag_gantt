# Améliorations v0.4 — diagnostic visible, tests JS, runs « prévus », confort d'usage

## Context

La v0.3.0 (auto-zoom, légende-filtre, tri, URL) est taguée. Deux incidents récents ont
révélé des manques précis : le bundle « neuf-et-vieux » (fonctions visibles, correctif
absent, console propre) n'était détectable qu'en grelottant le bundle servi ; et le bug
`MIN_SPAN = 3 jours` n'a été trouvé que par un script node ad-hoc. Ce round corrige ces
deux angles morts et ajoute le confort qui s'appuie sur l'existant.

**Sélection** (le reste en réserve, bas de plan) : D1, D2, B1, B2, C2+C3, A2.

## Approche

### D1. Version du bundle visible dans l'UI (diag du piège neuf-et-vieux)
- `webpack.config.js` : `DefinePlugin` avec `__BUILD_INFO__ = { version, hash, builtAt }`
  (`version` lu dans `js/package.json` — voir D-bump —, `hash` via `git rev-parse --short HEAD`
  si dispo, sinon `'dev'`).
- `DagGanttWidget.jsx` : petit `Badge` à côté du titre `📊 Global Dag Gantt` —
  `bundle 0.3.0+abc1234 · 12:34`, tooltip « recharger (Ctrl+Shift+R) après ./build.sh ».
- **Source de vérité du bump** : pour éviter la dérive pyproject ↔ js/package.json,
  `hatch_build.py` connaît déjà `js/` ; côté webpack, lire `pyproject.toml` (regex `^version`)
  est plus simple qu'un hook — **décision : webpack lit `pyproject.toml`**, `js/package.json`
  reste à sa version interne.

### D2. Fonctions pures extraites + tests `node --test` en CI
- Extraire de `DagGanttWidget.jsx` vers **`js/src/time.js`** : `DAY_MS`, `MIN_SPAN_MS`,
  `MARGIN_RATIO`, `TICK_STEPS_MIN`, `MAX_TICKS`, `pickStepMs`, `computeWindow`, `fmtClock`,
  `fmtDuration`, `fmtTime` (import nommés dans le widget).
- **`js/tests/time.test.js`** avec `node --test` (zéro dépendance) : les 16 cas du script
  ad-hoc du 20261109 (min 3 h, clamp bords de journée, running qui étire, span ≥ 24 h →
  journée, `pickStepMs` borné ≤ 12 graduations, non-régression du bug 3-jours).
- `js/package.json` : `"test": "node --test tests/"`.
- `.github/workflows/ci.yml` : dans le job bun existant (setup-bun déjà là, l. 80), ajouter
  `bun run test` après `bun install` du dossier `js/`.

### A2. Runs planned/queued : montrer le prévu, pas le logical_date
- `api.py` : sélectionner aussi `DagRun.run_after` et `DagRun.run_type` ; `start` ne retombe
  plus sur `logical_date` que si tout est nul ; ajout des champs `run_after`, `run_type`
  (nullables) dans le JSON — contrat documenté dans la docstring + test contrat.
- `DagGanttWidget.jsx` :
  - position d'une barre sans `start` = `run_after` (créneau prévu), dessinée en **hachures
    / opacité 0.45** (style « prévu ») ;
  - tooltip : « prévu à 06:00 · non démarré » au lieu de l'heure logique trompeuse ;
  - `run_type` ajouté en fin de tooltip (`scheduled` / `manual` / `backfill`).
- `tests/test_plugin_packaging.py` : `test_api_runs_contract` attend les 2 nouvelles clés.
- `dags/gantt_demo.py` : vérifier qu'il produit bien un planned/queued (sinon un run sans
  start_date avec run_after futur) pour tester visuellement.

### B1. Badge « N failed » par ligne de DAG, cliquable
- Dans le memo `rows` (existe) : ajouter `failed = runs.filter(r => r.state === 'failed').length`.
- Label de ligne : `Badge colorPalette="red" onClick` → pose `nameFilter = dagId`
  (l'input nom existe déjà ; passe par `setNewNameFilter` + URL sync existante) et
  `stateFilter = ['failed']`. Tooltip « filtrer sur ce DAG (failed) ».

### B2. Navigation jour ← / aujourd'hui / →
- Deux `Button` + bouton cible autour de l'`Input type=date` : helpers `shiftDay(date, ±1)`
  (format `YYYY-MM-DD`, arithmétique via `Date` local puis re-format — réutiliser le `pad`
  de `todayLocal`). `Shift+clic` = ±7 j. Le state `date` alimente déjà fetch + URL : rien d'autre.

### C2+C3. Rafraîchissement honnête
- State `lastFetched` (ms) posé dans `fetchData` au succès ; texte toolbar
  « ⟳ 30 s · données 18:42:05 » (via `fmtTime`).
- Toggle pause (`Button` ⏸/▶) : `paused` en state, `setInterval` existant lit une ref
  (`pausedRef`) pour ne pas recréer le timer.
- Mettre en pause automatique quand l'onglet est masqué : `document.visibilitychange` →
  refresh immédiat + rattrapage au retour visible (sinon les 30 s d'aveugle sont gaspillés).

## Files to modify

- `js/src/DagGanttWidget.jsx` — badge version, planned, failed-badge, nav jours, fraîcheur.
- **`js/src/time.js`** (nouveau) — fonctions pures extraites.
- **`js/tests/time.test.js`** (nouveau) — `node --test`.
- `js/package.json` (script test), `js/webpack.config.js` (DefinePlugin + lecture pyproject).
- `src/airflow_dag_gantt/api.py` (+ docstring contrat), `tests/test_plugin_packaging.py`,
  `dags/gantt_demo.py` (si pas de planned), `.github/workflows/ci.yml` (job bun : `bun run test`).

## Reuse

- `computeWindow`/`pickStepMs`/`fmt*` : extraits tels quels, aucune réécriture.
- Memos `filtered`/`rows`, `setSortKey`/URL sync, `Select`, `Badge`/`Button` Chakra : inchangés.
- Job CI bun existant (`.github/workflows/ci.yml` l. 80) — juste une ligne de plus.
- Script node ad-hoc du 20261109 → base directe des tests (`/tmp/test_window.js` si encore là,
  sinon les cas sont listés dans D2).

## Steps

- [ ] Extraire `js/src/time.js`, importer dans le widget, vérifier bundle identique en comportement.
- [ ] Écrire `js/tests/time.test.js` (16 cas) + script `npm test` + bouchon CI dans le job bun.
- [ ] `DefinePlugin` `__BUILD_INFO__` (version pyproject + git hash) + badge à côté du titre.
- [ ] API : `run_after` + `run_type` sélectionnés et exposés ; `start` = start_date sinon null.
- [ ] UI planned : position sur `run_after`, style atténué, tooltip « prévu à », `run_type` au tooltip.
- [ ] Contrat API : docstring + `test_api_runs_contract` mis à jour ; démo avec un planned.
- [ ] Badge failed par ligne + clic = filtre `q` + `state=failed`.
- [ ] Nav jour ←/aujourd'hui/→ (+ Shift = semaine).
- [ ] `lastFetched` + toggle pause + pause en onglet masqué (`visibilitychange`).
- [ ] `./build.sh` (wheel 0.4.0 si bump validé — bump pyproject+`__version__`+README comme pour 0.3.0).

## Verification

- [ ] `cd js && bun run test` → tous verts (dont le cas anti-3-jours).
- [ ] `uv run --extra dev python -m pytest -q` → contrat API vert avec les nouvelles clés.
- [ ] `./build.sh` puis navigateur : badge version visible et identique au hash du commit ;
  `./dev.sh js` → le badge change après rebuild (prouve le diag D1).
- [ ] Un run planned de la démo : barre hachurée sur son run_after, tooltip « prévu à … ».
- [ ] Clic badge failed → ligne isolée + URL `?q=…&state=failed` ; ←/→ changent date + URL.
- [ ] Onglet masqué 2 min → aucun appel API pendant ce temps (logs `./dev.sh logs`), refresh
  au retour ; bouton pause coupe le refresh visible.

## Réserve (non retenu ce round)

- **A1. Journée UTC vs locale** — vrai défaut de justesse (1–2 h de runs du soir exclus),
  mais touche le contrat d'API, les tests et le sens de la « journée » : chantier séparé.
- B3 frise de densité · B4 fantômes de la veille · C1 virtualisation · E1 export CSV ·
  E2 export PNG (rejeté : thème hôte).
