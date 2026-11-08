# 📋 Master Plan : Plugin Airflow 3 - Global DAG Gantt

## Étape 0 : Introduction, Contexte et Stratégie

**Objectif fonctionnel :**
Le diagramme de Gantt natif d'Airflow est limité : il ne montre que les tâches (*TaskInstances*) au sein d'un seul et unique DAG. Le besoin est de créer une vue macro "Global Gantt" permettant de visualiser tous les `DagRun` d'une journée entière sur une même ligne de temps. L'objectif est d'aider les Data Engineers à repérer les goulots d'étranglement, les chevauchements d'exécutions globales, avec la possibilité de filtrer instantanément la vue par nom ou par "Tag" de DAG.

**Références et sources d'inspiration :**

* **Documentation officielle Airflow 3 (Plugins) :** L'architecture s'appuiera sur les nouveaux standards définis dans la doc [Apache Airflow Plugins - What For?](https://airflow.apache.org/docs/apache-airflow/3.3.2/administration-and-deployment/plugins.html#what-for).
* **Proof of Concept / Boilerplate :** Le dépôt GitHub de Tamara Fingerlin ([airflow-advent-calendar](https://github.com/TJaniF/airflow-advent-calendar)) sert de référence absolue pour la tuyauterie d'un plugin Airflow 3 (injection du bundle React via le paramètre `bundle_url` et exposition des données via `fastapi_apps`).
* **Discussions préalables :** L'architecture a été validée pour contourner les anciens mécanismes de Flask AppBuilder (dépréciés en v3) au profit du duo FastAPI / React.

**Capitalisation sur les composants Airflow existants :**
Afin de garder une cohérence visuelle parfaite avec l'UI d'Airflow 3 et de ne pas alourdir le plugin avec des librairies externes massives, nous allons :

1. **Réutiliser le moteur de Gantt natif :** S'inspirer fortement (ou forker intelligemment) le code source du composant React natif d'Airflow 3 (`GanttBar`, gestion de l'échelle de temps dynamique) en l'épurant de la logique des `TaskGroups` pour l'adapter à une structure plate de `DagRuns`.
2. **Réutiliser le thème :** Utiliser les composants et le système de design existant (Chakra UI, mapping des `STATE_COLORS` officiels d'Airflow pour les états *success*, *failed*, *running*).

---

## Étape 1 : Le Backend (FastAPI & SQLAlchemy)

L'objectif est de créer une API sécurisée embarquée dans le plugin qui renvoie les données nécessaires au frontend.

* **Endpoint :** Créer une route `GET /api/runs` via une application FastAPI.
* **Sécurité :** Utiliser la dépendance `GetUserDep` d'Airflow 3 (`airflow.api_fastapi.core_api.security.GetUserDep`) pour exiger l'authentification.
* **Logique de requête :**
* Calculer le timestamp de début de la journée en cours (00:00:00 UTC).
* Ouvrir une session SQLAlchemy (`airflow.utils.session.create_session`).
* Requêter la table `DagRun` en filtrant sur `start_date >= début de journée`.
* Faire une jointure avec `DagModel` pour récupérer les tags associés (`DagModel.tags`).


* **Format de sortie (JSON) :** Renvoyer une liste d'objets contenant :
`id` (run_id), `dag_id`, `state`, `start` (ISO format), `end` (ISO format ou null), et `tags` (liste de strings).

## Étape 2 : Le Frontend (React - Logique & UX)

L'interface doit être réactive, sans appels API superflus lors du filtrage.

* **Stratégie de filtrage (Client-Side) :**
* Faire un appel `fetch` unique au chargement de la page vers le backend pour récupérer tous les DAGs du jour.
* Stocker les données brutes dans un state React.
* Créer un input texte pour filtrer dynamiquement par tag.
* Utiliser `useMemo` pour recalculer instantanément le tableau de données à afficher dès que l'utilisateur tape un tag.


* **Logique du Gantt (Adaptation du code Airflow) :**
* **Fenêtre globale :** Définir `windowStart` (00:00) et `windowEnd` (23:59).
* **Gestion des DAGs en cours :** Si l'état est `running` (`end_date` est `null` côté BDD), le frontend doit forcer la date de fin au timestamp actuel (`Date.now()`) pour que la barre s'étire jusqu'à l'instant T.
* **Calcul des barres :** Calculer `leftPercent` (marge relative au début de journée) et `widthPercent` (durée relative) pour placer les `div` sur la ligne de temps.



## Étape 3 : Le Bundler (Vite.js)

Configuration stricte du build pour se conformer aux exigences des plugins de l'UI Airflow 3.

* **Objectif :** Produire un unique fichier JavaScript agnostique.
* **Configuration Vite :**
* Désactiver le *code splitting* (`manualChunks: undefined`).
* Forcer un nom de fichier statique en sortie (ex: `global_gantt_bundle.js`).
* Utiliser `vite-plugin-css-injected-by-js` pour que le CSS généré par les composants soit injecté directement depuis le JS (aucun fichier `.css` séparé).
* Ignorer les dossiers `node_modules` et les sources JS/TS lors de la distribution.



## Étape 4 : L'intégration Airflow (Le Plugin Python)

Point de bascule qui connecte l'API, le bundle React et le menu de la nouvelle interface.

* **Service du bundle :**
* Créer une route statique ou utiliser `FileResponse` dans l'application FastAPI pour exposer le fichier `global_gantt_bundle.js` compilé à l'étape 3.


* **Déclaration du Plugin :**
* Créer une classe héritant de `airflow.plugins_manager.AirflowPlugin`.
* Renseigner `fastapi_apps = [{"app": my_app, "url_prefix": "/global-gantt-api"}]`.
* Renseigner `react_apps` avec les métadonnées de l'interface (nom "Global Gantt", catégorie "Browse", URL de la page) et pointer la clé `bundle_url` vers le endpoint FastAPI qui sert le fichier JS.