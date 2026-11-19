# 📋 Plan : publier `airflow-dag-gantt` sur l'Artifactory interne via une CI GitLab (modèle `s3-ojs`)

> Statut : **brouillon en cours** — questions ouvertes en fin de document.

## 1. Contexte

Le plugin Global Dag Gantt est aujourd'hui un dépôt **GitHub** (`AntoineGiraud/airflow_plugin_dag_gantt`,
dossier `codes_antoine/airflow/dag-gantt`). Il est déjà un **vrai paquet Python** (hatchling, entry point
`airflow.plugins`, wheel qui embarque le bundle JS), mais il n'est distribué que par **wheel copiée à la main** :

- dans l'image de labo : `Dockerfile` → `COPY dist/` + `pip install *.whl` ;
- dans l'image d'instruction `02_core/airflow-docker-image` : `plugins/wheel/*.whl` versionnée dans le repo,
  installée en `--no-deps --no-index` (cf. `02_core/airflow-docker-image/plugins/README.md`).

Une copie existe déjà dans l'espace interne : `02_core/airflow-plugin-dag-gantt` (même SHA `f54313b`,
remote **encore pointé sur GitHub**, aucun remote `gitlab.tech.orange`) → le projet GitLab interne reste à
créer/rattacher.

Objectif : **aligner le dépôt sur le modèle `40_utils/s3-ojs`** — dépôt hébergé sur `gitlab.tech.orange`,
CI `to-be-continuous` qui **package et publie le paquet Python sur l'Artifactory interne**, version portée
par semantic-release. Cible finale (autre étape) : `uv add <paquet>` dans `02_core/airflow-docker-image`.

## 2. Ce que fait déjà `s3-ojs` (le modèle à copier)

| Élément | `s3-ojs` | `dag-gantt` aujourd'hui |
| --- | --- | --- |
| remote | `gitlab.tech.orange/data-platform-b2b/Utils/s3-ojs` | GitHub |
| CI | `.gitlab-ci.yml` : gitleaks + `to-be-continuous/python@9.4` + pre-commit + dependency-track + semantic-release `@4.0.1` | `.github/workflows/ci.yml` (GitHub Actions) |
| publication | `PYTHON_PUBLISH_ENABLED: true`, `PYTHON_PACKAGE_MANAGER: "uv"`, `PYTHON_RELEASE_ENABLED: false` | aucune |
| version | `dynamic = ["version"]` + `[tool.hatch.version] source = "vcs"` (hatch-vcs) | `version = "0.7.3"` en dur |
| lock | `uv.lock` commité (le template fait `uv sync --frozen`) | **aucun** `uv.lock`, extras `[project.optional-dependencies] dev` |
| deps dev | `[dependency-groups] dev` | `[project.optional-dependencies] dev` |
| bundle JS | n/a (CLI pur Python) | `hatch_build.py` **exige** `DAG_GANTT_JS_DIR` → wheel rouge sans `bun run build` |

## 3. Points durs déjà identifiés (à trancher)

1. **Le nom `airflow-dag-gantt` est déjà pris sur PyPI public, et le proxy interne le sert.**
   Vérifié le 2026-11-19 : `GET https://repos.tech.orange/artifactory/api/pypi/pythonproxy/simple/airflow-dag-gantt/`
   → **200** avec des wheels `airflow_dag_gantt-0.1.0 … 0.2.x` d'un **autre** éditeur. Donc `uv add airflow-dag-gantt`
   dans `airflow-docker-image` (index par défaut = `pythonproxy`, cf. son `pyproject.toml`) risquerait
   d'installer **le paquet d'un tiers** : dépendance confusion exactement celle que signale
   `airflow-docker-image/plugins/README.md`. → question « nom du paquet ».
2. **Le bundle JS dans la CI.** `hatch_build.py` lève `RuntimeError` sans `DAG_GANTT_JS_DIR`, et le job
   `py-package` du template tourne dans `PYTHON_IMAGE` (`python:3.14`) **sans bun ni node**. Trois issues
   possibles (bundle committé, job JS amont, hook tolérant) → question « chaîne de build ».
3. **`apache-airflow>=3.1` en dépendance.** Publié sur un index, le paquet devient résolvable : un
   `uv add` dans `airflow-docker-image` tirerait tout l'arbre Airflow dans le lock. Le repo cible déclare
   déjà `apache-airflow==3.4.0` (donc satisfait) mais le statut de la dépendance (runtime vs
   `provides-extra`) mérite une décision → question « déclaration de la dépendance ».
4. **Version** : les tags sont à `v0.7.2` alors que `pyproject.toml` porte `0.7.3` en dur ; passer en
   `dynamic`+hatch-vcs (modèle s3-ojs) transfère la main à semantic-release.

## 4. Approche retenue

_(à figer après les réponses — squelette)_

- [ ] Déposer le `.gitlab-ci.yml` sur le modèle `s3-ojs` (gitleaks / python / pre-commit / dep-track / semrel).
- [ ] `pyproject.toml` : version dynamique (hatch-vcs), `[dependency-groups]`, écart GitHub → GitLab.
- [ ] `uv.lock` commité + `PYTHON_PACKAGE_MANAGER: "uv"`.
- [ ] Chaîne de build du bundle JS compatible job `py-package` sans bun.
- [ ] `.pre-commit-config.yaml` local + `.pre-commit-ci.yaml` CI (modèle s3-ojs).
- [ ] Sortie de la CI GitHub (`.github/workflows/ci.yml`) ou conservation en miroir.

## 5. Fichiers concernés

- `pyproject.toml`, `hatch_build.py`, `build.sh`, `uv.lock` (nouveau)
- `.gitlab-ci.yml` (nouveau), `.pre-commit-ci.yaml` (nouveau), `.github/workflows/ci.yml` (sortie)
- `README.md` (section installation), éventuellement `package.json`/`js/` pour le job CI

## 6. Questions ouvertes

1. Nom du paquet publié (conflit PyPI public via le proxy) ?
2. Chaîne de build du bundle JS dans la CI GitLab ?
3. Le projet GitLab interne existe-t-il déjà, et où (`data-platform-b2b/...`) ? Sur quel dépôt
   on continue (`codes_antoine/airflow/dag-gantt` ou `02_core/airflow-plugin-dag-gantt`) ?
4. `apache-airflow` : dépendance runtime, ou extra/optionnel pour ne pas polluer le lock cible ?
