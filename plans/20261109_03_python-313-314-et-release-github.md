# Cible Python 3.13/3.14 + publication par GitHub Release (wheel)

## Context

Deux demandes : (1) viser **Python 3.13 et 3.14**, (2) **déployer via une GitHub Release**
portant la wheel buildée — sans s'offrir un chantier de maintenance ni une surface d'attaque.

**Décisions de l'utilisateur (arbitres retenus)** : dépôt **public** · canal = **Release GitHub +
TestPyPI** · `requires-python >= 3.12` · CI = **lint + tests mono-Python (3.14) + release sur tag**.

**✅ Acté au retour de relecture : la licence MIT est retenue** — le fichier `LICENSE` est donc bien
créé (le projet est « vibe codé » avec pi + qwen3.8, ce qui ne change rien au choix de licence :
MIT, ayant droit = Antoine Giraud, seul auteur mentionné dans `authors`).

### Ce qui est vérifié dans le dépôt / le conteneur (pas supposé)

| Constat | Preuve |
| --- | --- |
| **Le runtime cible tourne déjà en Python 3.14** : `py 3.14.10`, `airflow 3.3.2+astro.3` | `docker run --rm --entrypoint python dag-gantt_f2938e/airflow:latest -c "import sys, airflow; ..."` |
| `runtime:3.3-12` = Runtime 3.3 **patch 12**, **pas** Python 3.12 ; Python 3.12–3.14, **défaut 3.14** | docs Astronomer *Runtime image architecture* (Runtime 3.2/3.3 = 3.12–3.14 ; 3.0/3.1 = 3.11–3.12) |
| La wheel est **universelle** (`py3-none-any`, 19,4 K, pur Python) → **aucune wheel par version de Python à produire** ; le support 3.13/3.14 est une déclaration de métadonnées + une preuve par les tests, **pas** une matrice de build | `dist/`, `[tool.hatch.build.targets.wheel]`, `unzip -l` |
| Code sans aucune spécificité ≤ 3.12 (231 lignes, `from __future__ import annotations`, FastAPI, `AirflowPlugin`) | `src/airflow_dag_gantt/{__init__,plugin,api}.py` |
| Métadonnées en retard : `Requires-Python: >=3.10`, classifiers arrêtés à **3.12**, pas de `[project.urls]`, pas de `target-version` ruff | `unzip -p dist/*.whl '*METADATA'` |
| **Aucune CI** (`.github/` absent), **aucun tag**, `gh` installé mais **token invalide** | `ls .github` · `git tag` · `gh auth status` |
| Version **dupliquée** : `pyproject.toml` (`0.1.0`) **et** `airflow_dag_gantt.__version__` (`0.1.0`) | les deux fichiers |
| `license = { text = "MIT" }` déclaré, **aucun fichier `LICENSE`** → **licence MIT retenue par l'utilisateur** (feedback du 2026-11-09 : « ça me va pour la licence MIT ») → le fichier sera créé | `ls` |
| ⚠️ **Le nom `airflow-dag-gantt` est PRIS sur PyPI public** par un autre plugin Gantt Airflow 3 (Yeonguk Choo, v0.2.3, `>=3.10`) ; **libéré sur TestPyPI** (HTTP 404) | `pypi.org/pypi/airflow-dag-gantt/json` · TestPyPI |
| `ruff check .` **passe** ; `ruff format --check .` **échoue** sur `hatch_build.py` (1 fichier) | local, ruff 0.16.1 |
| `pip install -e .` **échoue sans `DAG_GANTT_JS_DIR`** → le docstring de `tests/test_plugin_packaging.py` (`./build.sh && uv venv && uv pip install -e '.[dev]'`) est **faux** | `pip install --dry-run -e .` → `Encountered error while generating package metadata` |
| `test_api_runs_contract` est **skipé** hors conteneur : `httpx` (requis par `fastapi.testclient`) n'est pas dans l'extra `dev` | `pyproject.toml [dev]`, image = httpx 0.28.1 |
| **pip vérifie le fragment `#sha256=` d'une URL directe** : mauvais hash → erreur rouge, bon hash → install | test empirique : `Expected sha256 a… Got 4cd2da62…` vs `Would install airflow-dag-gantt-0.1.0` |
| `build.sh` **ne nettoie pas `dist/`** : après un bump de version, `COPY dist/` + `pip install …/airflow_dag_gantt-*.whl` verrait **deux** wheels → build Astro cassé | `Dockerfile` ligne `RUN pip install …*.whl` |
| Airflow : 3.1.x = `>=3.10,<3.14` (donc py3.14 ⇒ airflow ≥ 3.2), 3.2+ = 3.10–3.14, 3.4 testé 3.11–3.14 ; py3.10 EOL depuis oct. 2026 | docs Airflow + PR apache/airflow#63520 |
| **TestPyPI accepte le Trusted Publishing (OIDC)** → aucun token longue durée à stocker dans le dépôt | docs PyPA *Publishing with a Trusted Publisher* |
| **Immutable releases** (public preview) + attestations de build + `gh release verify` disponibles pour un dépôt public | docs GitHub |

