# 📋 Plan : transformer le plugin Gantt en paquet pip installable (`uv` / `pip`)

> Révision du brief Gemini « Master Plan : Déploiement & Infrastructure ».
> Tout ce qui est marqué ✅ a été **vérifié à la main** dans l'image Astro Runtime
> `3.3-12` (Airflow **3.3.2+astro.3**) et avec `uv 0.13.6` sur ce poste. Les corrections
> de brief sont regroupées en [§0.3](#03-corrections-apportées-au-brief-gemini).

## 0. Contexte, décision, corrections du brief

### 0.1 Où on en est

Le dépôt actuel (`airflow_plugin_dag_gantt`, remote `AntoineGiraud/airflow_plugin_dag_gantt`)
est un **projet Astro CLI** :

- `plugins/dag_gantt_plugin.py` — plugin Global Dag Gantt (FastAPI + `react_apps`) ;
- `plugins/advent_calendar_plugin.py` + `plugins/react-src-*/` — la base de Tamara Fingerlin ;
- `dags/day_1..day_24.py`, `dags/gantt_demo.py` — DAGs de démo ;
- `Dockerfile` = `FROM astrocrpublic.azurecr.io/runtime:3.3-12` (rien d'autre).

Aujourd'hui le plugin n'existe que parce que des fichiers traînent dans `$AIRFLOW_HOME/plugins/`
(`plugins_folder` = `/usr/local/airflow/plugins` ✅). Ce mode a deux défauts structurels :

1. **il n'est pas versionnable / installable** — pas de dépendances déclarées, pas de sémver,
   pas de registre ;
2. **en Kubernetes il n'atteint pas l'API Server** : c'est le symptôme décrit dans le brief
   (le `api-server` n'a pas le montage `plugins/` que le scheduler récupère).

### 0.2 Décision

> Le plugin **Global Dag Gantt** devient un **vrai paquet Python** distribué par `pip`/`uv`,
> auto-découvert par Airflow via l'entry point `airflow.plugins`. Le dossier `plugins/`
> ne garde plus que le volet démo Advent Calendar.

C'est la piste **C** du brief, et elle est la bonne : elle règle le problème K8s sans
toucher au Helm Chart (le paquet est dans l'image → présent sur **tous** les pods,
`api-server` compris), et elle rend le plugin testable hors Airflow.

Les trois stratégies du brief ne sont pas concurrentes au même niveau :

| Stratégie | Nature | Verdict |
| --- | --- | --- |
| A — `extraVolumes`/`extraVolumeMounts` sur l'api-server | Contournement (monter le dossier là où il manque) | À garder en **note d'ops** uniquement ; le `plugins/` reste non versionné et impose un restart à chaque changement de code |
| B — `COPY` des fichiers dans `/opt/airflow/plugins` | Baked-in, mais en mode « dossier » | Intermédiaire inutile une fois C disponible |
| **C — paquet pip + entry point** | Distribution réelle | **✅ cible de ce plan** ; B devient « `pip install` dans le Dockerfile » |

Le `Dockerfile` du brief (étape 2/3) est donc conservé, mais réduit à :
`FROM runtime…` + `COPY dist/*.whl` + `pip install`. Aucun volume, aucun Helm.

### 0.3 Corrections apportées au brief Gemini

| # | Affirmation du brief | Réalité vérifiée |
| --- | --- | --- |
| 1 | `build-backend = "setuptools.build_meta"` + `MANIFEST.in` (`recursive-include …/static *`) | Inutile avec **hatchling** : le `static/` vit **dans** `src/airflow_dag_gantt/`, il est donc inclus par `packages = ["src/airflow_dag_gantt"]`. ✅ vérifié : le `.whl` contient bien `airflow_dag_gantt/static/dag-gantt-widget.js`. `MANIFEST.in` n'existe que pour setuptools. |
| 2 | « le fichier React `bundle.js` généré par **Vite** » | Le widget est buildé par **webpack + bun**, et **doit le rester** : ses `externals` (`react → React`, `@chakra-ui/react → ChakraUI`, `react/jsx-runtime → ReactJSXRuntime`…) sont le mécanisme qui fait consommer au widget le design system de l'UI hôte. Vite (Rollup) ne sait pas produire ces globals `window` aussi directement. |
| 3 | `dependencies = ["apache-airflow>=3.3.0"]` | Trop strict pour un lab : `react_apps`/`fastapi_apps` existent depuis **Airflow 3.1** ✅ (doc 3.4). On met `apache-airflow>=3.1`, et le **test** d'acceptation se fait sur la 3.3.2 du poste. |
| 4 | `pip wheel .` | `uv build --wheel` fait la même chose, sans venv à créer. On garde `pip wheel` en alternative CI. |
| 5 | (silencieux) | `name` d'un plugin doit être **unique** : Airflow garde le premier découvert et ignore les suivants. D'où le nettoyage de `plugins/` à l'étape 4, sinon un `plugins/dag_gantt_plugin.py` résiduel **éclipse** le paquet installé. |
| 6 | (silencieux) | Un projet Astro `pip install` ses `requirements.txt` **dans l'image au build** (`astro dev start` reconstruit l'image). On ne peut donc pas installer la wheel « à chaud » : il faut builder la wheel **avant** `astro dev start`, dans un chemin lisible par le build Docker (hors `.dockerignore`). |
| 7 | (silencieux, brief §« Airflow n'authentifie pas les plugin FastAPI apps ») | Confirmé et important, mais **hors périmètre** de ce plan (choix explicite) ; rien ne change au comportement actuel de `/api/runs`. |

---

## 1. Cible : l'entry point, vraiment ?

Oui, et c'est le point le plus important du plan. Dans l'image `3.3-12` ✅ :

```python
# airflow/plugins_manager.py
__register_plugins(*_load_entrypoint_plugins())

def _load_entrypoint_plugins():
    for entry_point, dist in entry_points_with_dist("airflow.plugins"):
        plugin_class = entry_point.load()
        ...
```

- le groupe d'entry points est bien **`airflow.plugins`** (nom du groupe, pas du paquet) ;
- ce qui est chargé est **la classe** pointée (`AirflowPlugin` subclass), instanciée sans
  argument — pas un module, pas une fonction ;
- déjà utilisés en interne par l'image : `openlineage` et `astronomer_runtime` ✅ ;
- un paquet sans Airflow installé est quand même **détectable** : ✅ vérifié, dans un venv
  vierge Python 3.12 contenant juste la wheel,
  `entry_points().select(group="airflow.plugins")` renvoie
  `[('dag_gantt', 'airflow_dag_gantt.plugin:DagGanttPlugin')]`.

Le paquet peut donc s'installer de trois façons équivalentes :

```bash
pip install airflow-dag-gantt                 # depuis un registre interne (Nexus/Artifactory)
uv pip install ./dist/airflow_dag_gantt-*.whl # wheel locale (ce qu'on fera en local)
uv pip install "git+ssh://git@github.com/AntoineGiraud/airflow_plugin_dag_gantt.git@v0.1.0"
```

> ⚠️ Piège vérifié : `uv pip install <dir-source>` **échoue** si le bundle JS n'a pas été
> buildé (le hook de build l'exige — voir §2.3). C'est voulu (pas de wheel silencieusement
> sans UI), mais cela signifie qu'une install depuis Git **nécessite bun** sur la machine qui
> build. En CI/Docker, on installe toujours la **wheel pré-buildée**.

---

## 2. Étape 1 — mettre le dépôt en état d'être un paquet

### 2.1 Nouveau layout (racine = le paquet)

```text
airflow_plugin_dag_gantt/
├── pyproject.toml                  # ← nouveau : métadonnées + entry point
├── hatch_build.py                  # ← nouveau : câble js/dist vers le paquet
├── build.sh                        # ← nouveau : bun build + uv build --wheel
├── src/
│   └── airflow_dag_gantt/
│       ├── __init__.py             # __version__ = "0.1.0"
│       ├── plugin.py               # DagGanttPlugin(AirflowPlugin)  [ex plugins/dag_gantt_plugin.py]
│       ├── api.py                  # FastAPI app + requêtes SQLAlchemy
│       ├── static/
│       │   └── dag-gantt-widget.js #     copié depuis js/dist au build (gitignoré)
│       └── py.typed
├── js/                             # ← ex plugins/react-src-dag-gantt/ (inchangé : webpack + bun)
│   ├── src/{index.js,DagGanttWidget.jsx}
│   ├── webpack.config.js
│   ├── package.json
│   └── bun.lock
├── dags/                           # day_1..day_24.py + gantt_demo.py (démo)
├── plugins/                        # ← ne garde QUE advent_calendar_plugin.py + react-src-advent/
├── tests/
│   ├── test_plugin_packaging.py    # ← nouveau
│   └── dags/test_dag_example.py    # (intact, `astro dev pytest`)
├── Dockerfile                      # ← runtime + pip install de la wheel
├── .dockerignore                   # ← + js/src, tests, plans, docs ; dist/ DOIT rester
├── requirements.txt                # ← commentaire : le plugin s'installe comme paquet
└── README.md                       # ← nouveau § « Installer le plugin comme paquet »
```

À faire :

- `git mv plugins/react-src-dag-gantt js` ;
- `git mv plugins/dag_gantt_plugin.py src/airflow_dag_gantt/plugin.py` (puis découpe
  `plugin.py` / `api.py` : la classe d'un côté, la partie HTTP/SQL de l'autre) ;
- `mkdir -p src/airflow_dag_gantt/static` + `__init__.py` + `py.typed` ;
- **supprimer** `plugins/dag_gantt_plugin.py` et `plugins/react-src-dag-gantt/` (sinon
  double chargement / éclipse, cf. §0.3 note 5).

### 2.2 `pyproject.toml`

```toml
[build-system]
requires = ["hatchling>=1.25"]
build-backend = "hatchling.build"

[project]
name = "airflow-dag-gantt"
version = "0.1.0"                      # ou hatch vcs + tag git (choix B, §6)
description = "Global Dag Gantt — vue macro de tous les DagRun d'une journée (Airflow 3.1+)"
requires-python = ">=3.10"
dependencies = ["apache-airflow>=3.1"]  # ne PAS épingler 3.3 : on veut rester installable

[project.optional-dependencies]
dev = ["pytest>=8", "ruff>=0.6"]

[project.entry-points."airflow.plugins"]
dag_gantt = "airflow_dag_gantt.plugin:DagGanttPlugin"   # ✅ groupe = airflow.plugins

[tool.hatch.build.targets.wheel]
packages = ["src/airflow_dag_gantt"]
artifacts = ["*/static/*"]              # static/ est gitignoré → sans cette ligne il est exclu

[tool.hatch.build.targets.sdist]
include = ["src", "js", "hatch_build.py", "pyproject.toml", "README.md"]

[tool.hatch.build.hooks.custom]
path = "hatch_build.py"
```

### 2.3 `hatch_build.py` — câbler le bundle JS (script ✅ testé)

Le hook **refuse de produire un wheel sans bundle** (pas d'UI cassée silencieusement) et ne
touche pas à l'`sdist`. Deux points non évidents vérifiés à l'exécution :

- il faut `artifacts = ["*/static/*"]` dans le `pyproject.toml`, sinon `static/`
  (gitignoré) est écarté du wheel ;
- il ne faut **surtout pas** utiliser `build_data["force_include"]` en plus de la copie
  physique : hatch lève `ValueError: A second file is being added to the wheel archive at
  the same path`.

```python
import os
from pathlib import Path
from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    """Copie js/dist (sortie de `bun run build`) dans <paquet>/static au moment du wheel."""

    def initialize(self, version, build_data):
        if self.target_name == "sdist":
            return                                   # l'sdist reste buildable sans bun
        env = os.environ.get("DAG_GANTT_JS_DIR")
        if not env:
            raise RuntimeError(
                "DAG_GANTT_JS_DIR is required: run `bun run build` in js/ then "
                "`DAG_GANTT_JS_DIR=js/dist uv build --wheel` (or ./build.sh)"
            )
        src = Path(env)
        if not src.is_absolute():
            src = (Path(self.root) / env).resolve()
        if not src.is_dir():
            raise RuntimeError(f"JS dist not found: {src}")
        dest = Path(self.root) / "src" / "airflow_dag_gantt" / "static"
        dest.mkdir(parents=True, exist_ok=True)
        for f in sorted(src.iterdir()):
            if f.is_file():
                (dest / f.name).write_bytes(f.read_bytes())
```

`build.sh` :

```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
( cd js && bun install && bun run build )
DAG_GANTT_JS_DIR=js/dist uv build --wheel       # --wheel : l'sdist n'a pas besoin du bundle
ls -l dist/
```

> `uv build` (sans `--wheel`) construit sdist **puis** wheel ; l'`sdist` est écrit en premier,
> donc un échec du hook laisse un `dist/*.tar.gz` orphelin. D'où `--wheel`.

### 2.4 `src/airflow_dag_gantt/plugin.py` — les 4 points qui changent

1. **Localiser le bundle dans le paquet**, plus à côté du `.py` :

   ```python
   BUNDLE_PATH = Path(__file__).parent / "static" / "dag-gantt-widget.js"
   ```

   ✅ vérifié : après `uv pip install <wheel>`, le fichier est bien dans
   `site-packages/airflow_dag_gantt/static/`.

2. **Garder l'URL logique inchangée** (`/dag-gantt-plugin/dag-gantt-widget.js`) et le
   `url_prefix` `/dag-gantt-plugin` : le bundle s'auto-appelle en same-origin
   (`API_URL = '/dag-gantt-plugin/api/runs'`, `js/src/DagGanttWidget.jsx:18`) → **aucune
   modif JS nécessaire**.

3. **Préfixer les routes en dur** : les décorateurs sont évalués à l'import, donc pas de
   `API_PREFIX = os.getenv(...)` pour les `bundle_url`/`url_prefix`. Un seul nom
   `"dag-gantt-plugin"` partout (constante partagée `plugin.py` ↔ `api.py` ↔ JS).

4. **`on_load(*args, **kwargs)`** : la signature exacte peut évoluer, la doc officielle
   recommande d'absorber `*args/**kwargs`. On l'ajoute pour logger la version du plugin
   (`logging.getLogger(__name__).info("dag-gantt %s loaded", __version__)`) — c'est aussi
   notre trace de diagnostic n°1 dans les logs de l'`api-server`.

Le reste (`RUN_LIMIT`, `_day_window`, jointure `DagTag`, `FileResponse` +
`Cache-Control: no-cache`) est repris tel quel : c'est déjà éprouvé.

---

## 3. Étape 2 — tests du paquet (dans le dépôt)

`tests/test_plugin_packaging.py`, à lancer dans un venv de dev
(`uv venv && uv pip install -e .` **après** `bun run build`, puis `uv run pytest`) :

| Test | Assertion |
| --- | --- |
| discovery | `entry_points().select(group="airflow.plugins")` contient `dag_gantt` et `entry_point.load()` renvoie une sous-classe de `AirflowPlugin` |
| enregistrement | `DagGanttPlugin.name == "dag_gantt"` ; `react_apps[0]["name"] == "Dag Gantt"` (⚠️ le nom dans `globalThis` doit être **exactement** celui du `react_apps`, cf. README §4.3) ; `bundle_url` == `/dag-gantt-plugin/dag-gantt-widget.js` == `url_prefix` + route JS |
| bundle présent | `static/dag-gantt-widget.js` existe, > 1 Ko, contient `globalThis` |
| contrat d'URL | la constante du plugin et `API_URL` de `js/src/DagGanttWidget.jsx` sont cohérentes (lecture du fichier JS + regex) |
| API | `TestClient(app).get("/api/runs?date=2026-11-09")` → 200 et clés `{date,window,count,truncated,runs}` ; `date=11/09` → 422 (pattern Query) — **sans BDD** : skip si `create_session()` échoue |

Et la commande de diagnostic, à documenter partout :

```bash
airflow plugins --verbose      # doit lister dag_gantt avec source "$ENTRY_POINT/…"
```

---

## 4. Étape 3 — le Dockerfile (la vraie cible du brief)

```dockerfile
# ⚠️ CORRIDÉ À L'EXÉCUTION (§9, correction C1) : l'utilisateur de l'image est `astro`
# (uid 50000, membre du groupe root mais site-packages en r-x) → `pip install` en `astro`
# retombe en `--user`. Il faut passer par `USER root`, comme les étapes ONBUILD de l'image.
FROM astrocrpublic.azurecr.io/runtime:3.3-12
COPY dist/ /tmp/plugin-dist/
USER root
RUN pip install --no-cache-dir /tmp/plugin-dist/airflow_dag_gantt-*.whl && rm -rf /tmp/plugin-dist
USER astro
```

- ~~le groupe/uid `airflow` est celui utilisé par l'image~~ → **faux** : `id: ‘airflow’: no
  such user`, l'utilisateur est **`astro`** (uid/gid 50000, `groups=50000,0`) ; le `HOME` est
  bien `/usr/local/airflow` et `plugins_folder` `/usr/local/airflow/plugins` ✅ ;
- ✅ `pip` est présent dans l'image (pip 26.3, Python 3.14.10) ;
- ⚠️ **`dist/` ne doit pas être dans `.dockerignore`** ; et `dist/` doit être dans
  `.gitignore` (artefact, pas de source). Le build Docker prend la wheel **locale** ;
- ✅ dans l'image, `pip install` d'une wheel ne déclenche **aucun** build backend → bun
  n'est pas requis (contrairement à une install depuis les sources, §1).

Variante « zéro artefact » pour la CI (à mentionner, pas à faire maintenant) :
`COPY . .` + `RUN cd js && bun install && bun run build` +
`RUN DAG_GANTT_JS_DIR=js/dist pip install --no-cache-dir .` — image de build avec bun,
plus lente, mais rien à publier.

---

## 5. Étape 4 — **le second projet Astro** (validation croisée)

C'est la partie « est-ce que ça marche ailleurs que chez moi ». Créé à l'exécution, hors du
dépôt du plugin :

```bash
cd /home/dgwp7942/Documents/codes_antoine/airflow
mkdir -p gantt-consumer && cd gantt-consumer
astro dev init                      # squelette : dags/, plugins/, requirements.txt, Dockerfile
mkdir dist                          # destination de la wheel (lisible par le build Docker)
```

> `astro dev init` peut vouloir résoudre/télécharger l'image de release ; si le réseau interne
> bloque (`astronomer-public.blob.core.windows.net` ne se résout **pas** depuis ce poste ✅),
> on écrit le squelette à la main (4 fichiers : `.astro/config.yaml`, `Dockerfile` avec le même
> `FROM`, `requirements.txt`, `dags/`) — c'est le plan B, 3 minutes.
>
> ✅ **à l'exécution : `astro dev init` est passé sans problème** (Astro CLI 1.47, réseau
> interne) — le plan B n'a pas servi.

### 5.1 Procédure d'installation (la seule qui marche avec Astro)

> **🛑 CORRIDÉ À L'EXÉCUTION (§9, correction C2)** — la procédure ci-dessous **ne marche
> pas**. Les hooks ONBUILD de l'image runtime font `COPY requirements.txt .` →
> `install-python-dependencies` → **puis seulement** `COPY --chown=astro:0 . .` : la wheel
> listée dans `requirements.txt` n'existe pas encore au moment du `pip install`
> (`error: Distribution not found at: file:///usr/local/airflow/dist/airflow_dag_gantt-0.1.0-py3-none-any.whl`).
> **La wheel s'installe dans le `Dockerfile` du projet consommateur** (bloc §4, qui
> s'exécute avant les ONBUILD) — c'est ce qui a été validé. La note 6 du §0.3 allait donc
> dans le sens inverse de la réalité.

Un projet Astro installe `requirements.txt` **au build de son image** ; il faut donc la wheel
**avant** `astro dev start` :

```bash
# 1. builder le plugin
cd ../airflow-advent-calendar && ./build.sh                     # → dist/airflow_dag_gantt-0.1.0-py3-none-any.whl

# 2. la déposer dans le projet consommateur
cp dist/*.whl ../gantt-consumer/dist/

# 3. la déclarer comme dépendance (chemin RELATIF à la racine du projet Astro)
printf './dist/airflow_dag_gantt-0.1.0-py3-none-any.whl\n' > ../gantt-consumer/requirements.txt
#   → passé au `pip install` du build Docker depuis /usr/local/airflow ; à vérifier au build,
#     variante si refusée : file:///usr/local/airflow/dist/…whl

# 4. image sans le plugins/ du plugin (on ne copie QUE ce qu'on veut) : vérifier que
#    gantt-consumer/plugins/ est vide → pas de doublon de `name`

# 5. démarrer
cd ../gantt-consumer && astro dev start
```

### 5.2 Vérifications (dans l'ordre, avec le résultat attendu)

```bash
# a. le paquet est dans l'image
astro dev run pip show airflow-dag-gantt                     # Version: 0.1.0

# b. Airflow le découvre via l'entry point  ← LE test décisif
docker exec gantt-consumer-<hash>-api-server-1 airflow plugins --verbose
#   attendu : ligne « dag_gantt » + source $ENTRY_POINT/dag_gantt ; PAS de $PLUGINS_FOLDER

# c. l'API répond (montée à la racine sous son url_prefix, sans auth)
docker exec gantt-consumer-<hash>-api-server-1 \
  curl -s localhost:8080/dag-gantt-plugin/api/runs | head -c 200
docker exec gantt-consumer-<hash>-api-server-1 \
  curl -sI localhost:8080/dag-gantt-plugin/dag-gantt-widget.js | head -3   # 200, application/javascript

# d. l'UI : Parcourir → Dag Gantt (catégorie browse) — thème/branding natifs attendus
```

Puis alimenter la vue sans copier le code du plugin :

```bash
cp ../airflow-advent-calendar/dags/gantt_demo.py dags/
astro dev run dags unpause gantt_demo_finance
astro dev run dags trigger gantt_demo_slow
```

### 5.3 Les 3 échecs probables, et comment les lire

| Symptôme | Cause probable | Preuve à regarder |
| --- | --- | --- |
| `airflow plugins` ne liste pas `dag_gantt` | wheel non installée dans **cette** image (requirements.txt non reconstruit) | `astro dev run pip show airflow-dag-gantt` ; logs `astro dev start` (section pip install) |
| `dag_gantt` listé mais page 404 / bundle manquant | `static/` absent du wheel (`artifacts` oublié) ou `BUNDLE_PATH` encore pointé sur l'ancien chemin | `docker exec … python -c "import airflow_dag_gantt as p,pathlib;print(list((pathlib.Path(p.__file__).parent/'static').iterdir()))"` |
| entrée de menu absente | `lazy_load_plugins` **ou** mismatch de nom : `react_apps[0].name` ≠ clé `globalThis` (ici `'Dag Gantt'`, `js/src/index.js:3`) | `airflow config get-value core lazy_load_plugins` (= `False` dans `3.3-12` ✅) ; console navigateur sur l'`import()` du bundle |

### 5.4 Ce que **ce** test prouve — et ce qu'il ne prouve pas

- ✅ que le plugin n'a **plus aucune dépendance au dossier `plugins/`**, ni au dépôt
  d'origine : le projet consommateur ne contient que la wheel + un DAG de démo ;
- ✅ que l'entry point est la voie de découverte réelle (b) ;
- ✅ que l'`api-server` voit le plugin (c) — **c'est exactement le point du brief** qui
  échouait en Kubernetes avec le montage de dossier ;
- ❌ **pas** le Helm Chart officiel `apache/airflow` ni le montage S3. Étape de validation
  suivante (hors de ce plan, mais notée) : `FROM apache/airflow:3.3.2` +
  `uv pip install ./dist/*.whl` + `AIRFLOW__CORE__PLUGINS_FOLDER=` vide, et vérifier
  `airflow plugins`. Ça prouverait l'indépendance vis-à-vis d'Astronomer.

---

## 6. Étape 5 — finishing (court)

1. **README** : nouveau § « 8. Distribuer le plugin comme paquet pip » — installation
   (`uv pip install`, wheel, `git+ssh`), entry point, `airflow plugins --verbose`, tableau
   « `plugins/` vs paquet » (dont la colonne « atteint l'api-server en K8s ? »), et
   l'option A du brief (volumes Helm) en note d'ops ;
2. **Version** : `0.1.0` en dur dans `pyproject.toml` + `__init__.py`, ou hatch-vcs
   (`[tool.hatch.version] source = "vcs"` + tags `v0.1.0`) — ⚠️ avec hatch-vcs, `uv build`
   **depuis un checkout sans tag** donne `0.0.x` : à ne choisir que si on te tag tout de suite.
   Par défaut : version en dur, bump manuel.
3. **`.gitignore`** : `dist/`, `src/airflow_dag_gantt/static/`, `js/node_modules/` ;
   **`.dockerignore`** : `js/src`, `js/node_modules`, `tests`, `plans`, `docs`, `.git` —
   **jamais `dist/`** ;
4. `requirements.txt` : commentaire pointant vers le paquet (les requirements Astro restent
   le lieu des *autres* dépendances) ;
5. rien n'est poussé : `git add`/`git commit` **uniquement sur demande**, push = toi.

## 7. Ordre d'exécution et critères d'acceptation

| # | Action | Critère d'acceptation |
| --- | --- | --- |
| 1 | `js/`, `src/airflow_dag_gantt/`, `pyproject.toml`, `hatch_build.py`, `build.sh` | `./build.sh` produit `dist/airflow_dag_gantt-0.1.0-py3-none-any.whl` dont `unzip -l` montre `airflow_dag_gantt/static/dag-gantt-widget.js` **et** `entry_points.txt` |
| 2 | `plugin.py` + `api.py` (chemin `static/`, routes, `on_load`) | `pytest tests/test_plugin_packaging.py` passe (5 tests, dont discovery) |
| 3 | `Dockerfile` (+ `.dockerignore`) | `docker build .` réussit ; `docker run --rm <img> airflow plugins --verbose` liste `dag_gantt` |
| 4 | second projet `gantt-consumer` | §5.2 a→d : `pip show`, `airflow plugins` (`$ENTRY_POINT`), `curl` 200, **page Dag Gantt rendue avec le thème natif** |
| 5 | suppression de `plugins/dag_gantt_plugin.py` + `plugins/react-src-dag-gantt/`, README | dans le dépôt d'origine (`astro dev start`, wheel déclarée dans `requirements.txt`), le Gantt marche **sans** aucun fichier `plugins/*gantt*`, et l'Advent Calendar marche toujours |

**Non régression** : `astro dev pytest` (intégrité des DAGs) passe ; l'Advent Calendar
(navigue toujours via `plugins/advent_calendar_plugin.py`) est inchangé.

## 8. Risques / décisions ouvertes

| Risque | Mitigation |
| --- | --- |
| `astro dev init` bloqué par le réseau (registry de releases injoignable, ✅ testé) | squelette écrit à la main (5 fichiers), même `FROM` |
| chemin de wheel relatif refusé par le `pip install` du build Astro | variante `file:///usr/local/airflow/dist/…whl`, ou `COPY` de la wheel dans le `Dockerfile` du projet consommateur |
| version Astro CLI de release différente → image de base implicite | épingler le `FROM` explicite dans le `Dockerfile` du consommateur (`3.3-12`, celle qui marche ici) |
| double plugin (résidu `plugins/` + paquet) | étape 5 obligatoire ; `airflow plugins` montre lequel gagne (« first wins ») |
| le brief parle de S3/Helm : ce plan ne le couvre pas | §5.4 — validation Helm/chart = plan suivant, le paquet pip en est le prérequis |
| `react_apps` est marqué *expérimental* par la doc 3.4 | on ne change pas le contrat (`bundle_url` + `globalThis`) ; un bump d'Airflow 3.x reste un risque assumé, le test de discovery ne le détectera pas |

---

## 9. Bilan d'exécution (2026-11-09)

### 9.1 Critères d'acceptation du §7

| # | Action | Résultat |
| --- | --- | --- |
| 1 | layout paquet + `pyproject.toml` + hook + `build.sh` | ✅ `./build.sh` → `dist/airflow_dag_gantt-0.1.0-py3-none-any.whl` ; `unzip -l` montre `airflow_dag_gantt/static/dag-gantt-widget.js` **et** `entry_points.txt` (`[airflow.plugins] dag_gantt = airflow_dag_gantt.plugin:DagGanttPlugin`). Bonus vérifié : sans `DAG_GANTT_JS_DIR` le wheel **échoue** avec le message attendu ; l'**sdist reste buildable sans bun** (39 Ko, sans `node_modules`) |
| 2 | `plugin.py` + `api.py` + tests | ✅ `pytest tests/test_plugin_packaging.py` → **7 passed** (dans l'image runtime 3.3-12, `pip install` de la wheel, **contre le Postgres réel** du projet). Sans BDD initialisée : 6 passed + 1 skip (le garde-fou sonde `SELECT count(*) FROM dag_run`, pas juste `create_session()`) |
| 3 | `Dockerfile` + `.dockerignore` | ✅ `docker build .` réussit ; le build **auto-vérifie** l'entry point (`entry point ok: ['astronomer_runtime', 'dag_gantt', 'openlineage']`) ; `docker run --entrypoint airflow <img> plugins --verbose` → `dag_gantt \| source airflow-dag-gantt==0.1.0: EntryPoint(...)` et la trace `on_load` « dag-gantt 0.1.0 loaded » |
| 4 | second projet `gantt-consumer` (sans aucune source du plugin) | ✅ a) `pip show airflow-dag-gantt` → 0.1.0 ; ✅ b) `airflow plugins --verbose` dans l'**api-server** → source = entry point, aucun `$PLUGINS_FOLDER` ; ✅ c) `curl localhost:8080/dag-gantt-plugin/api/runs` → 200 JSON (**35 runs**, tags inclus), bundle → `200 application/javascript` 12 674 o ; ✅ `GET /api/v2/plugins` expose `dag_gantt → ('Dag Gantt', '/dag-gantt-plugin/dag-gantt-widget.js', 'browse', 'dag-gantt')`. ⚠️ reste **d)** : le rendu visuel dans le navigateur (à faire à l'œil, §9.4) |
| 5 | suppression des fichiers `plugins/*gantt*` + README | ✅ dans le dépôt d'origine redémarré (`astro dev stop && astro dev start`) : `plugins/` ne contient plus que `advent_calendar_plugin.py` + `react-src-advent/` ; `airflow plugins` → `dag_gantt` en `$ENTRY_POINT`, `advent_calendar_plugin` en `$PLUGINS_FOLDER` ; les 4 routes (2 Gantt + 2 Advent) → **200** ; `/api/v2/plugins` liste les deux `react_apps` |

### 9.2 Corrections apportées au plan par l'exécution

| # | Le plan disait | La réalité (vérifiée) |
| --- | --- | --- |
| **C1** | §4 : `USER airflow` + `COPY --chown=airflow:root` | L'image runtime `3.3-12` n'a **pas** d'utilisateur `airflow` : `id: ‘airflow’: no such user`, l'utilisateur est **`astro`** (uid 50000, `groups=50000,0`) et `/usr/local/lib/python3.14/site-packages` est `root:root drwxr-xr-x` → en `astro`, pip installe en `--user`. **Il faut `USER root`** pour le `pip install`, puis revenir en `USER astro` (c'est exactement ce que font les hooks ONBUILD `packages.txt`/`requirements.txt` de l'image) |
| **C2** | §5.1 / §0.3 note 6 : déclarer la wheel dans `requirements.txt` du projet consommateur | **Impossible.** L'ordre réel des hooks ONBUILD est `COPY packages.txt` → `USER root` → `install-system-packages` → `COPY requirements.txt .` → `install-python-dependencies` → `USER astro` → `COPY --chown=astro:0 . .` : le `pip install` des requirements ne voit **que** `requirements.txt`. Échec reproduit : `error: Distribution not found at: file:///usr/local/airflow/dist/airflow_dag_gantt-0.1.0-py3-none-any.whl`. ⇒ la wheel s'installe **dans le `Dockerfile`** du projet (qui s'exécute avant les ONBUILD), et `dist/` reste absent du `.dockerignore` |
| **C3** | §2.2 : classifier `Framework :: Apache Airflow :: Plugin` | hatchling rejecte : `ValueError: Unknown classifier` — ce sous-classifier n'existe pas dans PyPI. Garder seulement `Framework :: Apache Airflow` |
| **C4** | §2.2 : `artifacts = ["*/static/*"]` | Fonctionne, mais motif ancré préféré et plus strict : `["/src/airflow_dag_gantt/static/*"]`. Ajout nécessaire côté **sdist** : `exclude = ["/js/node_modules", "/js/dist", …]` et `/`-ancrage des `include` (sinon `include=["src"]` ratisse aussi `plugins/*/src`), et `node_modules` passait de 0 → 65 Mo dans l'sdist |
| **C5** | §3 : test API « skip si `create_session()` échoue » | Sur SQLite, `create_session()` **réussit** en créant un fichier vide → le test échouait (`no such table: dag_run`). La sonde doit exécuter la vraie requête (`select(func.count()).select_from(DagRun)`) |
| **C6** | §5.2 b/c : `airflow plugins --verbose` et le bundle | `curl -sI` du bundle → **405** (la route FastAPI n'expose que GET) ; la source affichée par `airflow plugins` est `airflow-dag-gantt==0.1.0: EntryPoint(...)` (pas le littéral `$ENTRY_POINT`) ; et **l'API qui alimente la nav est `GET /api/v2/plugins`** — `/ui/react_apps` retombe sur le SPA (`index.html`), c'est le bon endpoint à tester en curl |
| **C7** | §0.3 note « `astro dev init` peut être bloqué par le réseau » | `astro dev init` est passé normalement (Astro CLI 1.47) ; plan B non nécessaire |

### 9.3 Efforts de bord rencontrés (hors périmètre, mais à connaître)

- **`astro dev pytest` est cassé pour une raison préexistante et sans rapport** : le `.env`
  local contient `AIRFLOW__API__THEME` en JSON multiligne → `docker: --env-file: invalid env
  file (.env): variable '"tokens": {' contains whitespaces`. Les tests ont donc été lancés via
  `docker run` sur l'image du projet (même interpréteur, mêmes dépendances).
- **Un nouveau fichier de DAG n'est pas détecté à chaud** par le `dag-processor`
  (Astro 1.47 / Airflow 3.3.2+astro.3) : le manager ne rescinde pas son inventaire →
  `docker restart <projet>-dag-processor-1`. Sans lien avec le packaging.
- Le `COPY --chown=astro:0 . .` des hooks ONBUILD recopie `dist/` dans `$AIRFLOW_HOME`
  (15 Ko, cosmétique) : impossible de l'éviter proprement puisque la wheel doit être lisible
  par notre propre `COPY`.
- `ruff` (config globale du poste) et `ruff format` sont passés sur `src/`, `tests/`,
  `hatch_build.py` ; config projet ajoutée dans `pyproject.toml` (`select` restreint,
  `extend-exclude = ["tests/dags"]` — squelette généré par Astro).

### 9.4 Ce qui reste à faire

1. **d) du §5.2, à l'œil** : ouvrir <http://gantt-consumer.localhost:6563> (proxy Astro,
   vhost → api-server mappé sur `127.0.0.1:17462`) → **Parcourir → Dag Gantt** : vérifier
   l'entrée de menu, le rendu du bundle et le thème natif. Projet laissé **démarré** pour ça
   (`astro dev stop` dans `../gantt-consumer` quand terminé).
2. Rien n'est poussé : `git add`/`git commit` en attente d'une demande explicite, push = toi.
3. Plan suivant (§5.4) : `FROM apache/airflow:3.3.2` + `uv pip install ./dist/*.whl` +
   `AIRFLOW__CORE__PLUGINS_FOLDER` vide → prouver l'indépendance vis-à-vis d'Astronomer, puis
   Helm Chart `apache/airflow`.
