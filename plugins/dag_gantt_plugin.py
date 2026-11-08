"""Dag Gantt plugin — vue Gantt macro de tous les DagRun d'une journée.

Inspiré de la tuyauterie du plugin advent-calendar (fastapi_apps + react_apps),
mais expose les runs de tous les DAGs via une API JSON lue par le bundle React.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from airflow.models import DagModel, DagRun, DagTag
from airflow.plugins_manager import AirflowPlugin
from airflow.utils.session import create_session
from fastapi import FastAPI, HTTPException, Query, status
from fastapi.responses import FileResponse
from sqlalchemy import func, select

PLUGIN_DIR = Path(__file__).parent.absolute()
BUNDLE_PATH = PLUGIN_DIR / "react-src-dag-gantt" / "dist" / "dag-gantt-widget.js"

# Garde-fou : nombre max de runs renvoyés pour une journée.
RUN_LIMIT = 2000

app = FastAPI(title="Dag Gantt Plugin", version="1.0.0")


def _day_window(date_str: str | None) -> tuple[datetime, datetime]:
    """Fenêtre [00:00, 24:00) UTC de la journée demandée (défaut : aujourd'hui)."""
    if date_str:
        try:
            day = datetime.strptime(date_str, "%Y-%m-%d")
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="date must use the YYYY-MM-DD format",
            ) from exc
    else:
        day = datetime.now(timezone.utc)
    day_start = datetime(day.year, day.month, day.day, tzinfo=timezone.utc)
    return day_start, day_start + timedelta(days=1)


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


# Endpoint synchrone volontairement : FastAPI l'exécute dans son threadpool,
# ce qui évite de bloquer l'event loop avec les requêtes SQLAlchemy.
@app.get("/api/runs")
def get_runs(
    date: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$"),
) -> dict[str, Any]:
    """Tous les DagRun démarrés pendant la journée demandée (UTC), avec leurs tags."""
    day_start, day_end = _day_window(date)
    started_at = func.coalesce(DagRun.start_date, DagRun.run_after)

    with create_session() as session:
        rows = (
            session.execute(
                select(
                    DagRun.dag_id,
                    DagRun.run_id,
                    DagRun.state,
                    DagRun.start_date,
                    DagRun.end_date,
                    DagRun.logical_date,
                )
                .join(DagModel, DagModel.dag_id == DagRun.dag_id)
                .where(started_at >= day_start, started_at < day_end)
                .order_by(started_at)
                .limit(RUN_LIMIT + 1)
            )
            .all()
        )
        truncated = len(rows) > RUN_LIMIT
        rows = rows[:RUN_LIMIT]

        dag_ids = {row.dag_id for row in rows}
        tags_by_dag: dict[str, list[str]] = {}
        if dag_ids:
            for dag_id, tag_name in session.execute(
                select(DagTag.dag_id, DagTag.name).where(DagTag.dag_id.in_(dag_ids))
            ):
                tags_by_dag.setdefault(dag_id, []).append(tag_name)

    runs = [
        {
            "dag_id": row.dag_id,
            "run_id": row.run_id,
            "state": row.state,
            "start": _iso(row.start_date) or _iso(row.logical_date),
            "end": _iso(row.end_date),
            "logical_date": _iso(row.logical_date),
            "tags": sorted(tags_by_dag.get(row.dag_id, [])),
        }
        for row in rows
    ]

    return {
        "date": day_start.date().isoformat(),
        "window": {"start": _iso(day_start), "end": _iso(day_end)},
        "count": len(runs),
        "truncated": truncated,
        "runs": runs,
    }


@app.get("/dag-gantt-widget.js")
def serve_react_component():
    if not BUNDLE_PATH.exists():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Bundle not built yet: {BUNDLE_PATH} (run `bun run build`)",
        )
    return FileResponse(
        path=str(BUNDLE_PATH),
        media_type="application/javascript",
        filename="dag-gantt-widget.js",
        headers={
            "Cache-Control": "no-cache, no-store, must-revalidate",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/")
def root():
    return {
        "message": "📊 Dag Gantt Plugin",
        "type": "react_app",
        "component_url": "/dag-gantt-plugin/dag-gantt-widget.js",
        "api": "/dag-gantt-plugin/api/runs?date=YYYY-MM-DD",
        "description": "Global Gantt of every DagRun of a day, filterable by name/tag/state",
    }


class DagGanttPlugin(AirflowPlugin):
    name = "dag_gantt_plugin"

    fastapi_apps = [
        {
            "app": app,
            "url_prefix": "/dag-gantt-plugin",
            "name": "Dag Gantt Plugin",
        }
    ]

    react_apps = [
        {
            "name": "Dag Gantt",
            "bundle_url": "/dag-gantt-plugin/dag-gantt-widget.js",
            "destination": "nav",
            "category": "browse",
            "url_route": "dag-gantt",
        }
    ]
