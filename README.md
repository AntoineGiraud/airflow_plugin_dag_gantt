# 📊 Global Dag Gantt — plugin Airflow 3

Un plugin **Airflow 3** qui affiche **tous les runs de la journée, tous DAGs confondus**,
sur une seule ligne de temps — et qui se distributed comme un **vrai paquet pip**, découvrable
automatiquement par Airflow (aucun fichier à déposer dans `plugins/`).

Le projet est né d'un fork de l'[airflow-advent-calendar de Tamara Fingerlin][tamara],
utilisé comme référence de bout en bout (squelette Astro, plugin Python FastAPI, bundle
React) — puis prolongé en un plugin à valeur opérationnelle. Voir [§1.2](#12-héritage--le-calendrier-de-lavent-de-tamara-)
: sans elle, rien de tout ceci.

---

## 1. Le projet

### 1.1 Global Dag Gantt 📊

**Problème.** Le Gantt natif d'Airflow est confiné à un seul DAG : impossible de voir
d'un coup d'œil ce qui s'est réellement passé sur la plateforme pendant une journée —
enchaînements, chevauchements, goulots d'étranglement entre DAGs.

**Réponse.** Un plugin qui affiche **tous les `DagRun` d'une journée** (tous DAGs
confondus) sur une timeline partagée :

![Global Dag Gantt](./docs/dag_gantt.png)

