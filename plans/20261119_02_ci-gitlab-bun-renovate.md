# 📋 Plan : chaîne de build JS (bun) dans la CI GitLab, audit des dépendances JS, Renovate

> Statut : **exécuté le 20261119** (§4 à §5 faits, validés au poste — voir §8 pour les écarts
> mesurés et ce qui reste ouvert). Rien de committé ni poussé : arbre de travail modifié, c'est
> Antoine qui stage, commit et pousse. Dérive de
> `plans/20261119_01_paquet-pip-artifactory-gitlab-ci.md`
> (dont il prend en charge les points durs 2 et 4 et la question 3). Les 4 arbitrages ont été
> tranchés par Antoine le 20261119 (voir §3). Dépôt local, remote `d2b`
> = `data-platform-b2b/core/airflow-plugin-dag-gantt`.

## 1. État des lieux (vérifié, pas supposé)

| Sujet | État |
| --- | --- |
| Dossier de travail | `/home/dgwp7942/Documents/codes_ingestion/02_core/airflow-dag-gantt` (déplacement fait, `codes_antoine/dag-gantt` vidé) |
| Git | HEAD sur `main` (remis en place, il était détaché sur `d2b/main`) ; `main` == `d2b/main` == `origin/main` == `f54313b` ; **deux** remotes : `origin` (GitHub perso) et `d2b` (interne) |
| Déjà non suivis | `.gitlab-ci.yml`, `.pre-commit-ci.yaml`, `plans/2026110{9_05,9_06,19_01}` |
| CI | copiée de `40_utils/s3-ojs` telle quelle ; **la CI GitHub `.github/workflows/ci.yml` est encore là et sera supprimée (§4.5)** |
| `pyproject.toml` | **en cours, et cassé** : `version = "0.7.3"` **et** `dynamic = ["version"]` → `uv lock` / `uv build` échouent (`ValueError: Metadata field 'version' cannot be both statically defined and listed in field 'project.dynamic'`). Manque `[tool.hatch.version] source = "vcs"` + `hatch-vcs` dans `build-system.requires`, ou retirer `dynamic`. |
| `uv.lock` | **absent** → `py-pytest` (template python) fait `uv sync --frozen`, qui échoue sans lock |
| Verrou JS | `js/bun.lock` versionné ✔ (bun 1.4.4 au poste) |

## 2. Les preuves trouvées sur l'instance (à ne pas re-vérifier)

- **`to-be-continuous/node@5.4.2` est mirroré en interne et connaît déjà bun** : input `manager`
  accepte `bun`, install par `npm install -g "bun@${NODE_MANAGER_VERSION:-$TBC_DEFAULT_NODE_BUN_VERSION}"`,
  `bun install --frozen-lockfile`, cache `BUN_INSTALL_CACHE_DIR=$CI_PROJECT_DIR/$NODE_PROJECT_DIR/.bun`.
- ⚠️ **`manager-version` doit être épinglé** : `TBC_DEFAULT_NODE_BUN_VERSION` est `''` en interne,
  donc `npm install -g bun@` (vide) → job rouge.
- **`node-build` est au stage `build`, comme `py-package`** (les deux templates déclarent la même
  liste de stages) : sans `needs`, la wheel se construit en parallèle du bundle et `hatch_build.py`
  lève `JS dist not found`. L'artéfact de `node-build` contient déjà `$NODE_PROJECT_DIR/$NODE_BUILD_DIR`
  = `js/dist` ✔.
- Défauts du template node **incompatibles avec bun**, à désactiver explicitement :
  `outdated-args: --long` (`bun outdated --long` → `error: bun outdated has no --long flag`, exit 1
  **mesuré** avec bun 1.4.4) et `test-args: run test -- --coverage` (le `--coverage` atterrit sur la
  dernière commande de notre chaîne `bun ./test/*.test.mjs`).
- `node-sbom` fait `npx @cyclonedx/cyclonedx-npm` : il lui faut un `package-lock.json`, que nous
  n'avons pas (que `bun.lock`) → à désactiver.
- **`py-trivy` ne couvre pas le JS** : le job du template python ne scanne que `./reports/`,
  c'est-à-dire les lock/`requirements` **copiés** dedans (`cp poetry.lock Pipfile.lock uv.lock ./reports`).
  D'où le besoin d'un équivalent JS.
- **Équivalent retenu : `node-audit`** (`bun audit`). Mesuré au poste avec bun 1.4.4 : le flag
  `--audit-level` (défaut du template) **existe**, `bun audit --audit-level=low` →
  « No vulnerabilities found (checked 241 packages) », exit 0.
