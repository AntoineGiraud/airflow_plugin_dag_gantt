"""Hook de build hatchling : câble le bundle JS dans le paquet Python.

`bun run build` produit `js/dist/*` ; le wheel doit embarquer ce bundle dans
`src/airflow_dag_gantt/static/`. Le hook **refuse** de produire un wheel sans
bundle : mieux vaut un build rouge qu'une UI silencieusement cassée.

Points non évidents vérifiés à l'exécution :

- il faut `artifacts = ["*/static/*"]` dans `pyproject.toml`, sinon `static/`
  (gitignoré) est écarté du wheel ;
- il ne faut **surtout pas** utiliser `build_data["force_include"]` en plus de la
  copie physique : hatch lève `ValueError: A second file is being added to the
  wheel archive at the same path`.
"""

from __future__ import annotations

import os
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface


class CustomBuildHook(BuildHookInterface):
    """Copie `js/dist` (sortie de `bun run build`) dans `<paquet>/static` au moment du wheel."""

    def initialize(self, version: str, build_data: dict) -> None:  # noqa: ARG002
        if self.target_name == "sdist":
            return  # l'sdist reste buildable sans bun

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
