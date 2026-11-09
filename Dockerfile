FROM astrocrpublic.azurecr.io/runtime:3.3-12

# Le plugin Global Dag Gantt est un **paquet pip**, plus un fichier déposé dans
# plugins/ : installé dans l'image, il est présent sur TOUS les pods (api-server
# compris), ce que le montage du dossier plugins/ ne garantissait pas en K8s.
#
# La wheel est produite localement par ./build.sh (bun + uv) : `dist/` ne doit
# donc JAMAIS être dans .dockerignore. Une wheel ne déclenche aucun build backend
# → bun n'est pas requis dans l'image.
#
# MODE LOCAL, unique mode retenu : la wheel vient du disque, donc zéro egress (le build marche
# hors-ligne, `./dev.sh full` inclus) et la garantie d'intégrité vient de ce que VOUS avez buildé.
# Publier l'artefact (Release GitHub épinglée par sha256, index interne, PyPI sous un autre nom)
# est délibérément hors POC : le savoir est capitalisé dans
# `plans/20261109_03_python-313-314-et-release-github.md` et le README §8.
COPY dist/ /tmp/plugin-dist/

# site-packages n'est pas writable par astro (uid 50000, groupe root mais r-x
# seulement) → pip retomberait sur un --user : on installe en root, comme les
# étapes ONBUILD de l'image (packages.txt / requirements.txt).
USER root
RUN pip install --no-cache-dir /tmp/plugin-dist/airflow_dag_gantt-*.whl \
    && rm -rf /tmp/plugin-dist \
    && python -c "from importlib.metadata import entry_points as e;\
names={p.name for p in e().select(group='airflow.plugins')};\
assert 'dag_gantt' in names, names; print('entry point ok:', sorted(names))"
# NB : pas de `airflow plugins` ici — ce CLI écrirait un airflow.cfg root dans
# $AIRFLOW_HOME. Vérifier au runtime : `astro dev run airflow plugins --verbose`.
USER astro

# NB : les hooks ONBUILD de l'image (`COPY packages.txt .`, `COPY requirements.txt .`,
# `COPY . .`) s'exécutent APRÈS cette étape — d'où packages.txt et requirements.txt
# préservés **même vides** : absents, le build échoue avant d'arriver à notre `COPY dist/`.
# Depuis le retrait du volet Advent Calendar, `COPY . .` n'amène plus que `dags/` : le
# plugin vient exclusivement de la wheel installée ci-dessus, plus rien de `plugins/`.