### Réponse à « bonne idée, ou maintenance + risque de sécu ? »

**Oui, à condition de ne publier que depuis un tag et de vérifier le hash côté consommateur.**
Le risque n'est pas dans le *canal* (une Release), qui est objectivement **plus sûr qu'un
`git+ssh`** (le `git+ssh` du README §7.2 exige `bun` au moment de l'install et exécute donc du
code de build arbitraire sur la machine qui installe ; la wheel, elle, ne déclenche **aucun**
build backend). Le risque est dans (a) le *workflow qui publie* et (b) *l'absence de vérification*
côté consommateur. Les deux se bouchent avec ~5 contrôles listés plus bas.

**Surface d'attaque réelle, classée :**

| Risque | Réel ? | Mitigation retenue (coût) |
| --- | --- | --- |
| Publier du code venant d'une PR via `pull_request_target` (le grand classique) | évité **par construction** | `on: push: tags: v*` uniquement ; aucun `pull_request_target`, aucun `script_ref` de fork |
| Token CI trop large | oui, faible | `permissions: contents: read` par défaut ; seul le job `release` a `contents: write` + `attestations: write` + `id-token: write` ; `persist-credentials: false` à chaque checkout |
| Credential volée réutilisable | **non** | **aucun secret longue durée dans le dépôt** : TestPyPI via OIDC (certificat court), Release via `GITHUB_TOKEN` jetable |
| Asset de release remplacé après coup | oui, faible | Settings → *Enable release immutability* (1 clic) + `#sha256=` épinglé dans le Dockerfile consommateur (**vérifié plus haut**) + attestation `actions/attest-build-provenance` |
| Tag publié depuis une branche non validée par la CI | oui | job `verify` : le SHA du tag doit être un ancêtre de `main` (`git merge-base --is-ancestor`) + tag == version du `pyproject.toml` |
| **Chaîne npm/bun** (webpack/babel injectent du JS dans le bundle → XSS dans l'UI Airflow, donc vol de session) | **le vrai risque de ce dépôt** | `bun install --frozen-lockfile` (lock `js/bun.lock` versionné), bundle de 12,4 K, build **seulement** sur PR/`main`/tag ; option différée : job `osv-scanner` |
| Dependency confusion vers le paquet PyPI homonyme d'un tiers | oui, **déjà là** | `--index-url` TestPyPI **sans** `--extra-index-url` + `--no-deps` documenté ; avertissement dans le README §7.2 ; ne jamais publier ce nom sur PyPI public |
| Egress github.com requis au build d'image (proxy d'entreprise) | oui, opérationnel | le mode local `COPY dist/` **reste le défaut** ; le mode release est un `--build-arg` explicite |

**Coût de maintenance chiffré** : 2 workflows (~130 lignes) écrits une fois ; par release = bump de
version + commit + tag (≈ 15 min, dont la moitié pour la doc) ; ~1 action à remonter de SHA par
trimestre (5 pins) si Dependabot n'est pas activé plus tard. C'est **moins** de maintenance que
PyPI (pas de gestion de nom, pas de 2FA org, pas de politique de yank).