- **Une ligne par DAG**, une barre par run, positionnée et dimensionnée en temps réel ;
- **Couleurs et thème 100 % natifs** : le widget consomme le design system d'Airflow
  (voir [§4.3](#43-le-mécanisme-exernals--globalthis)) — branding de l'instance inclus ;
- **Filtres instantanés** (nom de DAG/run, tag, état) sans rappel serveur ;
- **Runs en cours** : la barre s'étire jusqu'à l'instant T, vue rafraîchie toutes les 30 s ;
- **Clic sur une barre** → ouverture de la page Grid du run.

**En pratique :** menu **Parcourir → Dag Gantt**, choix de la date, c'est tout.

### 1.2 Héritage — le calendrier de l'Avent de Tamara 🎄

Ce dépôt s'appelait `airflow-advent-calendar` : il est parti de l'[airflow-advent-calendar de
Tamara Fingerlin][tamara], un plugin festif où 24 DAGs (`day_1` … `day_24`) ouvrent autant de
fenêtres de décembre dans l'UI Airflow.

**Ce volet a été retiré du dépôt le 2026-11-09** (le repo est devenu le foyer du seul Global
Dag Gantt) : le plugin, ses 24 DAGs, ses sources React et ses visuels vivent désormais
1. dans le dépôt d'origine de Tamara, qui continue de recevoir les nouveautés —
   [TJaniF/airflow-advent-calendar][tamara] et son [article][tamara-article] ;
2. dans l'historique git de celui-ci (`git log --diff-filter=D -- plugins/ dags/day_1.py`).

**Ce qu'on lui doit, et qui est toujours là.** Au-delà du fun, son calendrier était une
**préfiguration didactique de nos besoins pros** : un état lu en base (les DAGs réussis) → un
rendu custom dans l'UI Airflow, sans toucher au cœur d'Airflow. Le Gantt reprend exactement
cette mécanique — « une fenêtre ouverte » ↔ « un run exécuté » — et toute la tuyauterie :
enregistrement `react_apps` + `fastapi_apps`, bundle React servi par le plugin, `externals`
vers les librairies de l'hôte ([§4](#4-crer-un-plugin-react-pour-airflow-3-vulgarisation)).
Même le `bun` du build vient de là. Merci Tamara 🙏 — et place maintenant à un plugin qui se
`pip install`.

---

## 2. Airflow en 5 lignes (pour les néophytes)

[Apache Airflow](https://airflow.apache.org/) est un **ordonnanceur de workflows en
code Python** : on y décrit des **DAGs** (graphes de tâches), l'outil planifie, exécute,
réessaie et surveille. Les composants à connaître : le **scheduler** (déclenche les runs),
les **dag-processor(s)** (lisent vos fichiers de DAGs), les **workers** (exécutent les
tâches), le **metadata database** (PostgreSQL… — toute l'histoire des exécutions, source
de nos plugins !), et l'**API + UI web** (React, thème Chakra UI). Un **plugin** est du
code déposé dans un dossier `plugins/` : il peut exposer une API FastAPI et une page
React ajoutée à la navigation de l'UI, sans forkner Airflow.

## 3. Astronomer Astro CLI (pour les néophytes)

[Astro CLI](https://www.astronomer.io/docs/astro/cli/install-cli) encapsule un projet
Airflow local dans **Docker Compose** : un dossier de projet (`dags/`, `plugins/`,
`include/`, `requirements.txt`), quelques commandes, et un environnement complet
(Airflow 3 + Postgres) démarre sur votre poste. Les commandes utiles d'`astro dev` :

| Commande                              | À quoi ça sert                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `astro dev start`                     | démarre toute la stack (UI sur <http://localhost:8080>, admin/admin)                                                         |
| `astro dev restart`                   | redémarre tout — **nécessaire après modif d'un plugin Python** (Airflow ne charge les plugins qu'au démarrage des processus) |
| `astro dev stop` / `astro dev kill`   | arrête (proprement / brutalement) l'environnement                                                                            |
| `astro dev run dags list`             | exécute une commande `airflow` **dans** le conteneur — ici : lister les DAGs                                                 |
| `astro dev run dags unpause <dag_id>` | réactive un DAG (les nouveaux DAGs naissent en pause)                                                                        |
| `astro dev run dags trigger <dag_id>` | déclenche un run — parfait pour alimenter le Gantt                                                                           |
| `astro dev pytest`                    | tests d'intégrité des DAGs (le harnais `.astro/test_dag_integrity_default.py`) — ce dépôt lui préfère `pytest -q tests`   |

💡 Astuce : un **nouveau fichier de DAG** peut mettre du temps à être découvert
(`dag_discovery_safe_mode`) ; un `docker restart <projet>-dag-processor-1` force la
re-découverte.

## 4. Créer un plugin React pour Airflow 3 (vulgarisation)

### 4.1 Deux moitiés

Un plugin Airflow 3 « avec écran », c'est :

1. **une app FastAPI** (Python) déclarée via `fastapi_apps` : elle sert l'API de données
   **et** le fichier JS du widget ;
2. **un bundle React** (JS) déclaré via `react_apps` : l'UI d'Airflow le charge avec un
   `import()` natif et affiche le composant trouvé sur `globalThis` (nommé d'après le
   `name` du plugin, fallback `globalThis.AirflowPlugin`).

L'app FastAPI est **montée à la racine** de l'URL d'Airflow sous son `url_prefix`
(ici `/dag-gantt-plugin`), donc le widget la rappelle en same-origin — pas de CORS.

### 4.2 Le build : webpack + **bun**

Le widget est écrit dans `js/` (sources JSX) et compilé en **un seul fichier**
`js/dist/dag-gantt-widget.js`, car l'UI d'Airflow n'importe qu'un bundle. Ce bundle est
ensuite **embarqué dans le paquet Python** (`airflow_dag_gantt/static/`) par le hook de
build hatchling — voir [§7](#7-distribuer-le-plugin-comme-paquet-pip-uv--pip).
Le tour de magie du build, c'est la config `externals` :

```js
externals: {
  react: 'React',            // window.React fourni par l'UI Airflow
  '@chakra-ui/react': 'ChakraUI',   // idem — et le thème de l'instance !
  'react-router-dom': 'ReactRouterDOM',
  // …
}
```

**bun** remplace npm/yarn ici : c'est un gestionnaire de paquets + exécuteur de scripts
**beaucoup plus rapide**, 100 % compatible avec l'écosystème npm
(`bun install` ↔ `npm install`, `bun run build` ↔ `npm run build`). Le `bun.lock` du
repo fige les versions.

```bash
cd js
bun install      # une fois (installe webpack/babel — uniquement pour le build)
bun run build    # compile js/dist/dag-gantt-widget.js
bun run dev      # idem, en --watch et non minifié
```

> ⚠️ Ce qui précède est le cycle de **livraison** (`bun run build` → wheel → image). Pour
> **travailler**, surtout ne pas repayer ce cycle : `./dev.sh watch` pousse le bundle dans le
> conteneur qui tourne en ~1,2 s, sans restart ni wheel ([§5.1](#51-contribuer-au-plugin--la-boucle-de-feedback-mesurée)).

### 4.3 Le mécanisme « externals + globalThis »

L'UI d'Airflow 3.3 **expose ses propres bibliothèques** sur `globalThis`
(`React`, `ChakraUI`, `ReactRouterDOM`…). Grâce aux `externals`, notre bundle ne contient
**aucune librairie** (~12 Ko) et consomme celles de l'hôte : mêmes versions, **mêmes
couleurs et composants Chakra que l'UI native** — y compris un branding d'entreprise
personnalisé. Un faux plugin de 10 lignes suffirait :

```jsx
// src/MonWidget.jsx  →  import React from 'react'; export default () => <h1>👋</h1>
// + un index.js qui fait  globalThis['Mon Nom'] = MonWidget;
```

…déclaré dans le plugin Python par `react_apps = [{"name": "Mon Nom",
"bundle_url": "/mon-plugin/mon-widget.js", …}]`. **Piège classique** : le nom dans
`globalThis` doit être _exactement_ le `name` du `react_apps`.

---

## 5. Démarrage rapide

```bash
# 1. Prérequis : Astro CLI (≥ 1.34) + Docker, et bun pour rebuilder le frontend (optionnel)
#    Python : 3.12 → 3.14. Inutile de chercher la bonne version : le runtime `3.3-12` vise
#    **Python 3.14 par défaut** (le `-12` est le patch du runtime Astro, PAS la version de Python)
#    — le conteneur de ce dépôt répond `py 3.14.10` / `airflow 3.3.2+astro.3`.
cp .env.example .env                 # config locale (nom d'instance + thème UI) : .env n'est pas versionné
./build.sh                           # bun + uv → dist/airflow_dag_gantt-0.2.0-py3-none-any.whl
astro dev start                      # l'image du projet installe la wheel (voir Dockerfile)

# 2. Alimenter la journée de démo :
astro dev run dags unpause gantt_demo_finance
astro dev run dags unpause gantt_demo_quality
astro dev run dags trigger gantt_demo_slow   # ~3 min : barre « running » qui s'étire

# 3. Parcourir → Dag Gantt 🎉
```

C'est tout : **il n'y a plus de dossier `plugins/`** (ni `include/`) dans ce dépôt, le plugin
vient du paquet ([§7](#7-distribuer-le-plugin-comme-paquet-pip-uv--pip)) — donc pas de
« modifier le fichier et redémarrer » : la boucle de contribution se joue en [§5.1](#51-contribuer-au-plugin--la-boucle-de-feedback-mesurée).

### 5.1 Contribuer au plugin : la boucle de feedback (mesurée)

Deux moitiés, deux lois physiques différentes — c'est ça qui structure le `dev` (les délais
ci-dessous sont mesurés sur ce poste, à valider chez vous) :

| Ce que vous changez | Ce qui doit recharger | Délai mesuré |
| --- | --- | --- |
| **JS/JSX** (`js/src/`) | rien du côté Airflow : `api.py` sert le bundle par `FileResponse`, **relu à chaque requête** (+ `cache-control: no-cache, no-store`) → l'`astro dev restart` est inutile | **1,2 s** (`./dev.sh js`) + refresh navigateur |
| **Python** (`api.py`, `plugin.py`) | le **processus** Airflow : Airflow ne charge les plugins (entry points) qu'au démarrage | **8,5 s** (`./dev.sh py`) |
| **Packaging / `Dockerfile` / `pyproject.toml`** | l'image entière | **~20 s** (`./dev.sh full`) |

Autrement dit : le composant React n'a **pas** de HMR, et ce n'est pas un accident —
`react_apps[].bundle_url` est monté par l'UI Airflow qui recharge le widget de zéro à chaque
navigation. Un refresh à 1,2 s vaut largement un Fast Refresh, et ça évite le piège du
dev-server : `react`/`react-dom`/`@chakra-ui/react`/`@emotion/react` sont en
[`externals`](js/webpack.config.js) et viennent du `globalThis` de l'hôte
([§4.3](#43-le-mécanisme--externals--globalthis)). Servir le bundle depuis un
webpack-dev-server du poste dupliquerait une **seconde** instance de React dans la page —
exactement le crash de hooks/thème qu'on a évité en son temps. À ré-ouvrir seulement si la
boucle de 1,2 s devient le goulot (le vrai chantier est alors CORS + globals partagés).

Le seul vrai goulot est donc le redémarrage du processus pour la partie Python : 5-8 s,
pas 2 minutes — et uniquement quand on touche aux **métadonnées** du plugin
(`react_apps`, `url_prefix`, routes FastAPI).

### 5.2 `dev.sh` : la boucle courte, sans reconstruire l'image

```bash
./dev.sh watch             # terminal 1 : webpack --watch + copie auto à chaque compile
./dev.sh js                # ou à la main : bundle (1,2 s) → Ctrl+Shift+R
./dev.sh py                # .py → site-packages + restart api-server (8,5 s) ; --all = 4 processus
./dev.sh full              # ./build.sh + astro dev restart (~20 s) ← LA VÉRITÉ, avant de committer
./dev.sh url               # URL directe de l'api-server (le port est réattribué à chaque restart)
./dev.sh api 2026-11-09    # le contrat JSON sans ouvrir le navigateur
./dev.sh logs              # journal de l'api-server
```

`dev.sh` retrouve **lui-même** le bon conteneur (celui dont le `dags/` monté est celui de ce
dépôt) — utile quand plusieurs environnements `astro dev` tournent en parallèle.

> ⚠️ `js`, `watch` et `py` écrivent **dans le conteneur** : c'est jetable. `astro dev
> restart`/`kill` ou un rebuild d'image remettent le paquet de la wheel à l'identique. Deux
> conséquences : (1) un bug vu seulement en loop courte peut disparaître tout seul au restart
> — valider par `./dev.sh full` avant de committer ; (2) le bundle en loop courte est celui
> de `webpack --mode development` (non minifié, stack traces lisibles) — le `LICENSE.txt` et
> l'empreinte du bundle de prod ne sont comparables qu'après `./build.sh`.

> ⚠️ Deux particularités locales vérifiées : `astro dev pytest` est cassé par le thème JSON
> multiligne de `.env` (refusé par `docker run --env-file`) → lancer `pytest -q tests` avec
> `docker exec`/`docker run` sur l'image du projet (voir l'en-tête de
> `tests/test_plugin_packaging.py`) ; et un **nouveau** fichier de DAG n'est pas détecté à
> chaud → `docker restart <projet>-dag-processor-1`.

## 6. Structure du dépôt

```text
pyproject.toml                    métadonnées du paquet + entry point airflow.plugins (py 3.12 → 3.14)
LICENSE                           MIT — embarquée dans le wheel (`license-files` du pyproject)
.env.example                      modèle de config locale → `cp .env.example .env` (`.env` est gitignoré)
hatch_build.py                    hook : câble js/dist → src/airflow_dag_gantt/static
build.sh                          purge dist/ + bun run build + uv build --wheel → dist/*.whl
dev.sh                            boucle de dev courte : pousser dans le conteneur qui tourne (§5.2)
Dockerfile                        runtime Astro + pip install de la wheel LOCALE (valide l'entry point)
.github/workflows/ci.yml          lint + résolution 3.12/3.13/3.14 + build/tests (Python 3.14)
src/airflow_dag_gantt/
  plugin.py                       DagGanttPlugin(AirflowPlugin)  ← cible de l'entry point
  api.py                          app FastAPI + requêtes SQLAlchemy
  static/                         bundle JS copié au build (gitignoré)
js/                               sources React du Gantt (webpack + bun, externals globalThis)
dags/gantt_demo.py                3 DAGs de démo (success / failed / running, tags)
tests/test_plugin_packaging.py    entry point, URLs, bundle, contrat d'API, cohérence de version
docs/                             capture d'écran
plans/                            plans d'architecture des features

(plus de plugins/ ni d'include/ : le plugin est un paquet — le but du §7 — et ce dépôt
n'a rien à injecter dans le `PYTHONPATH` du runtime ; `astro dev` ne monte plus que
`dags/` et `tests/`)
```

## 7. Distribuer le plugin comme paquet pip (`uv` / `pip`)

Le Global Dag Gantt n'est **plus** un fichier qui traîne dans `$AIRFLOW_HOME/plugins/` :
c'est un vrai paquet Python, `airflow-dag-gantt`, découvert automatiquement par Airflow via
l'entry point `airflow.plugins` :

```toml
[project.entry-points."airflow.plugins"]
dag_gantt = "airflow_dag_gantt.plugin:DagGanttPlugin"
```

`airflow.plugins_manager` fait `__register_plugins(*_load_entrypoint_plugins())` : ce qui est
chargé est **la classe** `AirflowPlugin`, instanciée sans argument, sur **chaque** composant.

| | `plugins/` (dossier) | **paquet pip** (ce plugin) |
| --- | --- | --- |
| atteint l'`api-server` en Kubernetes | ❌ (le montage `plugins/` manque → la page reste vide) | ✅ présent dans l'image, donc sur tous les pods |
| versionné / versionné sémantiquement | ❌ | ✅ `0.2.0` + wheel, version vérifiée en CI |
| dépendances déclarées | ❌ | ✅ `apache-airflow>=3.1` |
| installable dans un autre projet | ❌ (copie de fichiers) | ✅ wheel locale (`uv pip install --no-deps`), Nexus |
| testable hors Airflow | ❌ | ✅ `tests/test_plugin_packaging.py` |

### 7.1 Builder

```bash
./build.sh        # js/ → bun run build → DAG_GANTT_JS_DIR=js/dist uv build --wheel
# dist/airflow_dag_gantt-0.2.0-py3-none-any.whl   ← LA SEULE wheel de dist/
```

Quatre détails qui font la différence :

- le hook `hatch_build.py` **refuse** de produire un wheel sans bundle : pas d'UI cassée
  silencieusement (`DAG_GANTT_JS_DIR is required: run \`bun run build\`…`) ;
- `artifacts = ["/src/airflow_dag_gantt/static/*"]` dans `pyproject.toml` : `static/` est
  gitignoré, donc sans cette ligne hatch l'exclurait du wheel ;
- `uv build --wheel` et non `uv build` : l'sdist est écrit **avant** le wheel, un échec du
  hook laisserait un `.tar.gz` orphelin. L'sdist, lui, reste buildable **sans** bun — mais il
  n'est **pas installable** sans bun (même hook), donc il n'est jamais publié ;
- `build.sh` **purge `dist/*.whl`** avant de builder : avec deux wheels dans `dist/`, le
  `pip install …/airflow_dag_gantt-*.whl` du `Dockerfile` reçoit deux arguments et le build
  Astro tombe — piège classique juste après un bump de version.

### 7.2 Installer

> ⚠️ **`pip install airflow-dag-gantt` n'est PAS une commande de ce projet.** Le nom
> `airflow-dag-gantt` appartient sur PyPI public à **un autre plugin** (un autre Gantt pour
> Airflow 3, sans rapport avec celui-ci). Conséquence opérationnelle : ne jamais installer ce nom
> depuis PyPI, et **ne jamais mélanger** `--extra-index-url` PyPI public et un index interne qui
> publierait ce même nom — c'est la définition même de la [*dependency
> confusion*](https://blog.trailofbits.com/2019/04/02/attackers-can-leverage-name-confusion-to-hijack-private-packages/).
> Ce projet ne publie **nulle part** : il se consomme en wheel locale (§7.3).

```bash
# wheel locale — c'est LE mode de ce dépôt (et ce que consomme `./dev.sh full`).
# `--no-deps` : dans une image Astro/Airflow, apache-airflow est déjà présent ; sans ce drapeau,
# pip résoudrait `apache-airflow>=3.1` et ferait descendre un Airflow parallèle dans la couche.
uv pip install --no-deps ./dist/airflow_dag_gantt-0.2.0-py3-none-any.whl

# ❌ à connaître pour l'éviter : `pip install git+ssh://…@v0.2.0` échoue, et c'est voulu. Depuis
# les sources, le hook de build exige bun + `DAG_GANTT_JS_DIR` : `hatch_build.py` refuse de
# produire quoi que ce soit sans bundle. Une machine qui installe n'exécute donc AUCUN code de
# build — c'est précisément ce qu'on demande à un paquet qui se déploie dans un api-server.
```

Puis le diagnostic à connaître, à lancer **dans le conteneur/pod qui affiche l'UI** :

```bash
airflow plugins --verbose
# dag_gantt | … | source : airflow-dag-gantt==0.2.0: EntryPoint(name='dag_gantt', …)  ✅
#                            (et surtout PAS de $PLUGINS_FOLDER/dag_gantt_plugin.py)
```

### 7.3 Dans une image Docker

Un seul mode, le mode **local** : aucun egress au build, `./dev.sh full` fonctionne hors-ligne,
et la garantie d'intégrité vient du disque (c'est toi qui as buildé la wheel).

```dockerfile
FROM astrocrpublic.azurecr.io/runtime:3.3-12
COPY dist/ /tmp/plugin-dist/
USER root                     # site-packages n'est pas writable par astro (uid 50000)
RUN pip install --no-cache-dir /tmp/plugin-dist/airflow_dag_gantt-*.whl && rm -rf /tmp/plugin-dist
USER astro
```

Une **wheel** ne déclenche aucun build backend → bun n'est pas requis dans l'image. Une
installation **depuis les sources** (`pip install .`) l'exigerait, et échouerait si `js/dist`
n'a pas été buildé — c'est voulu.

> **Publier un jour ?** La piste est écrite au §8 (Release GitHub épinglée par sha256, ou
> PyPI **sous un autre nom**). Elle n'est **pas** implémentée : pour un POC dont le seul
> consommateur est la propre image du projet, un index public et une chaîne de signature ne
> payent pas leur loyer.

### 7.4 ⚠️ Piège spécifique à Astro CLI : la wheel ne peut PAS passer par `requirements.txt`

Vérifié sur Astro CLI 1.47 / runtime `3.3-12` : les hooks ONBUILD de l'image font
`COPY requirements.txt .` → `install-python-dependencies` → **puis seulement**
`COPY --chown=astro:0 . .`. Une wheel listée dans `requirements.txt` est donc introuvable au
moment du `pip install` :

```
error: Distribution not found at: file:///usr/local/airflow/dist/airflow_dag_gantt-0.2.0-py3-none-any.whl
```

**Il faut installer la wheel dans le `Dockerfile` du projet** (bloc §7.3), qui s'exécute avant
les ONBUILD, et déposer la wheel dans un `dist/` du projet consommateur — et surtout **pas**
dans `.dockerignore`.

### 7.5 Dépannage rapide

| Symptôme | Cause probable | Vérifier |
| --- | --- | --- |
| `airflow plugins` ne liste pas `dag_gantt` | wheel non installée dans **ce** pod | `pip show airflow-dag-gantt` |
| listé, mais page vide / bundle 404 | `static/` absent du wheel, ou `BUNDLE_PATH` mal pointé | `python -c "import airflow_dag_gantt as p,pathlib;print(list((pathlib.Path(p.__file__).parent/'static').iterdir()))"` |
| entrée de menu absente | `lazy_load_plugins=True` **ou** `react_apps[0].name` ≠ clé `globalThis` (`'Dag Gantt'`) | `airflow config get-value core lazy_load_plugins`, console du bundle |
| le plugin du dossier `plugins/` gagne | **premier nom gagné** : un `plugins/dag_gantt_plugin.py` résiduel éclipse le paquet | `airflow plugins --verbose` montre la source gagnante ; supprimer le résidu |
| un correctif « marche en local puis disparaît » | les copies de `./dev.sh js`/`py` sont **dans le conteneur** : `astro dev restart`/`kill` ou un rebuild remettent la wheel d'origine | `./dev.sh full` (ou `./build.sh && astro dev restart`) puis re-tester ; `pip show -f airflow-dag-gantt` |

> **Note d'ops (contournement, non retenu)** : sur un Helm Chart, `extraVolumes` /
> `extraVolumeMounts` pour monter `plugins/` sur l'`api-server` débloque la situation sans
> changer d'image, mais garde un dossier non versionné et impose un restart à chaque
> changement de code. Le paquet pip règle le problème à la racine.

### 7.6 Tests (et leur installation)

```bash
./build.sh
uv venv .venv && uv pip install --python .venv/bin/python dist/*.whl pytest httpx
AIRFLOW_HOME=$PWD/.airflow-home .venv/bin/airflow db migrate   # 2 s sur sqlite
AIRFLOW_HOME=$PWD/.airflow-home .venv/bin/pytest -q -rs tests   # → 8 passed
```

Installer **la wheel**, pas `-e .` : l'editable échoue sans `DAG_GANTT_JS_DIR` (le hook s'y
applique aussi) et, surtout, un editable ne teste pas l'artefact réellement livré. `httpx` est
requis par `fastapi.testclient` — sans lui, `test_api_runs_contract` se **tait** au lieu
d'échouer. Sans métadatabase, ce même test se skip (il sonde la vraie table `dag_run`) : d'où le
`db migrate` ci-dessus, et le `-rs` qui garde les skips visibles. Dans l'image Astro du projet,
`astro dev` monte `tests/` mais pas `js/` → deux tests se skipent, c'est attendu (en-tête de
`tests/test_plugin_packaging.py`).

## 8. Et maintenant ?

Le dépôt est la maison d'un plugin **paquet** — pas d'une plateforme. Ce qui est volontairement
**hors** du POC, et pourquoi :

- **publication** (Release GitHub, TestPyPI, PyPI, Nexus) : le seul consommateur du plugin est la
  propre image de ce projet, via `COPY dist/`. Un canal de distribution + ses gardes (attestations
  SLSA, immutability, Trusted Publishing, environment à revue humaine) ne payent leur loyer que
  quand quelqu'un **d'autre** installe l'artefact. La chaîne complète a été conçue, chiffrée en
  coûts et en risques, puis écartée : elle est capitalisée dans
  `plans/20261109_03_python-313-314-et-release-github.md` (annexe A). Si un jour le
  plugin se déploie ailleurs, la recette y est (tag → wheel → Release épinglée par `#sha256=` →
  attestations), y compris le fait que **le nom `airflow-dag-gantt` est pris sur PyPI** (§7.2) donc
  qu'il faudrait un autre nom pour un index public.
- ** Dependabot / osv-scanner** : les 5 actions de la CI sont épinglées par SHA, donc à remonter à
  la main (5 min, 4 fois par an). Le vrai risque de ce dépôt reste **npm/bun** — ce que produit
  webpack s'exécute dans l'UI Airflow — et `js/bun.lock` est versionné (`--frozen-lockfile` en CI).
- **matrice multi-Python d'exécution** : la CI prouve la **résolution** des métadonnées en
  3.12/3.13/3.14 et **l'exécution** en 3.14 (la version du runtime). Tester aussi la borne basse
  (`airflow 3.1` × Python 3.12) demanderait les `constraints-*` d'Airflow, donc 3 environnements
  complets — hors budget pour un POC.

Le reste des pistes produit : durcir l'API (`GetUserDep`), fenêtre glissante multi-jours, surcouche
« criticité » par tag, panneaux `dashboard`, validation sur le Helm Chart officiel `apache/airflow`
(voir `plans/`).

Côté outillage : le `./dev.sh watch` à ~1,2 s couvre aujourd'hui tout le confort utile. Si un
jour le frontend grossit au point de réclamer un vrai HMR, la piste n'est **pas** un
dev-server qui sert le bundle (deux React dans la page, cf. [§5.1](#51-contribuer-au-plugin--la-boucle-de-feedback-mesurée))
mais un `bundle_url` pointant vers une URL du poste avec les `externals` servis par une page
hôte qui singe l'UI Airflow — à creuser avec des chiffres, pas par goût du tooling.

---

## Remerciements 🎄

Ce projet est un dérivé de l'[**airflow-advent-calendar**][tamara] de **Tamara Fingerlin** —
[son article][tamara-article] explique la démarche complète. Tout le socle technique de ce
README (plugin FastAPI, bundle React `externals`, Astro + bun) vient de là, et son calendrier
festif reste la meilleure façon d'apprendre à injecter du custom dans l'UI d'Airflow 3. Le
volet advent a quitté ce dépôt ([§1.2](#12-héritage--le-calendrier-de-lavent-de-tamara-))
mais pas notre dette de reconnaissance 🙏 — pour le voir en action, c'est chez elle.

_Le tout tourne ici sur Astro Runtime `3.3-12` (Airflow 3.3.2+astro.3), testé aussi sur un
second projet Astro vierge consommant la wheel ([§7](#7-distribuer-le-plugin-comme-paquet-pip-uv--pip))._

[tamara]: https://github.com/TJaniF/airflow-advent-calendar
[tamara-article]: https://medium.com/tamarafingerlin/airflow-advent-calendar-61112ec5049a

[tamara]: https://github.com/TJaniF/airflow-advent-calendar
