"""Global Dag Gantt — plugin Airflow 3 distribué comme paquet pip.

Le module est importable **sans** Airflow pour les besoins du build et des tests
de packaging : aucun import d'`airflow` ici.
"""

from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version

# La version n'est plus déclarée ici : elle vient du tag git (hatch-vcs) et se **lit** dans les
# métadonnées installées. La constante `__version__` reste pour le log de `on_load`.
# Le nom lu est le nom **publié** (suffixe `-d2b`), pas celui du module.
try:
    __version__ = version("airflow-dag-gantt-d2b")
except PackageNotFoundError:  # checkout nu, paquet non installé
    __version__ = "0.0.0+unknown"

# Un seul nom partout (plugin.py ↔ api.py ↔ js/src/DagGanttWidget.jsx).
# Les décorateurs FastAPI sont évalués à l'import : pas de valeur lue dans
# l'environnement ici, sinon bundle_url et routes divergenteraient.

#: Nom du plugin (doit être unique : Airflow garde le premier découvert).
PLUGIN_NAME = "dag_gantt"

#: Préfixe sous lequel l'app FastAPI est montée à la racine du serveur d'API.
URL_PREFIX = "/dag-gantt-plugin"

#: Route du bundle React, relative à `URL_PREFIX`.
BUNDLE_NAME = "dag-gantt-widget.js"

#: Nom affiché dans la nav Airflow — **doit être exactement** la clé posée sur
#: `globalThis` par le bundle (voir js/src/index.js).
REACT_APP_NAME = "Dag Gantt"

__all__ = [
    "BUNDLE_NAME",
    "PLUGIN_NAME",
    "REACT_APP_NAME",
    "URL_PREFIX",
    "__version__",
]
