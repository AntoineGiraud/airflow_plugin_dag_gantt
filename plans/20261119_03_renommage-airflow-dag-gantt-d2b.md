# 📋 Plan : renommer la distribution en `airflow-dag-gantt-d2b`

> Statut : **exécuté** le 20261119 (résultats et un écart d'ordre en §7). Périmètre arbitré par
> Antoine le 20261119 :
> **nom de distribution seulement** — le nom d'import `airflow_dag_gantt` et l'entry point
> `dag_gantt` ne bougent pas. Motif : le nom `airflow-dag-gantt` est **pris sur PyPI public** et
> servi par le proxy `pythonproxy` ; le suffixe ferme la porte à la dependency confusion et ouvre
> celle du plan `20261119_04` (installation par index dans l'image).
> Base : branche `ci-gitlab-bun-renovate`, HEAD `fbc8e85`.

## 1. Ce qui change, et ce qui ne change pas

| Niveau | Aujourd'hui | Après | Pourquoi |
| --- | --- | --- | --- |
| **Nom publié** (`[project].name`) | `airflow-dag-gantt` | `airflow-dag-gantt-d2b` | le nom public est pris par un autre Gantt Airflow 3 |
| Nom du **wheel** | `airflow_dag_gantt-0.7.4-py3-none-any.whl` | `airflow_dag_gantt_d2b-0.7.4-py3-none-any.whl` | dérive du nom publié (PEP 427, normalisation `-` → `_`) |
| Nom d'**import** | `airflow_dag_gantt` | **inchangé** | zéro casse runtime, `src/`, hook, `dev.sh`, tests |
| **Entry point** `airflow.plugins` | `dag_gantt = "airflow_dag_gantt.plugin:DagGanttPlugin"` | **inchangé** | `check_plugins.py` de l'image attend `dag_gantt` |
| `PLUGIN_NAME` / `URL_PREFIX` / `REACT_APP_NAME` / clé `globalThis` | `dag_gantt` / `/dag-gantt-plugin` / `Dag Gantt` | **inchangés** | menu Airflow, route du bundle, contrat front ↔ Python |
| Nom dans le registre PyPI du projet GitLab | — (jamais publié) | `airflow-dag-gantt-d2b` | `py-publish` publie le nom du paquet |

Le renommage est donc **sans effet sur le déploiement** : ce que l'image installe, c'est un chemin
de wheel, et ce qu'Airflow découvre, c'est un entry point. Il n'y a pas de MR croisée obligatoire.

## 2. Les 8 points à toucher (comptés, pas supposés)

| # | Fichier | Où | Action |
| --- | --- | --- | --- |
| 1 | `pyproject.toml` | `name = "airflow-dag-gantt"` (ligne 2) | → `"airflow-dag-gantt-d2b"`, avec un commentaire de **2 lignes max** disant pourquoi (nom pris sur PyPI public + `pythonproxy`) et que seul le nom publié porte le suffixe |
| 2 | `src/airflow_dag_gantt/__init__.py` | `version("airflow-dag-gantt")` (ligne 14) | → `version("airflow-dag-gantt-d2b")`. ⚠️ c'est le **seul endroit où une divergence est silencieuse** : un ancien nom lu là donne `__version__ = "0.0.0+unknown"` dans les logs des pods, sans erreur → couvert par le garde-fou §3 |
| 3 | `tests/test_plugin_packaging.py` | docstring ligne 1 ; `version("airflow-dag-gantt")` (ligne 218) | docstring : `paquet airflow-dag-gantt-d2b (module importé airflow_dag_gantt)` ; la ligne 218 ne prend **pas** le nouveau nom en dur → voir §3 |
| 4 | `Dockerfile` (du plugin) | `pip install … /tmp/plugin-dist/airflow_dag_gantt-*.whl` (ligne 23) | → `airflow_dag_gantt_d2b-*.whl`. Le glob **ne suit pas tout seul** : sans ce changement, `pip install` reçoit un glob qui ne pointe sur rien et le build Astro casse |
| 5 | `build.sh` | commentaire ligne 10 (parle du glob du `Dockerfile`) | mettre le nom à jour dans le commentaire, sinon il ment |
| 6 | `uv.lock` | `name = "airflow-dag-gantt"` (ligne 37, paquet racine editable) | `uv lock` à relancer (le nom de la racine change ; le reste de l'arbre est inchangé → aucun bruit de résolution attendu, à vérifier quand même en `git diff --stat uv.lock`) |
| 7 | `README.md` | lignes 378-381 (encadré « `pip install airflow-dag-gantt` n'est pas une commande de ce projet »), 387 (sortie d'exemple `source : airflow-dag-gantt==0.4.0`), 416 (`pip show airflow-dag-gantt`), ~398 (snippet `COPY dist/` + glob du `Dockerfile`), 431 (§5 « le nom est déjà pris ») | réécrire autour du nouveau nom : le suffixe **est** la réponse à la prise de nom, l'encadré devient « le nom publié est `…-d2b` ; `airflow-dag-gantt` sans suffixe = le paquet d'un autre, ne jamais l'installer ni mélanger les index » |
| 8 | `dev.sh` | `PKG=airflow_dag_gantt` (ligne 28) | **ne pas toucher** — `PKG` désigne le paquet importé (il sert à `python -c "import $PKG"` et aux `docker cp` de `src/$PKG`), pas le nom publié. À dire dans le commit pour qu'on ne le « corrige » pas plus tard |

Hors périmètre, assumé : les `plans/` historiques (ce sont des enregistrements, on ne les réécrit
pas) — le renommage y est tracé par le présent plan et par une ligne au §8 de
`20261119_02_ci-gitlab-bun-renovate.md`.

## 3. Le garde-fou qui vaut le coup d'être ajouté

`__init__.py` et `pyproject.toml` portent le même nom en **deux littéraux séparés**. Le test de
version doit donc comparer `__version__` à la version de **la distribution dont le nom est lu dans
le pyproject**, pas à un littéral du test :

```python
name = tomllib.loads(PYPROJECT.read_text("utf-8"))["project"]["name"]
installed = version(name)          # PackageNotFoundError -> skip
assert airflow_dag_gantt.__version__ == installed
```

Effet : si un jour le nom change d'un seul côté, le test rougit (`0.0.0+unknown` ≠ version
résolue) au lieu que les logs des pods racontent n'importe quoi. Un renommage de plus devient
une modification à deux endroits dont le troisième (le test) est mécanique.

## 4. Conséquences externes à annoncer (sans les faire ici)

- **`02_core/airflow-docker-image`** : la wheel actuellement dans `plugins/wheel/` reste
  `airflow_dag_gantt-0.7.3-py3-none-any.whl` et **s'installe toujours** (chemin, pas nom). Ce qui
  devient faux au prochain dépôt de wheel : `requirements-plugins.txt:22`, `plugins/README.md:17,
  33-34, 49, 79, 89, 108`, `README.md:37,46`, `Dockerfile:102`, `plugins/check_plugins.py`
  (lui, **rien** : l'entry point ne change pas). Traité dans `plans/20261119_04`.
- **Consommateurs qui installeraient par nom** : il n'y en a aucun aujourd'hui (le paquet n'a
  jamais été publié) → aucune dépendance cassée.
- **Registre PyPI du projet GitLab** : la première publication se fera sous
  `airflow-dag-gantt-d2b`, donc pas de collision avec le paquet public, y compris derrière
  `pythonproxy` (qui proxifie PyPI public — c'est précisément le danger écarté).

## 5. Ordre d'exécution + validation

1. Éditions 1→5 et 7 (un seul passage), puis `uv lock` (6).
2. `./build.sh` → attendre `dist/airflow_dag_gantt_d2b-0.7.4.devN+g<sha>-py3-none-any.whl`.
3. Rejouer le script `wheel-contract` au poste sur cette wheel (bundle > 1024 o, `globalThis`,
   LICENSE, `py3-none-any`) — le nom du paquet n'y change rien, mais c'est l'artefact livré.
4. Resynchroniser l'environnement local **avec l'ordre qui va bien** (sinon `.venv` garde la
   metadata de l'ancien nom et le test de version se skippe en silence) :
   `uv pip uninstall -p .venv/bin/python airflow-dag-gantt` puis
   `uv pip install -p .venv/bin/python -e . --no-deps` → le test passe (et l'environnement local
   devient éditable, comme `uv sync` en CI).
5. `pytest -q -rs tests` → attendre `10 passed` ou `9 passed, 1 skipped` (le skip connu =
   `test_api_runs_contract`, pas de métadatabase).
6. `glab ci lint -R data-platform-b2b/core/airflow-plugin-dag-gantt` (rien dans `.gitlab-ci.yml`
   ne porte le nom : `wheel-contract` fait `ls dist/*.whl`, `py-package` publie le nom du projet).
7. Contrôle de résidu : `grep -rn "airflow-dag-gantt\b" --include=… | grep -v -- "-d2b"` ne doit
   retourner **que** les mentions volontaires (le commentaire du pyproject, l'encadré README qui
   parle du paquet public, les `plans/`).
8. `prek run --all-files` (le hook `js-tests-dom` est rouge de toute façon — régression préexistante
   de `f54313b`, plan `20261119_02` §8.1).

## 6. Commit proposé

Un seul commit sur `ci-gitlab-bun-renovate` (le nom, le lock, le garde-fou et la doc ne tiennent
pas séparément) :

```
refactor(packaging): le nom publié devient airflow-dag-gantt-d2b

corps : ⚠️ changement de comportement pour qui installe par nom — le paquet
s'appelle airflow-dag-gantt-d2b, le wheel airflow_dag_gantt_d2b-*. Le nom
d'import (airflow_dag_gantt), l'entry point (dag_gantt), l'URL montée
(/dag-gantt-plugin) et la clé globalThis ('Dag Gantt') ne changent pas :
check_plugins.py de l'image, le menu Airflow et le bundle sont inchangés.
Le suffixe ferme la dependency confusion (nom pris sur PyPI public, servi
par pythonproxy) et débloque l'installation par index (plan 20261119_04).
```

Toujours **aucun push** : c'est Antoine qui pousse.

## 7. Exécution (20261119)

Un commit local sur `ci-gitlab-bun-renovate`, **non poussé**.

| Étape | Résultat |
| --- | --- |
| Éditions 1→5, 7 | faites ; `dev.sh` (`PKG`) non touché, comme décidé au point 8 |
| `uv lock` (6) | `Removed airflow-dag-gantt (dynamic)` / `Added airflow-dag-gantt-d2b (dynamic)` — `git diff --stat uv.lock` : **2 lignes**, zéro bruit de résolution |
| `./build.sh` | `dist/airflow_dag_gantt_d2b-0.7.4.dev2+gfbc8e85b1.d20261119-py3-none-any.whl` |
| contrat de wheel rejoué | bundle embarqué **55 150 octets** + `globalThis`, `dist-info/licenses/LICENSE`, `-py3-none-any` ✅ |
| garde-fou §3 | écrit côté test (`published_name` lu dans le pyproject) ; **vérifié rouge** en remettant l'ancien nom dans `__init__.py` → `FAILED test_version_matches_the_installed_distribution`, puis restauré |
| `pytest -q -rs tests` | **9 passed, 1 skipped** (skip = `test_api_runs_contract`, pas de métadatabase) |
| `glab ci lint -R data-platform-b2b/core/airflow-plugin-dag-gantt` | `✓ CI/CD YAML is valid!` |
| contrôle de résidu | une seule mention volontaire hors `plans/` : le commentaire du `pyproject.toml:l.2`
(le README ne nomme plus l'ancien nom qu'à travers l'encadré et le §5) |
| `prek run --all-files` | tout vert **sauf** `js-tests-dom` (`0 !== 1127`) — régression préexistante de `f54313b`, `plans/20261119_02` §8.1, sans rapport avec ce commit |

### 7.1 ⚠️ Écart sur le §5.4 : l'install éditable **écrase** le bundle vrai

Le §5.4 fait faire `./build.sh` **puis** `uv pip install -e . --no-deps`. Cet ordre laisse en réalité
**8 passed, 2 skipped** : l'editable sans `DAG_GANTT_JS_DIR` déclenche le stub de `hatch_build.py`
jusque dans `src/airflow_dag_gantt/static/` (le source, pas seulement le venv), donc
`test_bundle_is_shipped_inside_the_package` se **skip** — ce que le §5 prenait pour le skip connu.
Ordre qui donne le résultat attendu : install éditable **puis** `./build.sh` (ou
`DAG_GANTT_JS_DIR=js/dist uv pip install -e . --no-deps`) → le bundle réel est de retour dans
`static/` → 9 passed, 1 skipped. Piège orthogonal au renommage, mais c'est lui qui l'a fait
apparaître : avant, le venv pointait sur une wheel de 0.7.3 hors dépôt.

### 7.2 Effet de bord favorable sur l'environnement local

`.venv` installait `airflow-dag-gantt==0.7.3` **depuis** `codes_antoine/airflow/dag-gantt/dist/…whl`
(ancienne arborescence) : `__version__` y valait 0.7.3 alors que le source est à 0.7.4.dev. Le
`uv pip uninstall` + editable du §5.4 a supprimé ce fantôme — l'environnement local est maintenant
éditable sur ce dépôt, comme `uv sync` en CI.

### 7.3 Trace ajoutée dans le plan précédent

§8.3 point 3 de `plans/20261119_02_ci-gitlab-bun-renovate.md` (décision de nom) est clos par un
§8.4 : nom publié `airflow-dag-gantt-d2b`, import/entry point/URL inchangés. La cible d'index reste
ouverte → `plans/20261119_04`.

### 7.4 Ce qui n'a **pas** été fait (hors périmètre, cf. §4)

Rien dans `02_core/airflow-docker-image` : la wheel déjà déposée dans `plugins/wheel/` s'installe
toujours par chemin. Les mentions du nom du wheel dans `requirements-plugins.txt`, `plugins/README.md`,
`Dockerfile` et le `README.md` de l'image deviennent fausses **au prochain dépôt de wheel** →
`plans/20261119_04`.
