#!/usr/bin/env bash
# Boucle de développement du plugin : pousser le code dans le conteneur QUI TOURNE,
# sans reconstruire l'image.
#
#   ./dev.sh js      bundle JS + copie à chaud   (~1 s)  → rafraîchir le navigateur
#   ./dev.sh watch   idem, en continu (webpack --watch + copie à chaque compile)
#   ./dev.sh py      .py dans site-packages + restart api-server (~6 s)
#   ./dev.sh all     js + py
#   ./dev.sh full    ./build.sh + astro dev restart (~20 s) ← LA VÉRITÉ (image rebuildée)
#   ./dev.sh url     URL directe de l'api-server (le port change à chaque restart)
#   ./dev.sh api     GET /api/runs en JSON lisible
#   ./dev.sh logs    logs de l'api-server
#
# ⚠️ `js`/`py` écrivent dans le conteneur : c'est **jetable**. `astro dev restart|kill`,
#    un rebuild d'image ou un `docker cp` concurrent écrasent tout ; le paquet installé
#    vient de la wheel. Valider pour de vrai avec `./dev.sh full` avant de committer.
#
# Pourquoi ça marche sans restart côté JS : `api.py` sert le bundle par `FileResponse`
# (lecture à chaque requête, `cache-control: no-cache`) — le fichier change, le navigateur
# suit. Côté Python en revanche, Airflow ne charge les plugins qu'au démarrage du
# processus → le restart du conteneur est unavoidable (mais 6 s, pas 2 min).
set -euo pipefail
cd "$(dirname "$0")"

PKG=airflow_dag_gantt
BUNDLE=dag-gantt-widget.js
PROCS=(api-server dag-processor scheduler triggerer)

die() { echo "dev.sh: $*" >&2; exit 1; }

# Le conteneur api-server de CE projet : celui dont le `dags/` monté est celui d'ici.
# (Plusieurs envs astro dev peuvent tourner en parallèle sur le poste — ici un env
# orphelin d'un ancien chemin et un projet voisin.)
api_container() {
  local c src
  for c in $(docker ps --format '{{.Names}}' | grep -- '-api-server-1$'); do
    src=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/usr/local/airflow/dags"}}{{.Source}}{{end}}{{end}}' "$c")
    [ "$src" = "$PWD/dags" ] && { echo "$c"; return 0; }
  done
  return 1
}

CMD=${1:-js}
if [ "$CMD" = "help" ] || [ "$CMD" = "-h" ] || [ "$CMD" = "--help" ]; then
  sed -n '2,21p' "$0"
  exit 0
fi

C=$(api_container) || die "pas d'api-server astro dev pour $PWD — lancer \`astro dev start\`"

site_pkgs() {
  docker exec "$C" python -c "import ${PKG} as p, pathlib; print(pathlib.Path(p.__file__).parent)"
}

SP=$(site_pkgs) || die "paquet ${PKG} absent de ${C} — \`./dev.sh full\`"

push_bundle() {
  [ -f js/dist/$BUNDLE ] || die "js/dist/$BUNDLE absent — \`cd js && bun run build\`"
  docker cp "js/dist/$BUNDLE" "$C:$SP/static/$BUNDLE"
  echo "  bundle poussé → rafraîchir le navigateur (Ctrl+Shift+R)"
}

build_js() { ( cd js && bun run build >/dev/null ) || die "bun run build a échoué — \`cd js && bun run build\` pour le détail"; }

wait_ready() {
  local i
  for i in $(seq 1 60); do
    docker exec "$C" python -c "
import urllib.request,sys
try: sys.exit(0 if urllib.request.urlopen('http://localhost:8080/dag-gantt-plugin/api/runs', timeout=2).status == 200 else 1)
except Exception: sys.exit(1)" >/dev/null 2>&1 && { echo "  api-server prêt (${i}s)"; return 0; }
    sleep 1
  done
  die "api-server toujours pas prêt après 60 s — \`./dev.sh logs\`"
}

host_url() {
  local p
  p=$(docker inspect -f '{{(index (index .NetworkSettings.Ports "8080/tcp") 0).HostPort}}' "$C")
  echo "http://127.0.0.1:${p}/dag-gantt-plugin"
}

case "$CMD" in
  js)
    time build_js
    push_bundle
    ;;
  watch)
    echo "webpack --watch (log: /tmp/dag-gantt-webpack.log) + copie à chaque compile — Ctrl-C pour stopper"
    ( cd js && bun run dev >/tmp/dag-gantt-webpack.log 2>&1 ) &
    wpid=$!
    trap 'kill "$wpid" 2>/dev/null || true' EXIT
    last=""
    while :; do
      sig=$(stat -c '%Y-%s' "js/dist/$BUNDLE" 2>/dev/null || echo "")
      if [ -n "$sig" ] && [ "$sig" != "$last" ]; then last=$sig; push_bundle; fi
      sleep 1
    done
    ;;
  py)
    for f in "src/$PKG"/*.py; do docker cp "$f" "$C:$SP/$(basename "$f")"; done
    if [ "${2:-}" = "--all" ]; then
      for p in "${PROCS[@]}"; do docker restart "${C%-api-server-1}-$p-1" >/dev/null; done
      echo "  4 processus restart (le plugin se charge aussi dans scheduler/triggerer/dag-processor)"
    else
      docker restart "$C" >/dev/null
    fi
    wait_ready
    ;;
  all)
    time build_js; push_bundle
    "$0" py "${2:-}"
    ;;
  full)
    ./build.sh
    astro dev restart
    ;;
  url)
    host_url
    ;;
  api)
    if command -v jq >/dev/null; then
      curl -s "$(host_url)/api/runs${2:+?date=$2}" | jq .
    else
      curl -s "$(host_url)/api/runs${2:+?date=$2}"
    fi
    ;;
  logs)
    shift; docker logs -f --tail 100 "$C" "$@"
    ;;
  -h|--help|help)
    sed -n '2,21p' "$0"
    ;;
  *)
    die "commande inconnue: $CMD (voir ./dev.sh help)"
    ;;
esac
