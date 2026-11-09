# 🧹 Plan (transcrit après coup) : ménage des résidus + boucle de développement du plugin

> **Ce plan a été écrit après la réalisation** — la passe s'est faite en conversation directe,
> sans passer par le mode plan. Il retrace les décisions **avec les preuves et les chiffres
> mesurés sur ce poste**, pour que l'historique reste relisible. Tout ce qui est marqué ✅ a été
> vérifié à la main (conteneurs réels, `docker history`, `pytest`, chronomètre).
> Deux commits de code l'accompagnent, plus ce fichier.

## 0. Point de départ

Le plugin est devenu un paquet pip ([plan `20261109_01`](20261109_01_plugin-en-paquet-pip-uv-executed.md))
et `astro dev start` fonctionne. Deux questions restent ouvertes :

1. **le ménage** : `include/` et `plugins/` servent-ils encore ? qu'y a-t-il d'autre à faire sauter ?
2. **l'XP de contribution** : le README impose `./build.sh` + `astro dev restart` pour **quelque
   modification que ce soit** → le dev du composant React semble condamné à un redémarrage complet.

## 1. Décisions prises

| # | Décision | Motif |
| --- | --- | --- |
| D1 | Supprimer `include/` et `plugins/` | résidus locaux vides, **déjà absents du dépôt** ✅ |
| D2 | Supprimer `tests/dags/` (squelette `astro dev init`) | il rend `pytest` **rouge** sur nos DAGs de démo ✅ |
| D3 | Exclure `.astro` du lint, **sans éditer** le squelette | fichier marqué `DO NOT EDIT` ✅ |
| D4 | `.env` reste gitignoré + **nouveau** `.env.example` versionné | choix de l'utilisateur : modèle public, valeurs locales |
| D5 | Ajouter `dev.sh` : écrire **dans le conteneur qui tourne** au lieu de rebuild l'image | le bundle est relu à chaque requête ✅ → le restart était inutile |
| D6 | **Pas** de dev-server / HMR | dupliquerait un second React dans la page (`externals` + `globalThis`, README §4.3) |
| D7 | Le prune Docker (env fantôme + images orphelines) est **reporté**, hors périmètre | n'a pas été validé dans le questionnaire ; destructeur |

## 2. Ménage appliqué

| Cible | Preuve | Action |
| --- | --- | --- |
| `include/`, `plugins/` | vides (`find … -type f` → 0 fichier) ; `git ls-files` n'en contient **aucun** → un clone frais n'a déjà ni l'un ni l'autre ; le commit `1f535c9` avait déjà sorti `include/helpers.py` et `plugins/advent_calendar_plugin.py` | `rmdir` ✅ |
| `tests/dags/test_dag_example.py` | `pytest` dans le conteneur : **3 failed**, `test_dag_retries` exige `retries >= 2` alors que `dags/gantt_demo.py` pose `retries: 0` (délibéré) | supprimé ✅ |
| `.astro/test_dag_integrity_default.py` | `ruff check .` : **5 erreurs**, toutes là (I001, E501 ×2, SIM910, UP015) | `extend-exclude` de ruff ✅ |
| `dags/.airflowignore` | fichier **vide** suivi par git, hérité d'init, sans effet | `git rm` ✅ |
| `.gitignore: .git` | sans effet (git ignore déjà son propre dossier) | retiré ✅ |
| `Dockerfile` commentaire `plugins/advent_calendar_plugin.py` | **faux** depuis `1f535c9` ; remplacé par la vraie contrainte : `docker history` montre `COPY packages.txt .` et `COPY requirements.txt .` en ONBUILD → ces deux fichiers doivent exister **même vides** ✅ | réécrit ✅ |
| docstring `tests/test_plugin_packaging.py` | référençait `advent-calendar_03e69c/airflow:latest`, image morte | corrigée ✅ |
| `dags/gantt_demo.py` docstring | « sans toucher aux DAGs advent » | réécrite ✅ |