- ⚠️ **`PYTHON_PACKAGE_MANAGER` n'est PAS une variable du template python@9.4** (constitué dans
  `s3-ojs`, hérité d'une doc antérieure) : seule `build-system` / `PYTHON_BUILD_SYSTEM` agit. Sans
  déclaration explicite, l'auto-détection voit `requirements.txt` (celui du Dockerfile Astro,
  volontairement commentaire-only) et choisit **`reqfile`** → rien n'installe le paquet → `py-pytest`
  ne trouve plus `airflow_dag_gantt`. Il faut donc `inputs: build-system: uv`.
- **Le hook hatch se déclenche aussi en installation éditable** : `uv sync` installe le projet en
  édictable, dans une image `python:3.14` **sans bun** → le `RuntimeError` actuel ferait rougir
  chaque job qui appelle `install_requirements` (`py-pytest`, `py-ty`, `py-bandit`, `py-trivy`…).
- **La publie va par défaut au registre de paquets PyPI *du projet GitLab***
  (`${CI_SERVER_URL}/api/v4/projects/${CI_PROJECT_ID}/packages/pypi`, user `gitlab-ci-token`,
  mot de passe `$CI_JOB_TOKEN`) : `s3-ojs` ne définit **aucune** variable de projet et publie bien
  (releases `1.11.0`→`1.13.0` créées entre le 17 et le 19/11). Réponse à la question « il y a des
  URLs propres à Orange dans le `.gitlab-ci.yml` ? » : **non**, il n'y a que `$CI_SERVER_FQDN/...`
  pour les composants et le variant DTSI de Dependency-Track. Une URL Artifactory n'apparaît que si
  on **choisit** Artifactory comme cible (§6, décision reportée).
- Renovate : `orange-cosa/recommandations/renovate-config` existe sur l'instance (lecture refusée
  pour mon compte) et `to-be-continuous/renovate@1.14.1` est mirroré ; les repos D2B
  (`airflow-docker-image`, `dbt-d2b-package`) se contentent d'un `renovate.json` commité.

## 3. Arbitrages déjà tranchés (20261119)

| Question | Choix |
| --- | --- |
| Produire `js/dist` en CI | composant `to-be-continuous/node@5.4.2` avec `manager: bun` |
| « trivy JS » | `node-audit` (activate `bun audit`), pas de job trivy maison |
| Renovate | `renovate.json` commité dans le dépôt (bot central), pas de composant TBC renovate |
| CI GitHub | `rm -r .github`, on assume le dépôt interne comme source de vérité ; le report des features GitHub se fera plus tard |
| Version du paquet | **hatch-vcs**, le modèle `s3-ojs` : la version vient du tag, plus de champ statique |
| Format des tags | **sans `v`**, comme `s3-ojs` (`0.7.4`) ; les `v0.7.x` historique restent dans l'historique et hatch-vcs les lit |

> ⚠️ Trois fichiers portaient déjà un **brouillon** écrit avant que le mode plan soit remarqué :
> `.gitlab-ci.yml` (nouveau), `hatch_build.py` (tolérance `editable`) et `pyproject.toml`
> (urls GitLab + `[dependency-groups]`). Repris tels quels, **sauf** le critère `editable` du hook
> (§4.2) et le renforcement de `wheel-contract` (§4.1) — rien n'a été jeté, rien n'est poussé.

## 4. La chaîne de build, tâche par tâche

### 4.1 `.gitlab-ci.yml` (brouillon déjà écrit)

- [x] `include` node@5.4.2 : `manager: bun`, `manager-version: "1.4.4"`, `project-dir: js`,
      `build-dir: dist`, `build-args: run build`, `test-args: run test`,
      `outdated-disabled: true`, `sbom-disabled: true`, `lint-enabled: false`, `typecheck-enabled: false`.
- [x] `include` python@9.4 : ajout de **`build-system: uv`** (+ conservation de `pytest-enabled`,
      `ty-enabled` et du `build-system` qui remplace le faux `PYTHON_PACKAGE_MANAGER` — à retirer des
      `variables:`).
- [x] `py-package: needs: [node-build (artefacts)]` + `variables: DAG_GANTT_JS_DIR: js/dist`.
- [x] Job `wheel-contract` (stage `test`, `needs: py-package`) : ouvre la wheel et vérifie que
      `*/static/dag-gantt-widget.js`, la `LICENSE` embarquée et le tag `py3-none-any` y sont — c'est
      le seul contrôle que le bundle est **physiquement** dans l'artefact publié. **Renforcé** : le
      stub d'editable porte le même nom de fichier, donc le job contrôle aussi la taille (> 1024 o)
      et la présence de `globalThis` — sinon un wheel bourré du stub passerait.
