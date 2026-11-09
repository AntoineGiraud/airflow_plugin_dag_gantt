"""DAGs de demonstration du plugin Global Dag Gantt.

Objectif : peupler la vue Gantt avec des runs varies (success / failed / running,
tags differents, chevauchements) sans mobiliser le moindre DAG d'exemple.

- gantt_demo_finance : @hourly + catchup depuis minuit UTC -> barres success successives.
- gantt_demo_quality : @hourly + catchup, quality_gate echoue les heures paires -> barres failed.
- gantt_demo_slow    : declenchement manuel, ~3 min de sleep -> barre running qui s'etire.
"""

from __future__ import annotations

import random
import time
from datetime import datetime, timezone

from airflow.sdk import dag, get_current_context, task


def _today_utc_midnight() -> datetime:
    now = datetime.now(timezone.utc)
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


DEFAULT_KWARGS = {"retries": 0}


@dag(
    schedule="@hourly",
    start_date=_today_utc_midnight(),
    catchup=True,
    tags=["gantt-demo", "finance"],
    dag_display_name="Gantt Demo · Finance",
    default_args=DEFAULT_KWARGS,
)
def gantt_demo_finance():
    @task
    def extract():
        time.sleep(random.randint(3, 8))
        print("extract OK")

    @task
    def transform():
        time.sleep(random.randint(3, 8))
        print("transform OK")

    @task
    def load():
        time.sleep(random.randint(2, 5))
        print("load OK")

    extract() >> transform() >> load()


@dag(
    schedule="@hourly",
    start_date=_today_utc_midnight(),
    catchup=True,
    tags=["gantt-demo", "quality", "batch"],
    dag_display_name="Gantt Demo · Quality",
    default_args=DEFAULT_KWARGS,
)
def gantt_demo_quality():
    @task
    def ingest():
        time.sleep(random.randint(3, 10))
        print("ingest OK")

    @task
    def quality_gate():
        # Echoue les heures paires (date logique) -> melange success/failed dans la journee.
        logical_date = get_current_context()["logical_date"]
        if logical_date.hour % 2 == 0:
            raise ValueError(f"quality_gate failed for hour {logical_date.hour:02d}")
        print("quality_gate OK")

    ingest() >> quality_gate()


@dag(
    schedule=None,  # declenchement manuel : barre running longue visible en direct
    start_date=_today_utc_midnight(),
    tags=["gantt-demo", "ops"],
    dag_display_name="Gantt Demo · Slow Pipeline",
    default_args=DEFAULT_KWARGS,
)
def gantt_demo_slow():
    @task
    def long_step():
        print("dorm 3 minutes… declenche ce DAG et regarde la barre s'etirer dans le Gantt")
        time.sleep(180)

    long_step()


gantt_demo_finance()
gantt_demo_quality()
gantt_demo_slow()
