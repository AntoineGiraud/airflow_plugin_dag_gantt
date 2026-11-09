"""Classe plugin du Global Dag Gantt.

C'est ce que l'entry point `airflow.plugins` expose :

    [project.entry-points."airflow.plugins"]
    dag_gantt = "airflow_dag_gantt.plugin:DagGanttPlugin"

`airflow.plugins_manager` instancie **la classe** (sans argument) au démarrage de
chaque composant — donc aussi de l'`api-server` en Kubernetes, ce que le dépôt de
fichiers dans `$PLUGINS_FOLDER` ne garantissait pas.
"""

from __future__ import annotations

import logging
from pathlib import Path

from airflow.plugins_manager import AirflowPlugin

from . import BUNDLE_NAME, PLUGIN_NAME, REACT_APP_NAME, URL_PREFIX, __version__
from .api import app

logger = logging.getLogger(__name__)


class DagGanttPlugin(AirflowPlugin):
    """Vue macro de tous les DagRun d'une journée, dans la nav Airflow."""

    name = PLUGIN_NAME

    fastapi_apps = [
        {
            "app": app,
            "url_prefix": URL_PREFIX,
            "name": "Dag Gantt Plugin",
        }
    ]

    react_apps = [
        {
            "name": REACT_APP_NAME,
            "bundle_url": f"{URL_PREFIX}/{BUNDLE_NAME}",
            "destination": "nav",
            "category": "browse",
            "url_route": "dag-gantt",
        }
    ]

    @classmethod
    def on_load(cls, *args, **kwargs):
        """Signature volontairement permissive (la doc officielle le recommande).

        Cette ligne est aussi notre trace de diagnostic n°1 : elle doit apparaît
        dans les logs de l'`api-server` si (et seulement si) le paquet est chargé.
        """
        logger.info(
            "dag-gantt %s loaded (bundle=%s, prefix=%s, file=%s)",
            __version__,
            Path(__file__).parent / "static" / BUNDLE_NAME,
            URL_PREFIX,
            __file__,
        )