- [x] Passé par `glab ci lint -R data-platform-b2b/core/airflow-plugin-dag-gantt` → ✓ valide.
      Le lint **ne résout pas** les composants : les noms d'inputs ont donc été vérifiés à la
      source (`glab api .../templates/gitlab-ci-node.yml/raw?ref=5.4.2` et `gitlab-ci-python.yml?ref=9.4`).
- [x] Ajouté `variables: GIT_DEPTH: "0"` (soupape §6.5 relevée d'emblée : hatch-vcs et
      semantic-release ont besoin des tags et de l'historique ; le `.git` fait ~14 Mo).

### 4.2 `hatch_build.py` (fait, **avec une correction mesurée**)

Le hook distingue les cibles : `sdist` inchangé, **`editable`** (cas `uv sync`) → pose un
`static/dag-gantt-widget.js` **stub** qui écrit une `console.error` « bundle absent — lancer
./build.sh » au lieu d'échouer, `wheel` → exige toujours `DAG_GANTT_JS_DIR` et copie `js/dist`.
Un stub dans l'UI de dev vaut mieux qu'une CI rouge sur dix jobs ; la wheel, elle, ne ment jamais.

⚠️ Le brouillon testait `self.target_name == "editable"` : **faux**, l'editable PEP 660 passe par
le builder wheel (`build_editable` → `build(versions=["editable"])`), donc `target_name` vaut
`"wheel"` et le hook levait toujours `RuntimeError`. Le discriminateur est l'argument `version`.
Corrigé et **revérifié à l'exécution** (`uv pip install -e . --no-deps` dans un venv sans bun →
stub de 175 o posé, import OK).

### 4.3 Version : hatch-vcs (décidé), voilà les conséquences à écrire

- [x] `pyproject.toml` : retirer `version = "0.7.3"` (garder `dynamic = ["version"]`), passer
      `requires = ["hatchling>=1.26", "hatch-vcs>=0.4"]`, ajouter `[tool.hatch.version] source = "vcs"`.
      C'est ça qui débloque `uv lock` (§1). **Mesuré** : `./build.sh` sort
      `airflow_dag_gantt-0.7.4.dev0+gf54313bd2.d20261119-py3-none-any.whl` (dirty → segment date).
- [x] `src/airflow_dag_gantt/__init__.py` : `__version__` ne se **déclare** plus, elle se **lit**
      (`importlib.metadata.version("airflow-dag-gantt")`, `PackageNotFoundError` → `0.0.0+unknown`
      pour un checkout nu). Sans ça, le `__version__ = "0.7.3"` actuel devient faux dès le tag
      suivant — et le module doit rester **sans import d'airflow** (test dédié), `importlib` est
      stdlib.
- [x] `tests/test_plugin_packaging.py` : `test_version_is_consistent_between_pyproject_and_package`
      lit `["project"]["version"]`, qui n'existe plus → remplacée par **deux** invariants
      (`test_pyproject_declares_no_static_version`, `test_version_matches_the_installed_distribution`).
- [x] Documenté le changement de comportement : `pip install -e .` **réussit** désormais sans
      `DAG_GANTT_JS_DIR` (§4.2) → docstring de `tests/test_plugin_packaging.py` réécrit, et
      `test_bundle_is_shipped_inside_the_package` se **skip** sur un stub (sinon `py-pytest` serait
      rouge de dix jobs : `uv sync` écrit le stub dans `src/.../static/`).
- [x] `git describe --tags` sur HEAD donne `v0.7.3` → première wheel en version `0.7.3`, puis
      `0.7.4` **sans `v`** à la première release automatique. Un commit hors tag donne
      `0.7.4.devN+g<sha>` (version locale PEP 440) : c'est voulu, la CI ne publie que sur tag.
      **Vérifié côté template** : le composant `gitlab-ci-semrel@4.0.1` a un input `tag-format`
      par défaut `$${version}` → **pas de `.releaserc` à écrire** pour des tags sans `v`.

### 4.4 Dépendances Python verrouillées

- [x] `uv lock` puis **committer `uv.lock`** (exigé par `uv sync --frozen` de `py-pytest`).
      Fait : 140 paquets résolus, `requires-python = ">=3.13"`, `uv.lock` en cours de staging chez
      l'utilisateur. Le paquet racine (editable) n'y porte **pas** de version → aucun bruit de lock
      à chaque tag.
