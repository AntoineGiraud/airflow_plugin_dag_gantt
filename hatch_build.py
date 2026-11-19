"""Hook de build hatchling : câble le bundle JS dans le paquet Python.

`bun run build` produit `js/dist/*` ; le wheel doit embarquer ce bundle dans
`src/airflow_dag_gantt/static/`. Le hook **refuse** de produire un wheel sans
bundle : mieux vaut un build rouge qu'une UI silencieusement cassée.

Points non évidents vérifiés à l'exécution :

- il faut `artifacts = ["*/static/*"]` dans `pyproject.toml`, sinon `static/`
  (gitignoré) est écarté du wheel ;
- il ne faut **surtout pas** utiliser `build_data["force_include"]` en plus de la
  copie physique : hatch lève `ValueError: A second file is being added to the
  wheel archive at the same path` ;
- une installation **éditable** (`uv sync`, donc chaque job TBC qui appelle
  `install_requirements`) déclenche le même hook dans une image `python:3.14` **sans bun** :
  elle reçoit un stub, seule la wheel garde le droit d'échouer. Le marqueur d'editable est
  l'argument `version` (`"editable"`, PEP 660), **pas** `self.target_name` : l'editable passe
  par le builder wheel, donc `target_name` y vaut `"wheel"` (vérifié dans hatchling 1.33,
  `build_editable` → `build(versions=["editable"])`).
"""

from __future__ import annotations

import os
from pathlib import Path

from hatchling.builders.hooks.plugin.interface import BuildHookInterface

BUNDLE_NAME = "dag-gantt-widget.js"

# Écrit à la place du bundle quand une installation éditable n'a rien à câbler : l'UI
# reste vide, mais la console dit pourquoi au lieu de laisser un silence.
_STUB = (
    "// stub posé par hatch_build.py : aucun bundle JS (bun run build) n'a ete fourni.\n"
    'console.error("[dag-gantt] bundle absent — lancer ./build.sh (bun) puis recharger l\'UI");\n'
)


class CustomBuildHook(BuildHookInterface):
    """Copie `js/dist` (sortie de `bun run build`) dans `<paquet>/static` au moment du wheel."""

    def initialize(self, version: str, build_data: dict) -> None:  # noqa: ARG002
        if self.target_name == "sdist":
            return  # l'sdist reste buildable sans bun

        # `version` vaut "editable" pour PEP 660 (`uv sync`, `pip install -e`) et "standard"
        # pour le wheel normal ; `target_name` vaut "wheel" dans les DEUX cas.
        editable = version == "editable"

        env = os.environ.get("DAG_GANTT_JS_DIR")
        src = None
        if env:
            src = Path(env)
            if not src.is_absolute():
                src = (Path(self.root) / env).resolve()

        dest = Path(self.root) / "src" / "airflow_dag_gantt" / "static"
        if src is None or not src.is_dir():
            if editable:
                dest.mkdir(parents=True, exist_ok=True)
                (dest / BUNDLE_NAME).write_text(_STUB, encoding="utf-8")
                return
            if src is None:
                raise RuntimeError(
                    "DAG_GANTT_JS_DIR is required: run `bun run build` in js/ then "
                    "`DAG_GANTT_JS_DIR=js/dist uv build --wheel` (or ./build.sh)"
                )
            raise RuntimeError(f"JS dist not found: {src}")

        dest.mkdir(parents=True, exist_ok=True)
        for f in sorted(src.iterdir()):
            if f.is_file():
                (dest / f.name).write_bytes(f.read_bytes())
