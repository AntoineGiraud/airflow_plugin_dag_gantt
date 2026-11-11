"""Tests de packaging du paquet `airflow-dag-gantt`.

À lancer dans un environnement **où le paquet est installé** — la **wheel**, pas un editable :
`pip install -e .` **échoue** sans `DAG_GANTT_JS_DIR` (le hook de build s'applique aussi à
l'editable), et installer la wheel est de toute façon ce que consomme le déploiement :

    ./build.sh && uv venv /tmp/v && uv pip install -p /tmp/v dist/*.whl pytest httpx
    /tmp/v/bin/pytest -q tests

    # ou, sans venv local, dans l'image Astro du projet (tag `<projet>_<hash>/airflow:latest`,
    # voir `docker images`) ; `astro dev` monte `tests/` mais pas `js/` → 2 tests skipés :
    docker run --rm --entrypoint bash -v "$PWD":/work dag-gantt_f2938e/airflow:latest \\
        -c 'pip install --no-cache-dir /work/dist/*.whl pytest && cd /work && pytest -q tests'
"""

from __future__ import annotations

import re
import sys
import tomllib
from importlib.metadata import entry_points
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[1]
JS_SOURCE = REPO_ROOT / "js" / "src" / "DagGanttWidget.jsx"
API_SOURCE = REPO_ROOT / "src" / "airflow_dag_gantt" / "api.py"
PYPROJECT = REPO_ROOT / "pyproject.toml"

EXPECTED_NAME = "dag_gantt"
EXPECTED_URL_PREFIX = "/dag-gantt-plugin"
EXPECTED_BUNDLE_URL = "/dag-gantt-plugin/dag-gantt-widget.js"
EXPECTED_REACT_NAME = "Dag Gantt"


def test_discovery_via_airflow_plugins_entry_point():
    """Le plugin est trouvé par l'entry point, sans fichier dans $PLUGINS_FOLDER."""
    try:
        from airflow.plugins_manager import AirflowPlugin
    except ImportError:  # pragma: no cover - Airflow absent de l'environnement
        pytest.skip("apache-airflow not installed")

    eps = entry_points()
    selected = (
        eps.select(group="airflow.plugins")
        if hasattr(eps, "select")
        else list(eps.get("airflow.plugins", []))
    )
    by_name = {ep.name: ep for ep in selected}
    assert EXPECTED_NAME in by_name, f"{EXPECTED_NAME} not in {sorted(by_name)}"

    loaded = by_name[EXPECTED_NAME].load()
    assert isinstance(loaded, type) and issubclass(loaded, AirflowPlugin)
    assert loaded.__module__ == "airflow_dag_gantt.plugin"


def test_plugin_registration_metadata():
    """Nom, url_prefix et bundle_url cohérents (le nom de `react_apps` est contractuel)."""
    from airflow_dag_gantt.plugin import DagGanttPlugin

    assert DagGanttPlugin.name == EXPECTED_NAME
    (fastapi_app,) = DagGanttPlugin.fastapi_apps
    assert fastapi_app["url_prefix"] == EXPECTED_URL_PREFIX
    (react_app,) = DagGanttPlugin.react_apps
    # ⚠️ cette clé doit être EXACTEMENT le nom posé sur globalThis par le bundle.
    assert react_app["name"] == EXPECTED_REACT_NAME
    assert react_app["bundle_url"] == EXPECTED_BUNDLE_URL
    assert react_app["bundle_url"] == fastapi_app["url_prefix"] + "/dag-gantt-widget.js"


def test_bundle_is_shipped_inside_the_package():
    """Le bundle vit dans le paquet (`static/`), pas à côté d'un fichier de `plugins/`."""
    import airflow_dag_gantt

    bundle = Path(airflow_dag_gantt.__file__).parent / "static" / "dag-gantt-widget.js"
    assert bundle.is_file(), f"missing {bundle} (build the wheel with ./build.sh)"
    content = bundle.read_text(encoding="utf-8")
    assert len(content) > 1024, "suspiciously small bundle"
    assert "globalThis" in content, "bundle must register itself on globalThis"


@pytest.mark.skipif(not JS_SOURCE.is_file(), reason=f"JS source not available: {JS_SOURCE}")
def test_url_contract_between_python_and_js():
    """`API_URL` du bundle == route montée par le plugin (aucune URL en dur qui dérive)."""
    from airflow_dag_gantt import BUNDLE_NAME, PLUGIN_NAME, URL_PREFIX
    from airflow_dag_gantt.api import BUNDLE_PATH, app

    js = JS_SOURCE.read_text(encoding="utf-8")
    match = re.search(r"const API_URL\s*=\s*'([^']+)'", js)
    assert match, "API_URL not found in js/src/DagGanttWidget.jsx"
    assert match.group(1) == f"{URL_PREFIX}/api/runs"

    routes = {getattr(r, "path", None) for r in app.routes}
    assert "/api/runs" in routes
    assert f"/{BUNDLE_NAME}" in routes
    assert BUNDLE_PATH.name == BUNDLE_NAME
    assert PLUGIN_NAME not in {"advent_calendar_plugin"}  # garde-fou anti-doublon de nom

    index_js = (REPO_ROOT / "js" / "src" / "index.js").read_text(encoding="utf-8")
    assert re.search(r"globalThis\['Dag Gantt'\]", index_js), (
        "globalThis key must match react_apps[0]['name']"
    )