- [x] `[dependency-groups] dev` (déjà écrit : `pytest`, `ruff`, `httpx`) — remplace
      `[project.optional-dependencies] dev`, que `uv sync` n'installe pas.
- [x] **Décision §4.4 tranchée le 20261119** : on **garde** `requires-python = ">=3.13"` et
      `apache-airflow>=3.2`. Alignement écrit partout : `README.md` (§1 « 3.13 → 3.14 », arborescence,
      §5), `tests/test_plugin_packaging.py` (garde-fou `sys.version_info >= (3, 13)`).

### 4.5 Sortie de la CI GitHub (fait)

- [x] `rm -rf .github` (le workflow `ci.yml` était la seule chose que contenait `.github/`).
- [x] Références restantes retirées : `README.md` (arborescence → `.gitlab-ci.yml` +
      `renovate.json` ; §3.5 et §5 — les claims « job `lint` de la CI », « job `react-doctor` », « la
      version du hook et de la CI », « le job CI lance la même commande » étaient **faux** avec la CI
      GitLab et sont réécrits), `.pre-commit-config.yaml:8` (la **loi** se lit maintenant contre
      `.gitlab-ci.yml`), et `Dockerfile:13` (la CI publie désormais la wheel, mais l'image reste en
      mode local : la phrase est remise à l'heure).
- [x] Ce qui n'est **pas** reporté, assumé et tracé en `TODO:` dans le `.gitlab-ci.yml` :
      la matrice de résolution `uv pip compile` (3.13/3.14 maintenant) et l'`airflow db migrate` qui
      débloque `test_api_runs_contract` (sans métadatabase, ce test se **SKIP** en silence —
      mesuré : `9 passed, 1 skipped`).
- [x] Ajouté à `.gitignore` : `js/.bun/`, `js/.npm/`, `js/.yarn/`, `js/reports/`, `reports/`
      (caches et rapports que les templates node/python écrivent dans le clone).

### 4.6 Renovate (fait — `renovate.json` écrit, décisions §3 appliquées)

- [x] `extends: ["config:recommended", ":enablePreCommit"]`, `minimumReleaseAge: "7 days"`,
      `lockFileMaintenance` le lundi avant 6 h, `rangeStrategy: bump` sur `uv`, `registryUrls` pypi
      → `https://repos.tech.orange/artifactory/api/pypi/pythonproxy/simple/`.
- [x] Côté JS : managers `bun`/`npm` **sans `registryUrls`** (décision 20261119 — aucun proxy npm
      interne trouvé ; le commentaire du fichier dit que c'est là qu'il faudra la ligne si aucune
      MR JS n'apparaît). Renovate exclut `package.json` du manager `npm` tant qu'il n'y a pas de
      `package-lock.json`, donc `bun` reprend le fichier.
- [x] Côté CI, **vérifié dans le source de Renovate** : c'est le manager **`gitlabci`** (pas
      `gitlabci-include`, qui n'accepte que la forme objet `{project, ref}`) qui extrait les
      `include: component:`. Son regex prend le **premier segment** comme hôte et construit
      `https://<segment>` : avec `$CI_SERVER_FQDN/...` il chercherait les tags sur un hote nommé
      littéralement `$CI_SERVER_FQDN`. D'où `registryAliases: {"$CI_SERVER_FQDN":
      "gitlab.tech.orange"}` — valeur **hôte nu**, sinon le host casse en `https:`.
- [x] Manager `pre-commit` : **désactivé par défaut** chez Renovate → `:enablePreCommit` +
      `pre-commit.managerFilePatterns` étendu à `.pre-commit-ci.yaml` (le fichier qui porte les
      `rev:` qui comptent ; `.pre-commit-config.yaml` n'est que `repo: local`, donc rien à y
      remonter — les versions d'un `entry:` restent à la main, c'est écrit dans le fichier et dans
      l'en-tête des hooks).
- [x] `automerge: false` : le bot ouvre des MR, il n'en fusionne aucune (décision 20261119).
- [x] Piège évité : `check-json` (`.pre-commit-ci.yaml`) fait un `json.load` strict et aurait
      rougi sur `renovate.json` (JSON5 commenté) → exclusions `.devcontainer/...` + `renovate.json`.

## 5. Fichiers touchés / à toucher

| Fichier | Action | État |
| --- | --- | --- |
| `.gitlab-ci.yml` | nouveau (node+bun, `build-system: uv`, `needs`, `wheel-contract`, `GIT_DEPTH: 0`) | ✅ écrit, lint ✓ |
| `hatch_build.py` | tolérance `editable` (stub, critère `version`) | ✅ écrit, mesuré |
| `pyproject.toml` | urls GitLab, `[dependency-groups]`, hatch-vcs (conflit de version levé) | ✅ |
| `uv.lock` | généré (140 paquets) — à committer | ✅ généré |
| `renovate.json` | nouveau (JSON5, bot central, `registryAliases`, no-automerge) | ✅ écrit, JSON validé |
| `.gitignore` | `js/.bun/`, `js/.npm/`, `js/.yarn/`, `reports/`, `js/reports/` | ✅ |
| `src/airflow_dag_gantt/__init__.py` | `__version__` lue dans les métadonnées | ✅ |
| `tests/test_plugin_packaging.py` | 2 invariants de version, docstring « editable », skip sur stub, plancher 3.13 | ✅ |
| `.github/` | supprimé | ✅ |
| `README.md` | arborescence, §1 versions, §3.5 claims CI, §5 Limites | ✅ |
| `.pre-commit-config.yaml` | en-tête : la référence de loi devient `.gitlab-ci.yml` | ✅ |
| `.pre-commit-ci.yaml` | `check-json` exclus : `renovate.json` (JSON5) | ✅ |
| `Dockerfile` | commentaire « publier l'artefact » remis à l'heure | ✅ |

## 6. Inconnues qui ne se lèvent qu'au premier pipeline

1. **Le registre npm depuis les runners** : `bun install --frozen-lockfile` et l'installation de bun
   par npm supposent un registre joignable. Aucun dépôt local ne cite de proxy npm interne → si
   `node-build` échoue côté réseau, l'input `config-registry` du template est la soupape (et
   `image: node:lts-alpine` + `manager-version` restent valables).
2. **`node-audit`** dépend du point 1 (l'endpoint d'avis du registre) ; soupape : `audit-disabled`.
3. **`node-semgrep`** télécharge ses règles depuis `semgrep.dev` — le pendant `py-semgrep` tourne
   chez `s3-ojs`, donc a priori bon.
4. **`py-publish` vers le registre PyPI du projet** : suppose que le registre de paquets est activé
   sur le projet. Si la cible doit être l'Artifactory DTSI (nom du paquet, `pypi-local` dédié,
   credentials via vault `@url@`), c'est le §3.1 du plan `20261119_01` (le nom
   `airflow-dag-gantt` **est déjà pris** sur PyPI public et servi par `pythonproxy`) → décision à
   reprendre avant d'ouvrir le canal.
5. **hatch-vcs a besoin des tags dans le clone du runner** : un `GIT_DEPTH` peu profond peut
   donner « unable to detect version » à `py-package`. **Levé** : `variables: GIT_DEPTH: "0"` est
   posé dans le `.gitlab-ci.yml` (clone complet, ~14 Mo de `.git`).
6. Les règles adaptatives TBC : hors MR, les jobs de test passent `manual` + `allow_failure` — le
   premier pipeline sur `main` sera donc vert sans être probant. Judgez sur un MR.

## 7. Validation — ce qui a été exécuté au poste (20261119)

| Étape | Résultat |
| --- | --- |
| `bun run --cwd js test` | ✅ 4 suites vertes (aggregation 40, time, grouping, view) |
| `bun run --cwd js test:dom` | ❌ **échoue déjà à HEAD** — voir §8.1 (hors plan) |
| `./build.sh` | ✅ `airflow_dag_gantt-0.7.4.dev0+gf54313bd2.d20261119-py3-none-any.whl` |
| script `wheel-contract` rejoué au poste | ✅ bundle embarqué (55 336 o), LICENSE embarquée, tag universel |
| `uv lock` | ✅ 140 paquets, `requires-python = ">=3.13"` |
| chemin **éditable** sans bun (venv jetable, `uv pip install -e . --no-deps`) | ✅ stub de 175 o posé, `import airflow_dag_gantt` OK (`__version__` = version des métadonnées) |
| `.venv/bin/pytest -q -rs tests` | ✅ `9 passed, 1 skipped` (skip = `test_api_runs_contract`, pas de métadatabase → `TODO:` du `.gitlab-ci.yml`) |
| `ruff check` / `ruff format --check` / `prek run --all-files` | ✅ (sauf le hook `js-tests-dom`, §8.1) |
| `glab ci lint -R data-platform-b2b/core/airflow-plugin-dag-gantt` | ✅ « CI/CD YAML is valid! » |
| inputs des composants | ✅ vérifiés dans les templates sources : `node@5.4.2` (`manager` accepte `bun`, `manager-version`, `project-dir`, `build-args`, `build-dir`, `test-args`, `outdated-disabled`, `sbom-disabled`, `lint-enabled`, `typecheck-enabled` tous réels) et `python@9.4` (`build-system` accepte `uv`, `pytest-enabled`, `ty-enabled`) |
| `py-package` côté template | ⚠️ le template fait `uv build` **sans `--wheel`** → sdist **et** wheel ; le hook sort tôt sur `sdist` et l'sdist exclut `static/` : rien à changer |

Ce que le poste **ne peut pas** prouver : le réseau des runners (npm, semgrep, DB trivy), le
`uv publish`, semantic-release et Dependency-Track → un MR jetable sur `d2b` est le seul juge, et
c'est Antoine qui pousse.

## 8. Constats post-exécution

### 8.1 ⚠️ Régression **préexistante**, hors plan : `js/test/render.test.mjs`

`bun run test:dom` échoue à HEAD (`f54313b` — « refactor(gantt): audit react-doctor & refactor ») :
`AssertionError: bin=off : une barre par run` — `0 !== 1127` (`js/test/render.test.mjs:259`), soit le
widget ne rend **aucune** barre dans le harnais DOM. Mesures croisées (worktree jetable + copie) :

- `349679f` (v0.7.2), test et src ensemble → ✅ « assertions passées — 1127 barres avec bin=off » ;
- test de HEAD + src de `349679f` → ✅ première assertion, ❌ plus loin (ligne 550) ;
- test de `349679f` + src de HEAD → ❌ dès la ligne 252.

Le couple `{src, test}` produit par `f54313b` est donc incohérent dans les deux sens, et **rien de
ce plan n'y contribue** (`git status js/` était vide avant comme après). Impact CI : **aucun** —
`bun run test` (ce que lance `node-build`) enchaîne `aggregation`/`time`/`grouping`/`view` et **ne
contient pas** `render.test.mjs` ; seule la commande `test:dom` (hook local `js-tests-dom`) est
rouge. À traiter comme un sujet à part : soit le widget ne rend plus rien en DOM (vrai bug,
le plus grave), soit le harnais n'a pas suivi la découpe en `lib/`+`hooks/`+`components/`.

### 8.2 Dérive déjà visible, relevée sans être corrigée

`ruff` est épinglé **deux fois** à des versions différentes : `uvx ruff@0.16.1` dans les hooks locaux
(`.pre-commit-config.yaml`) et `rev: v0.17.5` sur `ruff-pre-commit` dans `.pre-commit-ci.yaml`. Renovate
ne tient que le second (le `entry:` n'est pas une dépendance pour lui). Choix à trancher : aligner le
hook local sur `0.17.x`, ou faire porter le lint gating **uniquement** par `.pre-commit-ci.yaml`.

### 8.3 Reste ouvert (rappel de §6, et ce qui vient de s'ajouter)

1. Registre npm depuis les runners (`node-build`, `node-audit`) — soupapes `config-registry`, `audit-disabled`.
2. `node-semgrep` et ses règles `semgrep.dev`.
3. Cible de `py-publish` : registre PyPI **du projet** (choisi, aucun dépôt de variable nécessaire)
   vs Artifactory DTSI — la décision **n'est pas** prise, et `airflow-dag-gantt` est déjà pris sur PyPI
   public (donc un canal partagé suppose un `pypi-local` dédié et un autre nom).
4. Règles adaptatives TBC : hors MR, les jobs de test passent `manual` + `allow_failure` → juger sur un MR.
5. Activer Renovate sur le projet (bot central) et vérifier, au premier passage, qu'il propose bien
   les `@x.y` des composants — si `registryAliases` ne suffit pas, la ligne de repli est un `include:`
   en URL littérale `https://gitlab.tech.orange/...` (le composant TBC l'accepte aussi).
6. Le tag amont `5.4.3` du template node existe déjà sur l'instance (épinglé `5.4.2`) : première MR
   Renovate attendue sur ce composant.
7. Premiers tags **sans `v`** à partir de `0.7.4` ; les `v0.7.x` historiques restent lisibles par
   hatch-vcs (préfixe `v` toléré) — à garder en tête le jour où l'on publierait depuis une shallow clone.