**Ce qui a été vérifié puis explicitement épargné** : `packages.txt` et `requirements.txt`
vides mais obligatoires (hooks ONBUILD ✅), `.astro/config.yaml` +
`dag_integrity_exceptions.txt` (commandes `astro dev test/parse`), `dist/` wheel gitignorée mais
consommée par `COPY dist/`, `hatch_build.py` (hook déclaré dans `pyproject.toml`).

**Effet de bord assumé de D1** : `test_no_stale_gantt_file_in_plugins_folder` passe en `skip`
hors conteneur — sémantiquement correct, le garde-fou ne peut garder que ce qui existe ; il
reste actif dans le conteneur où `/usr/local/airflow/plugins` est monté.

## 3. Boucle de développement : la physique réelle, mesurée

La découverte qui annule D-précédent-du-README : `api.py` sert le bundle par `FileResponse`
(lecture **à chaque requête**, `cache-control: no-cache, no-store` ✅). Donc remplacer le fichier
dans le conteneur suffit — `astro dev restart` n'a jamais été nécessaire pour du JS.

| Ce qu'on change | Ce qui doit recharger | Délai mesuré | Commande |
| --- | --- | --- | --- |
| JS/JSX | rien (fichier relu à chaque requête) | **1,2 s** | `./dev.sh js`, puis refresh navigateur |
| JS en continu | idem, `webpack --watch` (bundle **non minifié** 34 761 o vs 12 674 o) | compile + copie auto | `./dev.sh watch` |
| Python | le **processus** Airflow (les plugins ne se chargent qu'au démarrage) | **8,5 s** (6 s jusqu'au 200) | `./dev.sh py` (`--all` = 4 process) |
| Packaging / `Dockerfile` / `pyproject.toml` | l'image | **~19 s** | `./dev.sh full` |

`dev.sh` découvre **lui-même** le bon conteneur (celui dont le `dags/` monté est le dépôt) —
nécessaire : trois envs `astro dev` tournent en parallèle sur le poste, dont un env fantôme monté
sur un chemin supprimé. Il redécouvre aussi le port exposé, **réattribué à chaque restart** ✅.

Contrat honnête écrit dans le README et dans l'en-tête du script : les modes `js`/`watch`/`py`
écrivent **dans le conteneur**, donc `astro dev restart`/`kill` ou un rebuild remettent la wheel à
l'identique → `./dev.sh full` avant de committer.

## 4. Validation (après tout changement)

- `ruff check .` → **All checks passed** ✅ · `shellcheck dev.sh build.sh` → clean ✅
- `pytest -q tests` dans le conteneur → **5 passed, 2 skipped** ✅ (les 2 skips = `js/` non monté par `astro dev`)
- `astro dev start` **sans** `include/` ni `plugins/` → stack up, Docker recrée les deux dossiers root-owned, inoffensif ✅
- `GET /dag-gantt-plugin/api/runs` → 200, **33 runs** de démo ✅ · bundle → 200, 12 674 o ✅
- Marqueurs de test (JS et Python) injectés puis retirés, `git diff` revenu propre ✅

## 5. Reste à faire (hors périmètre de cette passe)

1. **Prune Docker** — l'env `dag-gantt_03e69c-*` (6 conteneurs up) est monté sur
   `…/airflow/airflow-advent-calendar`, chemin **supprimé** ✅ ; volumes
   `dag-gantt_03e69c_{postgres_data,airflow_logs}` ; images `advent-calendar_03e69c/airflow`,
   `dag-gantt_03e69c/airflow`, `dag-gantt-packaged-test:0.1.0` (~3 Go).
   `docker system df` : **12,28 GB** d'images reclaimables, **8,9 GB** de build cache.
   ⚠️ Ne pas utiliser `astro dev kill -a` : il emporterait `gantt-consumer_*` (projet voisin).
2. **CI** : `dist/` et le bundle sont gitignorés → un pipeline doit enchaîner `./build.sh` puis le
   build d'image ; aucun `.gitlab-ci.yml` n'existe encore.
3. Le `.env` (nom d'instance + thème oklch) ne peut pas entrer dans une image (`.dockerignore`) :
   pour un vrai déploiement, reprendre ces variables dans l'infra (values Helm / config map).