def test_api_runs_contract():
    """`GET /api/runs` renvoie le contrat attendu ; `date` mal formé → 422 (pattern Query)."""
    pytest.importorskip("fastapi.testclient", reason="httpx required for TestClient")
    from airflow.utils.session import create_session
    from fastapi.testclient import TestClient

    from airflow_dag_gantt.api import app

    # Un `create_session()` qui passe ne prouve rien : sur SQLite il crée juste un
    # fichier vide. On sonde la vraie table lue par l'endpoint.
    try:
        from airflow.models import DagRun
        from sqlalchemy import func, select

        with create_session() as session:
            session.execute(select(func.count()).select_from(DagRun))
    except Exception as exc:  # pragma: no cover - environnement sans métadatabase initialisée
        pytest.skip(f"no initialised Airflow metadata DB: {type(exc).__name__}: {exc}")

    client = TestClient(app)

    ok = client.get("/api/runs", params={"date": "2026-11-09"})
    assert ok.status_code == 200, ok.text
    payload = ok.json()
    assert set(payload) == {"date", "window", "count", "runs"}
    assert payload["date"] == "2026-11-09"
    assert isinstance(payload["runs"], list)

    bad = client.get("/api/runs", params={"date": "11/09/2026"})
    assert bad.status_code == 422


def test_api_has_no_daily_run_limit():
    """La vue est une vue d'ensemble de la journée : `/api/runs` ne tronque plus rien.

    Vérifié au niveau du source (même style que `test_url_contract_between_python_and_js`) :
    aucun `.limit(` dans la requête, plus de `RUN_LIMIT`, plus de clé `truncated` dans le
    payload. Un run masqué serait une information perdue ; la densité est absorbée par
    l'agrégation côté front (`js/src/aggregation.js`).
    """
    source = API_SOURCE.read_text(encoding="utf-8")
    assert ".limit(" not in source, "/api/runs ne doit plus plafonner la journée"
    assert "RUN_LIMIT" not in source
    assert '"truncated"' not in source
    assert '"truncated"' not in JS_SOURCE.read_text(encoding="utf-8")


def test_no_stale_gantt_file_in_plugins_folder():
    """Un `plugins/*gantt*.py` résiduel **éclipse** le paquet (premier nom gagné)."""
    plugins = REPO_ROOT / "plugins"
    if not plugins.is_dir():
        pytest.skip(f"not running from the plugin repository: {plugins} missing")
    stale = [p for p in plugins.glob("*.py") if "gantt" in p.name.lower()]
    assert not stale, f"remove {stale}: the plugin is distributed as a package now"


@pytest.mark.skipif(
    not (REPO_ROOT / "src" / "airflow_dag_gantt" / "__init__.py").is_file(),
    reason="running against an installed package, sources not available",
)
def test_package_root_imports_no_airflow():
    """`airflow_dag_gantt/__init__.py` n'importe pas airflow → build/diagnostic possibles."""
    source = (REPO_ROOT / "src" / "airflow_dag_gantt" / "__init__.py").read_text("utf-8")
    assert "from airflow" not in source and "import airflow" not in source
    assert sys.version_info >= (3, 12)


def test_version_is_consistent_between_pyproject_and_package():
    """`[project].version` == `airflow_dag_gantt.__version__`.

    La version vit en **deux** endroits (déclaration du paquet **et** log de `on_load`, donc la
    trace de diagnostic des pods). Sans ce garde-fou, un bump oublié dans l'un des deux fait
    sortir une release dont le wheel dit `0.2.0` pendant que les logs disent `0.1.0` — et le tag
    git, lui, est vérifié en CI contre `pyproject.toml` seulement.
    """
    import airflow_dag_gantt

    # `tomllib` plutôt qu'une regex : la borne basse est 3.12, et `[tool.hatch.build]` contient
    # d'autres clés `version` — lire le TOML évite d'aller chercher la mauvaise table.
    declared = tomllib.loads(PYPROJECT.read_text("utf-8"))["project"]["version"]
    assert declared == airflow_dag_gantt.__version__, (
        f"pyproject.toml says {declared!r}, package says {airflow_dag_gantt.__version__!r}"
    )