## Note de révision (retour n°1)

Seul point remonté : ajouter la licence MIT → **actée**. Changes apportées au plan : étape **2**
(le texte exact à poser, la ligne de copyright, pourquoi ni pi ni qwen dans le `LICENSE`, et la
reconnaissance optionnelle ailleurs), étape **2b** (cohérence PEP 639 : `license-files` + pas de classifier
`License ::`), ligne `LICENSE` du tableau des fichiers, et **vérification renforcée** (contrôler que
le wheel embarque `LICENSE` sans perdre le `dag-gantt-widget.js.LICENSE.txt` du bundle).
Le reste du plan est inchangé.

## Approche

1. **Métadonnées d'abord, pas de code** : `requires-python = ">=3.12"`, classifiers 3.12/3.13/3.14,
   `[tool.ruff] target-version = "py312"`, `dev` += `httpx`, `[project.urls]`, fichier `LICENSE`.
   Aucune dépendance de build nouvelle (pas de `hatch-vcs`) : la version reste **manuelle**,
   et un **test** garantit qu'elle ne diverge plus.
2. **CI `ci.yml`** sur PR/`main` : `ruff check` + `ruff format --check`, build réel via `./build.sh`
   (bun), install de **la wheel produite** (pas un editable : on teste l'artefact publié),
   `pytest` en Python **3.14**, + une **résolution** `uv pip compile` en 3.12/3.13/3.14 (secondes,
   aucun install) pour prouver que les métadonnées se résolvent sur les 3 versions.
3. **`release.yml` sur tag `v*`** : vérifie tag == version, tag ancêtre de `main`, rebuild la wheel
   (mêmes étapes que la CI ⇒ reproductibilité du chemin de build), l'attache à la Release avec son
   tableau de sha256, génère l'**attestation de provenance**, puis publie **wheel only** sur
   **TestPyPI** via Trusted Publishing dans un `environment: testpypi` (avec **blocking reviewer** = toi, donc un tag seul ne publie rien).
4. **Côté consommateur** : un bloc Dockerfile « release » documenté (et fourni en exemple prêt à
   l'emploi), qui épingle URL + `#sha256=` ; le `Dockerfile` du dépôt garde le mode local
   `COPY dist/` par défaut pour que `./dev.sh full` reste hors-ligne et sans friction.
5. **Version `0.2.0`** : le changement de `requires-python` est un changement de métadonnées
   visible ; premier artefact publié = `0.2.0`, tag `v0.2.0`. (Le `0.1.0` local n'a jamais été publié.)

## Fichiers à modifier / créer

| Fichier | Changement |
| --- | --- |
| `pyproject.toml` | `requires-python = ">=3.12"` ; classifiers `3.12`/`3.13`/`3.14` (retirer 3.10/3.11) ; `version = "0.2.0"` ; `[tool.ruff] target-version = "py312"` ; `dev = ["pytest>=8", "ruff>=0.6", "httpx>=0.27"]` ; `[project.urls]` ; `build-system.requires = ["hatchling>=1.26"]` + `license = "MIT"` (PEP 639) + `license-files` |
| `LICENSE` **(nouveau — décidé)** | texte MIT standard (spdx `MIT`, 21 lignes), en-tête `Copyright (c) 2026 Antoine Giraud`. Nécessaire : `license-files` du pyproject doit pointer sur un fichier **existant**, sinon `uv build` échoue |
| `src/airflow_dag_gantt/__init__.py` | `__version__ = "0.2.0"` |
| `tests/test_plugin_packaging.py` | `sys.version_info >= (3, 10)` → `(3, 12)` ; **nouveau test** `test_version_is_consistent` (pyproject == `__init__.__version__`, même regex que celles déjà utilisées dans le fichier) ; corriger le docstring (`pip install -e .` **échoue** sans `DAG_GANTT_JS_DIR`, et il faut installer la wheel) |
| `build.sh` | purger `dist/*.whl` en début de script (sinon 2 wheels après un bump → `pip install …-*.whl` du `Dockerfile` casse) |
| `hatch_build.py` | `ruff format` (seul fichier non formaté) — rien d'autre |
| `.github/workflows/ci.yml` **(nouveau)** | lint + format + `./build.sh` + install wheel + `pytest` (py 3.14) + résolution 3.12/3.13/3.14 |
| `.github/workflows/release.yml` **(nouveau)** | jobs `verify` → `build` → `release` (+ attestation) → `testpypi` |
| `deploy/Dockerfile.from-release` **(nouveau)** | exemple consommateur : `ARG DAG_GANTT_URL` + `ARG DAG_GANTT_SHA256` + `pip install "${URL}#sha256=${SHA}"` + le même garde-fou d'entry point que le `Dockerfile` actuel |
| `Dockerfile` | inchangé (mode local par défaut) ; **1 commentaire** pointant vers le mode release |
| `README.md` | §7.2 réécrit (URL release + hash, avertissement nom PyPI pris, `git+ssh` qui exige bun) ; §7.3 = les **deux** modes ; nouvelle §7.6 « publier une release » (tag, immutability, `gh release verify`) ; §5/doc tests : la commande d'install qui marche |

**Réutilisation (rien de réinventé)** : `build.sh` est appelé tel quel par les deux workflows
(même chemin de build en local et en CI) ; `hatch_build.py` reste le garde-fou « pas de wheel sans
bundle » (un build CI rouge **est** le test) ; `tests/test_plugin_packaging.py` sert telle quelle à
la CI ; `./dev.sh full` et `./dev.sh api` restent la validation runtime ; le garde-fou d'entry
point du `Dockerfile` (`importlib.metadata.entry_points`) est repris dans l'exemple from-release.

## Étapes

- [x] **1. Métadonnées Python** — `pyproject.toml` : `requires-python = ">=3.12"`, classifiers 3.12/3.13/3.14, `target-version = "py312"`, `dev` += `httpx`, `[project.urls]`, PEP 639 (`license = "MIT"`, `license-files`, hatchling ≥ 1.26).
- [x] **2. `LICENSE` MIT (💰 confirmé par ton retour de relecture)** — créer `LICENSE` : le texte MIT exact
tel que publié par l'Open Source Initiative (`https://opensource.org/license/mit`), avec comme seule
partie variable : `Copyright (c) 2026 Antoine Giraud`. Sans y faire apparaître d'autres noms (ni pi,
ni qwen) : ce ne sont pas des ayants droit au sens du droit d'auteur, et une mention dans l'en-tête du
`LICENSE` brouillerait la chaîne de droits. Reconnaissance **optionnelle** et séparée, à mettre
dans le README (pas dans la licence) si tu la veux : « développement assisté par agent (pi +
qwen3.8) » — dis-moi si je l'ajoute.
- [x] **2b. Cohérence licence** — `pyproject.toml` en PEP 639 : `license = "MIT"` +
`license-files = ["LICENSE"]`, et **pas** de classifier `License :: …` (déprécié depuis PEP 639, il
serait dupliqué avec le champ SPDX). Vérifier que le wheel embarque le fichier.
- [x] **3. Garde-fou de version** — `test_version_is_consistent` dans `tests/test_plugin_packaging.py` ; borne de l'assertion `sys.version_info` → `(3, 12)` ; docstring de test corrigé (commandes d'install réelles).
- [x] **4. `build.sh`** — purge `dist/*.whl` avant build. `ruff format hatch_build.py` (pour que `ruff format --check` soit vert en CI).
- [x] **5. `.github/workflows/ci.yml`** — `permissions: contents: read`, `persist-credentials: false`, actions épinglées par SHA ; jobs : `lint` (`ruff check` + `format --check`), `resolve` (`uv pip compile` en 3.12/3.13/3.14), `test` (py 3.14 : `./build.sh` → `pip install dist/*.whl pytest httpx` → `pytest -q`).
- [x] **6. `.github/workflows/release.yml`** — `on: push: tags: ["v*"]` ; `verify` (tag == version pyproject, tag ancêtre de `main`) ; `build` (`bun install --frozen-lockfile` + `./build.sh`, sortie sha256) ; `release` (`contents/attestations/id-token: write`, upload wheel + corps avec sha256 + `actions/attest-build-provenance`) ; `testpypi` (`environment: testpypi`, `id-token: write`, `pypa/gh-action-pypi-publish` avec `repository-url: https://test.pypi.org/legacy/`, **wheel only**, `skip-existing: false`).
- [x] **7. Exemple consommateur** `deploy/Dockerfile.from-release` (URL + `#sha256=` + `--no-deps` assumé : airflow est dans l'image de base) + note dans le `Dockerfile` du dépôt.
- [x] **8. README** — réécriture §7.2/§7.3 (2 modes), encadré « ⚠️ `airflow-dag-gantt` sur PyPI public = un autre plugin » + pourquoi `--extra-index-url` est interdit ici, nouvelle §7.6 « publier une release » pas à pas, et mention des commandes exactes `gh release verify` / `gh attestation verify`.
- [x] **9. Étapes manuelles (toi, dans l'interface — je ne peux pas les faire)** : (a) `gh auth refresh` pour que je puisse créer le tag ; (b) Settings → Releases → **Enable release immutability** ; (c) Settings → Environments → `testpypi` (+ *required reviewers*) ; (d) compte TestPyPI → projet `airflow-dag-gantt` → *Add pending publisher* (repo + workflow `release.yml` + environment `testpypi`).
- [x] **10. Premiers feux** — commit, tag `v0.2.0` (**push = toi**), puis vérifications ci-dessous.

**Différé volontairement** (après la première release, si ça dure) : Dependabot (`pip`, `npm`,
`github-actions`), job `osv-scanner` sur `js/bun.lock`, matrice multi-Python avec `constraints-*`
pour tester la borne basse airflow 3.1 × py3.12, publication PyPI **sous un autre nom**.

## Vérification

Local, avant tag :

- [x] `ruff check . && ruff format --check .` → vert (aujourd'hui `format --check` rouge sur `hatch_build.py`).
- [ ] `./build.sh` → **une seule** wheel `airflow_dag_gantt-0.2.0-py3-none-any.whl` dans `dist/` ; `unzip -p dist/*.whl '*METADATA' | grep -E 'Requires-Python|Classifier|License'` → `>=3.12` + classifiers 3.12/3.13/3.14 + `License-Expression: MIT` ; `unzip -l dist/*.whl | grep -i license` → `LICENSE` présent **et** le `dag-gantt-widget.js.LICENSE.txt` du bundle toujours là (le premier est la licence du paquet, le second les licences des paquets JS — ne pas les confondre).
- [ ] `uv venv /tmp/v314 && uv pip install -p /tmp/v314 dist/*.whl pytest httpx && /tmp/v314/bin/pytest -q tests` → **0 skip** sur `test_api_runs_contract` (prouve que `httpx` est bien dans l'extra).
- [ ] `uv pip compile pyproject.toml --python-version 3.12 -q -o /dev/null` (puis 3.13, 3.14) → résout sur les 3.
- [ ] Runtime inchangé : `./dev.sh full` puis `./dev.sh api` → `dag-gantt 0.2.0 loaded …` dans `./dev.sh logs`.

Après le premier tag (push fait par toi) :

- [ ] Run `release.yml` vert ; la Release `v0.2.0` porte la wheel + une attestation ; `gh release verify v0.2.0` et `gh attestation verify dist/airflow_dag_gantt-0.2.0-py3-none-any.whl --repo AntoineGiraud/airflow_plugin_dag_gantt`.
- [ ] TestPyPI : `pip install --no-deps --index-url https://test.pypi.org/simple/ airflow-dag-gantt==0.2.0` (avec `--index-url`, **jamais** `--extra-index-url`).
- [ ] Chaîne consommateur, la vraie : `docker build -f deploy/Dockerfile.from-release --build-arg DAG_GANTT_URL=<asset> --build-arg DAG_GANTT_SHA256=<sha du run> .` → doit afficher `entry point ok: ['dag_gantt', …]`.
- [ ] Contrôle négatif (**la preuve que le hash sert à quelque chose**) : relancer le même build avec un sha256 faux → pip doit échouer sur `THESE PACKAGES DO NOT MATCH THE HASHES` (comportement déjà vérifié localement).
- [ ] Régression du mode local : `./dev.sh full` (défaut `COPY dist/`) toujours vert, hors-ligne.

## Note de révision (retour n°2) — le périmètre a été réduit à un POC

Question posée en cours d'exécution : « pour un POC, ce n'est pas un soupçon intense comme setup ? ».
**Réponse : oui sur la partie publication.** Le plan a donc été désamorcé à mi-chemin, ce qui était
exécuté étant déjà écrit.

| Gardé | Retiré |
| --- | --- |
| `requires-python >=3.12` + classifiers 3.12/3.13/3.14, `LICENSE` MIT, test de cohérence de version, purge `dist/*.whl` dans `build.sh`, `ci.yml` (lint + résolution 3.12/3.13/3.14 + build/tests en 3.14), **la config `[tool.ruff]` conservée** | `.github/workflows/release.yml` (4 jobs), `deploy/Dockerfile.from-release`, README §7.6 « publier une release », modes Release/TestPyPI du §7.2-§7.3, URL `Releases` du [project.urls], ligne `target-version` (voir annexe B) |

Le motif : le seul consommateur du plugin est la propre image du projet (`COPY dist/`). Un canal de
distribution et ses gardes (attestations SLSA, immutability, Trusted Publishing, environment à revue
humaine) ne payent leur loyer que quand **quelqu'un d'autre** installe l'artefact.

### Annexe A — recette de publication, si le plugin sort du POC

Tout ce qui suit a été **vérifié** (pas recopié d'une doc) et reste directement réutilisable.

Workflow `release.yml`, `on: push: tags: ["v*"]`, `permissions: contents: read` au plus haut niveau,
quatre jobs :

1. `verify` — `vX.Y.Z` == `[project].version` (lu avec `tomllib`, pas par regex : `[tool.hatch.*]`
   contient d'autres clés `version`), puis `git merge-base --is-ancestor <sha du tag> origin/main`
   (`fetch-depth: 0`) pour refuser une release de code jamais passé par la CI.
2. `build` — `./build.sh` (la même commande qu'en local), puis `sha256sum` → sortie de job + artifact.
3. `release` — `permissions: {contents: write, attestations: write, id-token: write}` ;
   `softprops/action-gh-release` avec `body_path` (tableau des sha256 + la ligne d'install toute faite)
   puis `actions/attest-build-provenance` avec `subject-path: dist/*.whl`.
   ⚠️ Piège rencontré : dans un `run:` YAML, des backticks **non échappés** dans une chaîne
   double-quote de shell sont exécutés comme substitution de commande (le texte disparaissait du
   corps de la release, avec une erreur en log). En single quotes.
4. `testpypi` — `environment: testpypi` + `permissions: {id-token: write}` +
   `pypa/gh-action-pypi-publish` avec `repository-url: https://test.pypi.org/legacy/`, **wheel only**
   (l'sdist de ce paquet n'est pas installable sans bun : le hook exige `DAG_GANTT_JS_DIR`),
   `skip-existing` laissé à `false` pour qu'un re-public soit bruyant. **TestPyPI accepte le Trusted
   Publishing OIDC** → aucun token dans le dépôt.

Actions épinglées par SHA (récupérées par `git ls-remote --tags`, l'API GitHub étant rate-limitée ici) :
`actions/checkout` v7.0.1 `3d3c42e5…`, `actions/setup-python` v7.1.0 `6d4fd22b…`,
`astral-sh/setup-uv` v6.8.0 `d0cc045d…`, `oven-sh/setup-bun` v2.2.0 `0c5077e5…`,
`actions/upload-artifact` v7.0.2 `cf430e03…`, `actions/download-artifact` v8.0.2 `9000827c…`,
`softprops/action-gh-release` v3.0.4 `28ab305d…`, `actions/attest-build-provenance` v4.2.2 `4d101475…`,
`pypa/gh-action-pypi-publish` release/v1 `7245906f…`.

Étapes manuelles d'interface (deux déjà faites) : ~~release immutability~~ ✅, ~~environment
`testpypi`~~ ✅, `gh auth refresh` ⬜, *Trusted Publisher* TestPyPI (repo + `release.yml` +
environment `testpypi`) ⬜ — sans celui-ci, le job `testpypi` échoue à l'échange OIDC **après** le
succès de la Release GitHub (jobs indépendants, c'est voulu).

Côté consommateur, le bloc qui remplaçait `COPY dist/` :

```dockerfile
ARG DAG_GANTT_VERSION=v0.2.0
ARG DAG_GANTT_SHA256            # aucune valeur par défaut : l'oublier doit faire échouer le build
RUN pip install --no-cache-dir --no-deps \
      "airflow-dag-gantt @ https://github.com/OWNER/REPO/releases/download/${DAG_GANTT_VERSION}/airflow_dag_gantt-0.2.0-py3-none-any.whl#sha256=${DAG_GANTT_SHA256}"
```

**La vérification du hash n'est pas une croyance** : avec un fragment `#sha256=` faux pip sort
`Expected sha256 a… Got 4cd2da62…` et n'installe pas ; avec le bon, `Would install
airflow-dag-gantt-0.2.0` (testé sur la wheel locale avec le pip de Python 3.14). `--no-deps` est
assumé : l'image de base contient déjà Airflow.

### Annexe B — `target-version` : la ligne retirée, et pourquoi

Question soulevée en relecture : « on n'est pas en 3.14, pourquoi `target-version = "py312"` ? ».
`target-version` est la version **minimale que le code doit supporter**, pas celle qui exécute.
Deux faits mesurés, pas d'opinion :

- `ruff check --show-settings` annonce `linter.unresolved_target_version = 3.12` **avec et sans**
  la ligne : ruff la déduit de `requires-python`. Elle n'apportait donc qu'un second endroit à
  bouger au prochain bump → supprimée, `requires-python` reste la source unique.
- La mettre à `py314` serait un **piège actif** : ruff pourrait proposer du code qui ne tourne
  pas en 3.12, alors que `requires-python` promet 3.12. Le 3.14 du runtime est couvert ailleurs
  (wheel `py3-none-any`, `requires-python` sans borne haute, CI qui **exécute** les tests en 3.14).

Le reste de la configuration ruff est **conservé** (c'est du lint, pas de la machinerie — le
désamorçage visait la chaîne de publication) :

```toml
[tool.ruff]
line-length = 100
src = ["src", "tests"]
target-version = "py312"
# `.astro` : squelette `astro dev init` (« DO NOT EDIT ») — I001/E501/SIM910/UP015 y sont structurels.
# `*.md` : ruff formate les blocs ```python des markdown ; les extraits de README/plans sont
# illustratifs. (C'est un plan qui rendait `ruff format --check .` rouge, pas un .py.)
extend-exclude = [".astro", "*.md"]

[tool.ruff.lint]
select = ["E", "F", "W", "I", "UP", "B", "C4", "SIM"]   # DTZ/BLE/RUF012 hors périmètre (contrat Airflow : listes mutables en attributs de classe)

[tool.ruff.lint.isort]
known-first-party = ["airflow_dag_gantt"]
```

Note : `target-version = "py312"` faisait apparaître 3 `UP017` (`timezone.utc` → `datetime.UTC`),
**déjà appliqués** dans `src/airflow_dag_gantt/api.py` et `dags/gantt_demo.py` — ils restent valides
sans la configuration (`datetime.UTC` existe depuis 3.11, et la borne basse est 3.12).
