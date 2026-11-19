# Wheel pip vs. dépôt de fichiers dans `$PLUGINS_FOLDER` — note de décision

## Context

Question ouverte d'Antoine :

> Airflow 3.3+ a juste besoin du `.py` et du `dist.js` dans un dossier `plugins/` sur le nœud
> principal. À quoi bon compléxifier et passer par des wheels propres à chaque env/PC ?

Ce document répond sur le fond (ce qu'Airflow 3.4 exige vraiment), corrige un malentendu sur la
« wheel par env », et pose les options chiffrées. **Aucune ligne de code n'est modifiée** tant que la
décision de cible de déploiement n'est pas tranchée.

Rappel de l'historique : le plugin est né dans `$PLUGINS_FOLDER` (`plugins/dag_gantt_plugin.py`, cf.
`plans/20261109_01_plugin-en-paquet-pip-uv-executed.md`), et il en est sorti **à cause d'un bug
constaté en Kubernetes** : le montage `plugins/` n'atteignait pas l'`api-server` → page vide
(même plan, ligne 26 ; README §4.1). Le canal `plugins/` n'a donc pas été écarté par goût de la
complexité, il a été écarté par l'expérience.

## Réponse courte

1. **Sur le plan de l'API Airflow, tu as raison** : `react_apps` + `fastapi_apps` fonctionnent très
   bien depuis `$PLUGINS_FOLDER` (l'Advent Calendar de Tamara, qui a tourné dans le même env que
   notre Gantt, le prouvait — `plans/…01…`, relevé §9 : `advent_calendar_plugin` chargé en `$PLUGINS_FOLDER`
   avec son `react_apps` listé dans `/api/v2/plugins`). La wheel n'apporte **aucune** capacité
   fonctionnelle supplémentaire.
2. **Mais « le .py + le dist.js dans plugins/ » ne suffit pas tel quel** : le chargeur d'Airflow ne
   sait pas charger notre arborescence actuelle. Il faut **aplatir** le paquet en un seul `.py`
   autonome (vérifié à l'exécution, §Faits, n°1). C'est un vrai travail de refonte, pas un `cp`.
3. **Il n'y a pas de « wheel par env »** : une seule `py3-none-any` couvre Python 3.12→3.14 et tous
   les environnements (README §2, `pyproject.toml`). Le surcoût réel du canal wheel est **une** ligne
   de `pip install` dans le `Dockerfile` et un `./build.sh` déjà écrit. Les différences d'env vivent
   dans le `Dockerfile`/`.env`, pas dans le plugin.
4. La vraie question n'est donc pas *wheel vs. plugins/*, mais : **est-ce que la cible de déploiement
   est un nœud persistant sur lequel on peut copier des fichiers, ou des pods éphémères reconstruits
   à chaque déploiement ?** Dans le second cas (Astro/K8s, ce que le `Dockerfile` actuel vise), il n'y
   a pas de « nœud principal » persistant : tout fichier copié à la main disparaît au prochain deploy,
   et il faut de toute façon reconstruire l'image. Le `cp` ne fait alors que remplacer un
   `COPY`+`pip install` par un `COPY`+`cp` **sans version ni rollback**.

## Faits vérifiés dans le code (Airflow 3.4.0, `.venv/.../airflow`)

1. **`$PLUGINS_FOLDER` ne charge que des fichiers `.py` plats, jamais des paquets.**
   `_shared/plugins_manager/plugins_manager.py:341-345` : `if not path.is_file() or path.suffix
   != ".py": continue`, puis `mod_name = path.stem` + `SourceFileLoader` — chaque fichier est importé
   comme module **top-level**, sans paquet parent.
   Conséquence vérifiée à l'exécution (test dans `/tmp/pf_test`, Airflow 3.4.0) :
   `ImportError: attempted relative import with no known parent package`.
   → `src/airflow_dag_gantt/{__init__,api,plugin}.py` (qui font `from . import …`,
   `from .api import app`) **ne peut pas** être déposé tel quel. Il faudrait fusionner les 3 modules
   en un `dag_gantt_plugin.py` autonome (~200 lignes : queries SQLAlchemy + `FastAPI` + classe
   plugin), et perdre du coup les tests unitaires ciblés (`tests/test_plugin_packaging.py`,
   `TestClient(app)`).
2. **Pollution `sys.modules` top-level.** Le même chargeur fait `sys.modules[spec.name] = mod` avec
   `spec.name = stem`, récursivement dans les sous-dossiers. Vérifié : un `plugins/api.py` atterrit
   dans `sys.modules['api']` — n'importe quel `import api` du processus (scheduler, dag-processor,
   worker) récupère le fichier du plugin. C'est le genre de collision inter-équipes qui ne se
   diagnostique pas.
