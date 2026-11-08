# 🧪 Airflow 3 Plugins Lab

Un **laboratoire de plugins pour Apache Airflow 3** : un dépôt qui démarre comme un espace
d'expérimentation et produit des plugins réutilisables, livrés directement dans l'UI
d'Airflow. Le premier-né : **Global Dag Gantt**, une vue macro de tous les runs de la
journée sur une ligne de temps unique.

Le projet est né d'un fork de l'[airflow-advent-calendar de Tamara Fingerlin][tamara],
utilisé comme référence de bout en bout (squelette Astro, plugin Python FastAPI, bundle
React) — puis prolongé avec des plugins à valeur opérationnelle.

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

### 1.2 Advent Calendar 🎄 — la source d'inspiration

L'[advent calendar de Tamara Fingerlin][tamara] est un plugin Airflow 3 festif : 24 DAGs
(`day_1` … `day_24`), une fenêtre par jour de décembre ; exécuter le DAG du jour « ouvre »
la fenêtre du calendrier dans l'UI.

![Advent Calendar](./docs/advent_calendar.png)

Au-delà du fun, c'est une **préfiguration didactique de nos besoins pros** : un état lu
en base (les DAGs réussis) → rendu custom dans l'UI Airflow, sans toucher au cœur
d'Airflow. Même mécanique dans le Gantt : « une fenêtre ouverte » ↔ « un run exécuté »,
seule la restitution visuelle change. Le squelette technique (section `plugins/`,
registration `react_apps` + `fastapi_apps`, bundle React servi par le plugin) est issu
de ce projet, merci à elle ! 🙏

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

Le widget est écrit dans `plugins/react-src-dag-gantt/` (sources JSX) et compilé en **un
seul fichier** `dist/dag-gantt-widget.js`, car l'UI d'Airflow n'importe qu'un bundle.
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
cd plugins/react-src-dag-gantt
bun install      # une fois (installe webpack/babel — uniquement pour le build)
bun run build    # compile dist/dag-gantt-widget.js — rafraîchit sans redémarrer Airflow
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
astro dev start                      # UI : http://localhost:8080 (admin/admin)

# 2. Volet Advent Calendar : lancez le DAG du jour (day_<jour>) puis
#    Parcourir → Advent Calendar

# 3. Volet Global Dag Gantt :
#    - alimenter la journée de démo :
astro dev run dags unpause gantt_demo_finance
astro dev run dags unpause gantt_demo_quality
astro dev run dags trigger gantt_demo_slow   # ~3 min : barre « running » qui s'étire
#    - puis Parcourir → Dag Gantt 🎉
```

Après une modification d'un plugin : frontend → simple `bun run build` ;
backend Python → `astro dev restart`.

## 6. Structure du dépôt

```text
dags/                    DAGs advent (day_1..day_24) + gantt_demo.py (données de démo)
plugins/
  advent_calendar_plugin.py     plugin calendrier de l'avent (source d'inspiration)
  dag_gantt_plugin.py           plugin Global Dag Gantt (API FastAPI + enregistrement React)
  react-src-advent/             sources React du calendrier (webpack + bun)
  react-src-dag-gantt/          sources React du Gantt (webpack + bun, externals globalThis)
src/img/                captures d'écran
plans/                  plans d'architecture des features
```

## 7. Et maintenant ?

Le lab est conçu pour accueillir les prochains plugins. Pistes : durcir l'API du Gantt
(`GetUserDep`), fenêtre glissante multi-jours, surcouche « criticité » par tag, panneaux
`dashboard`… La tuyauterie (FastAPI + bundle externé) est déjà éprouvée : chaque nouveau
plugin ne coûte qu'un fichier Python, un dossier React et un `bun run build`.

---

_Base de départ : [airflow-advent-calendar](https://github.com/TJaniF/airflow-advent-calendar)
de Tamara Fingerlin ([docs](https://medium.com/tamarafingerlin/airflow-advent-calendar-61112ec5049a)) —
exécutée ici sur Astro Runtime `3.3-12` (Airflow 3.3)._

[tamara]: https://github.com/TJaniF/airflow-advent-calendar
