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
| `astro dev pytest`                    | lance les tests d'intégrité des DAGs (`tests/dags/`)                                                                         |

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
repo fige les versions. Cycle de développement :

```bash
cd js
bun install      # une fois (installe webpack/babel — uniquement pour le build)
bun run build    # compile js/dist/dag-gantt-widget.js
# puis, pour le rendre visible d'Airflow :
DAG_GANTT_JS_DIR=js/dist uv build --wheel && astro dev restart
```

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
./build.sh                           # bun + uv → dist/airflow_dag_gantt-0.1.0-py3-none-any.whl
astro dev start                      # l'image du projet installe la wheel (voir Dockerfile)

# 2. Alimenter la journée de démo :
astro dev run dags unpause gantt_demo_finance
astro dev run dags unpause gantt_demo_quality
astro dev run dags trigger gantt_demo_slow   # ~3 min : barre « running » qui s'étire

# 3. Parcourir → Dag Gantt 🎉
```

Après une modification du plugin : `./build.sh` puis `astro dev restart` (la wheel est
réinstallée dans l'image). C'est tout : **il n'y a plus de dossier `plugins/`** dans ce dépôt,
le plugin vient du paquet ([§7](#7-distribuer-le-plugin-comme-paquet-pip-uv--pip)).

> ⚠️ Deux particularités locales vérifiées : `astro dev pytest` est cassé par le `.env` de ce
> poste (thème JSON multiligne refusé par `docker --env-file`) → lancer les tests via
> `docker run` sur l'image du projet ; et un **nouveau** fichier de DAG n'est pas détecté à
> chaud → `docker restart <projet>-dag-processor-1`.

## 6. Structure du dépôt

```text
pyproject.toml                    métadonnées du paquet + entry point airflow.plugins
hatch_build.py                    hook : câble js/dist → src/airflow_dag_gantt/static
build.sh                          bun run build + uv build --wheel → dist/*.whl
Dockerfile                        runtime Astro + pip install de la wheel (valide l'entry point)
src/airflow_dag_gantt/
  plugin.py                       DagGanttPlugin(AirflowPlugin)  ← cible de l'entry point
  api.py                          app FastAPI + requêtes SQLAlchemy
  static/                         bundle JS copié au build (gitignoré)
js/                               sources React du Gantt (webpack + bun, externals globalThis)
dags/gantt_demo.py                3 DAGs de démo (success / failed / running, tags)
tests/test_plugin_packaging.py    entry point, URLs, bundle, contrat d'API
docs/                             capture d'écran
plans/                            plans d'architecture des features

(plus de plugins/ : c'était précisément le but du §7)
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
| versionné / versionné sémantiquement | ❌ | ✅ `0.1.0`, wheel, registre interne |
| dépendances déclarées | ❌ | ✅ `apache-airflow>=3.1` |
| installable dans un autre projet | ❌ (copie de fichiers) | ✅ `uv pip install`, `git+ssh`, Nexus |
| testable hors Airflow | ❌ | ✅ `tests/test_plugin_packaging.py` |

### 7.1 Builder

```bash
./build.sh        # js/ → bun run build → DAG_GANTT_JS_DIR=js/dist uv build --wheel
# dist/airflow_dag_gantt-0.1.0-py3-none-any.whl
```

Trois détails qui font la différence :

- le hook `hatch_build.py` **refuse** de produire un wheel sans bundle : pas d'UI cassée
  silencieusement (`DAG_GANTT_JS_DIR is required: run \`bun run build\`…`) ;
- `artifacts = ["/src/airflow_dag_gantt/static/*"]` dans `pyproject.toml` : `static/` est
  gitignoré, donc sans cette ligne hatch l'exclurait du wheel ;
- `uv build --wheel` et non `uv build` : l'sdist est écrit **avant** le wheel, un échec du
  hook laisserait un `.tar.gz` orphelin. L'sdist, lui, reste buildable **sans** bun.

### 7.2 Installer

```bash
uv pip install ./dist/airflow_dag_gantt-0.1.0-py3-none-any.whl   # wheel locale (recommandé)
uv pip install "git+ssh://git@github.com/AntoineGiraud/airflow_plugin_dag_gantt.git@v0.1.0"  # ⚠ nécessite bun
pip install airflow-dag-gantt                                    # depuis un registre interne (Nexus/Artifactory)
```

Puis le diagnostic à connaître, à lancer **dans le conteneur/pod qui affiche l'UI** :

```bash
airflow plugins --verbose
# dag_gantt | … | source : airflow-dag-gantt==0.1.0: EntryPoint(name='dag_gantt', …)  ✅
#                            (et surtout PAS de $PLUGINS_FOLDER/dag_gantt_plugin.py)
```

### 7.3 Dans une image Docker

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

### 7.4 ⚠️ Piège spécifique à Astro CLI : la wheel ne peut PAS passer par `requirements.txt`

Vérifié sur Astro CLI 1.47 / runtime `3.3-12` : les hooks ONBUILD de l'image font
`COPY requirements.txt .` → `install-python-dependencies` → **puis seulement**
`COPY --chown=astro:0 . .`. Une wheel listée dans `requirements.txt` est donc introuvable au
moment du `pip install` :

```
error: Distribution not found at: file:///usr/local/airflow/dist/airflow_dag_gantt-0.1.0-py3-none-any.whl
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

> **Note d'ops (contournement, non retenu)** : sur un Helm Chart, `extraVolumes` /
> `extraVolumeMounts` pour monter `plugins/` sur l'`api-server` débloque la situation sans
> changer d'image, mais garde un dossier non versionné et impose un restart à chaque
> changement de code. Le paquet pip règle le problème à la racine.

## 8. Et maintenant ?

Le dépôt est désormais la maison d'un plugin **paquet** : chaque nouveau plugin coûte un
sous-projet `src/<paquet>/`, un dossier React, un entry point et un `build.sh`. Pistes pour
celui-ci : durcir l'API (`GetUserDep`), fenêtre glissante multi-jours, surcouche « criticité »
par tag, panneaux `dashboard`, publication sur un registre interne (Nexus/Artifactory) et
validation sur le Helm Chart officiel `apache/airflow` (voir `plans/`).

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