3. **Le plugin est importé par TOUS les composants**, pas seulement l'`api-server` :
   `plugins_manager.initialize()` tourne au démarrage de chaque processus. Le `.py` de plugins/ est
   donc exécuté aussi dans scheduler/dag-processor/triggerer/workers → tout ce qui casse à l'import
   casse ces composants-là aussi. (Notre `dev.sh py --all` restarts les 4 processus, c'est la trace
   de cette réalité.)
4. **Nom de plugin : premier gagné.** Un `plugins/*.py` résiduel **éclipse** le paquet installé
   (README §4.4, `plans/…01…` item 5). Le canal manuscrit rend ce résidu **probable** (on dépose, on
   oublie), et le symptôme est « la version installée ne prend pas », silencieux.
5. **Aucune dépréciation de `$PLUGINS_FOLDER`** en 3.3/3.4 (aucun avertissement dans
   `plugins_manager.py`) — ce n'est pas l'argument.

## Coûts réels, côte à côte

| | dépôt `plugins/` (1 `.py` + `static/`) | paquet pip (l'existant) |
| --- | --- | --- |
| travail à faire | **refonte** : aplatir 3 modules en 1 fichier, perdre les imports relatifs, redécouper les tests | 0 (défait, éprouvé, CI verte) |
| livrer sur la cible | `docker cp`/ConfigMap/git-sync **vers chaque pod** qui charge des plugins, ou `COPY` dans l'image | `COPY dist/` + `pip install` (déjà au `Dockerfile`) |
| sur pods éphémères (Astro/K8s) | ✗ le fichier copié meurt au redeploy ; le montage `plugins/` n'atteignait pas l'api-server (bug d'origine) | ✓ présent par construction sur tous les pods |
| version / rollback / audit | absent (`ls -l` pour toute traçabilité) | `0.3.0`, `pip show`, wheel = artefact nommé, diffable, épinglable par sha256 |
| atomicité .py ↔ bundle | 2 copies indépendantes → le « bundle neuf-et-vieux » déjà observé (README §4.4) devient la norme | la wheel est un seul artefact ; le hook `hatch_build.py` refuse de builder sans bundle |
| dépendances | à charger quand même dans l'image si le plugin en gagne un jour (`dependencies = ["apache-airflow>=3.1"]` les déclare) | ✓ |
| consommable par un autre projet | copie de fichiers | `uv pip install --no-deps …whl` (validé sur un 2ᵉ projet Astro vierge, `plans/…01…` §9.4) |
| boucle de dev | ~instantané | déjà instantané : `dev.sh js/py/watch` **fait** le `docker cp` à chaud, dans `site-packages` |

Dernière ligne, c'est le point clé : **le raccourci « copier les fichiers » existe déjà**, et il est
même meilleur que la version `plugins/` (il cible le paquet installé, garde les imports relatifs, et
`dev.sh full` remet la vérité d'image en 20 s). Le `cp` manuel n'apporte donc rien qu'on n'ait déjà,
sauf sur une machine hors-conteneur.

## Cible = « les deux, encore flou » ⇒ ce que ça implique concrètement

Tant que la cible n'est pas figée, **le seul artefact qui marche partout est le paquet** :

- pods éphémères (Astro/K8s) : `COPY dist/` + `pip install` — déjà écrit, présent sur tous les pods ;
- nœud persistant avec droits : `uv pip install --no-deps dist/*.whl` — même fichier ;
- nœud persistant **sans** droits d'install : `pip install --no-deps --target /chemin/lib dist/*.whl`
  (+ `PYTHONPATH`), voire `unzip wheel -d /chemin/lib`. **C'est le « juste copier des fichiers » que tu
  veux, mais sur `sys.path` et non dans `$PLUGINS_FOLDER`** : le paquet reste un paquet, donc les
  imports relatifs passent (`plugin.py → api.py`), les tests `TestClient(app)` restent valables, et
  l'entry point est découvert par `importlib.metadata`. On obtient l'atomicité .py + bundle sans
  aucune des limites du §Faits.

Le canal `$PLUGINS_FOLDER` n'est donc jamais le raccourci qu'il croit être : il exige un aplatissage
préalable, ne livre pas tous les composants, et ne marche pas mieux sur la cible floue.

## Réponses aux deux annotations de relecture

### A. « oui pour l'installer dans l'image Airflow **commune**, mais pas dans le même repo »

C'est le bon découpage, et il ne coûte rien : ce repo reste **le seul lieu du code** (public,
testable en `astro dev`, zéro adhérence à une plateforme interne), et l'image commune ne référence jamais que
**un artefact versionné + sa somme**. Le seul effet de bord d'un `COPY dist/` qui traverse une
frontière de repo, c'est que ça ne marche plus : le contexte de build Docker = **un** repo. Il faut
donc un canal inter-repos, par ordre de friction croissante :

1. **Wheel d'une Release GitHub, par URL + sha256** — `ADD https://github.com/AntoineGiraud/
   airflow_plugin_dag_gantt/releases/download/v0.4.0/airflow_dag_gantt-0.4.0-py3-none-any.whl`
   puis `RUN pip install --no-deps … && python -c "…assert sha256…"`. Ne marche que si le runner a
   l'egress vers github.com (à vérifier côté runner interne) ; c'est le plan
   `plans/20261109_03_python-313-314-et-release-github.md`.
2. **Register interne (recommandé en interne)** : GitLab **generic packages registry** du repo
   plugin (`curl --header "PRIVATE-TOKEN: …" …/packages/generic/airflow-dag-gantt/0.4.0/….whl`), ou
   Nexus/Artifactory. Zéro egress public, pinning par version, et surtout : **jamais de
   `--extra-index-url` vers PyPI public** — le nom `airflow-dag-gantt` y appartient à un autre
   plugin (README §4.2, dependency confusion). Installer par **URL explicite**, jamais par nom.
3. **Wheel vendorisée** dans le repo de l'image (`vendor/airflow_dag_gantt-0.4.0-py3-none-any.whl`,
   22 Ko) : laid mais gratuit, marche hors-ligne, et le `COPY vendor/…` + `pip install` reste
   identique au `Dockerfile` actuel. Bien pour un premier pas.
4. Sousmodule git du repo plugin → garde `COPY dist/` mais impose un `git submodule update` à chaque
   bump ; je le laisse en dernier.

**Argument propre à une image commune** (il compte plus que pour une image projet) : le `.py` du
plugin est **importé par tous les composants de tous les DAG de toutes les équipes** (§Faits n°3).
Un plugin qui lève à l'import casse le scheduler de tout le monde. Une installation versionnée se
repère (`pip show airflow-dag-gantt`, `airflow plugins --verbose`), un `cp` de fichiers non — et la
règle « premier `name` gagné » rend un conflit avec le plugin d'une autre équipe **silencieux**.

Quant à « surtout pour un `.js` si petit » : les chiffres vont dans ton sens, mais pour la wheel —
bundle **17,7 Ko**, wheel **22 Ko**, contenu dézippé **47 Ko** (6 fichiers). L'artefact complet pèse
moins qu'un import de `pandas` : le coût de la wheel n'est **pas** un coût de poids.

### B. « un `cp` dans l'image depuis les artefacts de ce repo, qu'est-ce que ça change vs la wheel ? »

Beaucoup plus que prévu, et c'est le point le plus solide de toute la note. **Vérifié à
l'exécution** (Airflow 3.4.0, `importlib.metadata.Distribution.discover`) :

```
dossier airflow_dag_gantt/ copié tel quel dans site-packages  -> AUCUN entry point  => Airflow ne voit PAS le plugin
dossier + dist-info écrit à la main (3 + 2 lignes)            -> ('airflow-dag-gantt', 'airflow_dag_gantt.plugin:DagGanttPlugin')
```

La découverte du plugin passe par `entry_points_with_dist("airflow.plugins")`
(`_shared/plugins_manager/plugins_manager.py:294`) qui lit `*.dist-info/entry_points.txt`. Un `cp`
de fichiers **n'écrit pas ces métadonnées** → plugin invisible. Les deux issues de secours sont
mauvaises : (a) redéposer dans `$PLUGINS_FOLDER` → on retombe sur l'aplatissage + la pollution
`sys.modules` (§Faits 1 et 2) ; (b) écrire le `dist-info` à la main → **réécrire la wheel à la
main**, sans `RECORD`, sans version, sans `pip uninstall`.

Autrement dit : **la wheel n'est pas de la cérémonie, ce sont 70 octets d'`entry_points.txt` et un
`METADATA` que pip écrit pour toi.** Son contenu exact (mesuré) :

| dans la wheel | taille | rôle |
| --- | --- | --- |
| `__init__.py`, `api.py`, `plugin.py`, `py.typed`, `static/*.js(+LICENSE)` | 25 Ko | **ce que tu veux copier** |
| `…dist-info/{METADATA,WHEEL,entry_points.txt,RECORD,licenses/LICENSE}` | 22 Ko | **ce qui fait que le plugin est chargé**, plus la version et le rollback |

(Dont 19 Ko… de `README.md` embarqué dans `METADATA` : le `entry_points.txt` décisif fait **70
octets**. La « complexité packaging » dénoncée tient dans trois lignes.)

Donc, à `cp` **équivalent** (c.-à-d. `pip install` d'une wheel, ou `unzip` de la wheel — qui contient
aussi le `dist-info`), la différence avec un `cp` de fichiers bruts n'est pas la « complexité » : elle
est **fonctionnelle**. Et la complexité que tu redoutes — la matrice d'env — n'existe pas : une seule
`py3-none-any`.

## Ce que change le déploiement cible réel (Kubernetes souverain, DAGs depuis un stockage objet)

*Cette note est versionnée dans un repo destiné à être public : elle décrit la cible en termes
génériques, sans nommer d'employeur, de cluster, de namespace ni de bucket.*

Côté plateforme visée : image **officielle** `apache/airflow:3.3.x` prolongée par un repo
`…-docker-image` (build kaniko, trivy + Dependency-Track, `semantic-release`), déploiement par le
**chart Helm officiel** sur 3 environnements (dev / intégration / production), Celery + edge
workers, DAGs **synchronisés depuis un bucket objet** vers un dossier monté en `emptyDir` sur tous
les conteneurs et ajouté au `PYTHONPATH`. `gitSync` du chart est désactivé.

Conséquences, dans l'ordre :

1. **`$PLUGINS_FOLDER` n'existe nulle part sur cette plateforme.** Aucune occurrence de « plugin »
   dans les values du chart : aucun volume ne monte `/opt/airflow/plugins`, qui n'existe qu'à
   l'intérieur de l'image, **un par pod**. Un `kubectl cp` atterrit donc sur **un** pod, est effacé
   au premier restart/rollout/HPA, et n'est pas répété d'un environnement à l'autre. **Il n'y a pas
   de « nœud principal »** : c'est le point qui invalide la question de départ, indépendamment de
   toute discussion sur la wheel.
2. **Le bon point d'entrée est bien l'image commune — et il coûte une ligne.** Deux formes, selon le
   niveau de gouvernance voulu :
   - `requirements.txt` de l'image, avec la version **épinglée** : l'artefact entre alors dans le
     scope des scans déjà en place (trivy, Dependency-Track), ce qu'aucun `cp` de fichier ne sera
     jamais ;
   - `COPY docker_copy/airflow_dag_gantt-0.4.0-py3-none-any.whl` + `RUN pip install --no-deps …` :
     motif déjà utilisé par cette image pour vendoriser un binaire, **zéro egress** au build kaniko.
   Dans les deux cas : **aucune modification du chart, aucun volume, aucun `extraVolumes`.**
   (`apache-airflow>=3.1` étant déclaré, pip voit 3.3.x installé et ne touche à rien.)
3. **Il y a bien un canal « déposer un fichier » sur cette plateforme — et il est tentant, mais il
   n'est pas pour la prod.** Le dossier synchronisé depuis l'objet est au `PYTHONPATH`, et
   `importlib.metadata` browse les entrées de `sys.path` : un paquet **accompagné de son
   `dist-info`** qu'on y déposerait serait donc découvert (vérifié, §B). Mais ce serait du code
   exécuté par **tous** les composants, sans MR, sans revue, sans pin, et surtout **sans rollout
   atomique** — l'`api-server` peut avoir le plugin et les workers pas. À garder comme canal de démo
   ou de test jetable, jamais comme livraison.
4. **Le plugin est importé par les workers aussi** (Celery comme edge) : une régression à l'import
   ne casse pas que l'UI, elle empêche l'exécution des tâches. Le rollback doit donc valoir
   `git revert` d'une ligne de `requirements.txt` (quelques secondes, au prochain déploiement), pas
   une reprise de fichiers pod par pod.

## Hygiène avant publication du repo (vérifié par `git grep` sur les fichiers suivis)

Nommer l'employeur n'est pas le sujet : il est déjà public (webinaire Data Days slides à l'appui). Ce
qui ne doit pas atterrir dans un repo public, c'est l'étage du dessous. Trois niveaux :

| | exemple | verdict |
| --- | --- | --- |
| nom public de l'entité, déjà communiqué | « Orange B2B », lien vers un webinaire | ✓ aucun problème |
| identifiants **internes** : nom de produit/instance, namespace, cluster, bucket, endpoint, chemin Vault | `D2B`, un nom de bucket de DAGs, un endpoint S3 `*.intraorange`, `ch1/nd1/nd2` | ✗ en principe à éviter (pour `D2B` : **assumé ici**, voir bas de section) |
| secret, token, mot de passe | — | ✗✗ jamais |

Deux traces du 2ᵉ niveau traînent **déjà** dans le repo du plugin — **laissées volontairement**
(décision du 2026-11-09, `D2B` traité comme un nom public au même titre que « Orange B2B ») :

- `.env.example:17` → `AIRFLOW__WEBSERVER__INSTANCE_NAME="Airflow D2B - env prd"` : c'est le **premier
  fichier** que lit un visiteur qui veut tester → valeur neutre (`"Airflow — env local"`).
- `plans/20261108_01_gantt_inspired_by_advent_tamara.md:84` → « thème/branding D2B ».

Rien d'autre : dans les 33 fichiers suivis, les seuls hosts rencontrés sont `github.com`,
`localhost`, `127.0.0.1`, `test.pypi.org`, `opensource.org`, `medium.com`, `blog.trailofbits.com` —
aucun hostname interne, aucun registre privé.

Corollaire : `plans/` est **versionné** (choix assumé, et vendeur pour un repo dont l'objet est de
montrer une démarche) — donc ces notes suivent la même règle d'hygiène que le README. La présente
note a été écrite en conséquence (§cible réelle).

## « Le build, c'est juste un zip du `.py` et du `.js` » — oui, et c'est tout son intérêt

C'est exactement ça, et ce n'est pas une corvée ajoutée au projet : `./build.sh` fait les deux
commandes (bundle webpack, puis `uv build --wheel`) depuis le commit `da1713d`. Le résultat : **un**
fichier de 22 Ko, `py3-none-any`, identifiable, épinglable par sha256, compréhensible par n'importe
quel outillage déjà présent sur la cible (pip, trivy, Dependency-Track, registre d'artefacts).
Un `.zip` de fichiers, lui, n'a ni nom, ni version, ni empreinte, ni `pip uninstall`.

## Angle « repo public qui donne envie + équipe interne qui l'ajuste »

- **Le `node_modules` de Tamara n'existe plus dans le dépôt** : 33 fichiers suivis, rien de `js/node_modules`,
  `js/dist`, `src/airflow_dag_gantt/static` ni `dist/` (tous au `.gitignore`) ; le plus gros fichier suivi est
  `js/bun.lock` (72 Ko) puis `docs/dag_gantt.png` (60 Ko). Un visiteur clone **~350 Ko de source**.
- Pour ce public, le chemin d'usage **le plus court** n'est pas `plugins/` (qui lui imposerait de
  comprendre l'aplatissage) mais : `./build.sh` → `uv pip install --no-deps dist/*.whl` (README §4.2,
  4 lignes), ou, une fois un tag posé, installer la wheel d'une **Release GitHub** par URL — c'est
  exactement ce que `plans/20261109_03_python-313-314-et-release-github.md` capitalise, et c'est ce qui
  rend le plugin « facile » sans que tu publies quoi que ce soit sur PyPI (où le nom est déjà pris).
- Pour l'équipe qui veut **l'ajuster** : la wheel n'est pas une boîte noire — le fork garde `src/` +
  `js/`, `./build.sh` marchera chez eux tel quel, et un bump de `name`/`URL_PREFIX` suffit à éviter la
  règle « premier nom gagné » s'ils installent les deux.

## Options envisagées

- **A — statut quo : RETENU.** Le `plugins/` reste interdit, la wheel reste le seul canal de
  livraison, `dev.sh` garde le rôle « copier-coller » de la dev, et `pip install --target`/`unzip`
  couvre le nœud persistant sans droits. Gain : zéro travail, zéro drift.
- **B — retour au `plugins/` : écarté.** Aplatir en un fichier autonome, renoncer aux `TestClient`,
  accepter le problème non résolu de répartition sur les pods : on rejouerait le bug d'origine avec
  moins de tests.

## Fichiers modifiés

**Aucun.** Décision d'architecture/déploiement uniquement ; le dépôt reste dans l'état du commit
`3155eef`. La seule écriture de cette réflexion est le présent fichier `plans/`.

## Décisions actées (réponses d'Antoine, 2026-11-09)

1. **Cible : « les deux, encore flou »** → un seul artefact, le paquet ; le `plugins/` n'offre
   aucun avantage sur une cible floue (§cible).
2. **Publicité / réutilisation : oui** — repo public qui donne l'envie + une équipe interne qui
   l'ajustera ; objectif « facile à utiliser, sans le `node_modules` de Tamara, pragmatique, bonnes
   pratiques, peu d'effort ». → la wheel (build local, Release GitHub épinglée) est **le** canal qui
   sert cet objectif ; `plugins/` l'aurait desservi.
3. **Livrable de cette réflexion : la réponse, pas de doc.** → **aucune modification de code ni de
   README n'est demandée ici.** Le présent fichier reste la trace de la décision ; le README §4.1
   garde sa table telle quelle.
4. **Intégration : dans l'image Airflow commune, une ligne, et rien n'est préparé depuis ce repo** —
   le `Dockerfile` de l'image se modifie dans son propre dépôt (et non depuis celui du plugin).
5. **Hygiène : aucune correction.** `D2B` (`.env.example`, `plans/20261108_01`) est assumé comme le
   nom public « Orange B2B ».

## Vérification / à faire

- [ ] Rien à implémenter **dans ce repo** : il reste producteur de la wheel, public et sans
      adhérence à une plateforme interne (c'est l'annot. 1, et c'est déjà l'état du dépôt).
- [ ] Le seul vrai choix ouvert, à trancher **côté repo de l'image Airflow commune** : quel canal
      inter-repos pour amener la wheel — Release GitHub (si le runner a l'egress), registre interne
      un registre d'artefacts interne, ou wheel vendorisée à côté du `Dockerfile`. Voir §A et §cible
      réelle.
- [ ] Corollaire à ne pas rater dans l'image commune : `pip install` **par URL/somme épinglée**, et
      surtout pas `airflow-dag-gantt` résolu depuis PyPI public (nom pris par un autre plugin).
- [ ] Hygiène avant publication : **décision = on ne touche à rien** (Antoine, 2026-11-09) — `D2B` est
      traité comme le nom public « Orange B2B » ; les deux traces relevées ci-dessus sont **assumées**,
      pas des oublis. Les garder ici pour que le choix reste visible et réversible.
- [ ] Le seul chantier réellement ouvert, découlant de ce choix : poser un **tag + Release GitHub
      épinglée par sha256** (`plans/20261109_03_…`) — c'est lui qui rend le repo public « facile »
      **et** qui alimente le canal de l'image commune.

Comment reproduire les deux mesures citées (Airflow 3.4.0, sans rien installer) :

```bash
# 1) $PLUGINS_FOLDER ne charge que des .py plats, sans paquet parent
python -c "from airflow._shared.plugins_manager.plugins_manager import _load_plugins_from_plugin_directory as L; print(L('/tmp/pf_test'))"
# 2) un dossier copié sans dist-info n'expose aucun entry point
python -c "from importlib.metadata import Distribution as D; print([e.value for d in D.discover(path=['/tmp/pk']) for e in d.entry_points if e.group=='airflow.plugins'])"
```

Rappel des commandes de contrôle du canal retenu :

```bash
./build.sh && uv pip install --no-deps dist/*.whl     # le canal unique
airflow plugins --verbose                             # source = entry point, PAS $PLUGINS_FOLDER
# nœud persistant sans droits :
pip install --no-deps --target /opt/airflow-lib dist/*.whl   # + PYTHONPATH=/opt/airflow-lib
```
