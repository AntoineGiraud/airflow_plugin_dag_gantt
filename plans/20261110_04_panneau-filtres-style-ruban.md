# v0.7.0 — Panneau de contrôles en onglets (style Word/Excel)

## Contexte

La barre du haut de `DagGanttWidget.jsx` accumule **11 contrôles sur une seule ligne**
(⬅️ date ➡️, filtre nom, select tag, input étapes, select tri, select agrégation, bouton
Groupes/Liste, Tout replier, Refresh, Zoom auto, plus les textes de statut à droite).
Résultat : wrapping, contrôles qui se ressemblent, filtres noyés parmi les réglages
d'affichage.

L'objectif : une organisation **par catégories**, à la ruban Word/Excel — deux onglets
« Filtres » et « Affichage » — sans aucune nouvelle fonctionnalité de fond (UI only).

**Arbitrages validés avec l'utilisateur (10/11/2026) :**

1. **États** : le filtre existe déjà (légende cliquable en bas, `?state=`). On **garde la
   légende cliquable en bas** ET on ajoute des **cases à cocher dans l'onglet Filtres**,
   les deux pilotant le même état `stateFilter` (synchronisés automatiquement).
2. **Au chargement** : panneau **déplié, onglet Filtres actif**.
3. **Refresh** : déménage dans l'onglet **Affichage**.
4. **Périmètre v0.7.0** : réorganisation pure des contrôles existants, rien de plus.

## Approach

### Maquette

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ 📊 Global Dag Gantt   ⬅️ [2026-11-10] ➡️   [Filtres][Affichage]  ⌃   1 270 runs │  ← toujours 1 ligne
│ ● tag: spark ✕   ● états: failed, running ✕   « étapes: collecte… » ✕        │  ← chip si filtre actif
├──────────────────────────────────────────────────────────────────────────────┤
│  🔍 Filtres                                                                  │
│  Nom DAG / run [____________]   Tag [tous ▾]   États ☐queued ☐running        │
│                                               ☐success ☐failed               │
│  Étapes (priorité) [____________________]         ⟳ Réinitialiser les filtres│
└──────────────────────────────────────────────────────────────────────────────┘
```

Onglet Affichage :

```
│  ⚙ Affichage                                                                 │
│  Tri [1er run ▾]   Agrégation [auto ▾]   🔍 Zoom auto (toggle)               │
│  🗂 Groupes par tag (toggle)   [Tout replier]                                 │
│  ⟳ Rafraîchir                                     14:02 → 18:30 · 4h 28min   │
```

### Structure proposée

- **Ligne permanente (jamais repliable)** : titre + navigation date + onglets +
  statut condensé (`N runs`, fenêtre `14:02 → 18:30`). Sous les onglets, une rangée de
  **chips** des filtres actifs (tag, états, étapes, nom tronqué), chacune retirables
  par ✕ — c'est ce qui garde la visibilité des filtres quand le panneau est replié.
- **Panneau déplié** = le contenu de l'onglet actif (une seule rangée de ~32 px).
  Chevron `⌄/⌃` pour replier ; une fois replié, seules la ligne permanente + les chips
  restent (le Gantt récupère la hauteur).
- **Filtres actifs = rehaussement visuel de l'onglet** : badge compteur sur l'onglet
  Filtres (ex. `Filtres · 2`), pas d'autre artifice.
- **Onglet Filtres** : nom (Input), tag (Select), états (cases à cocher avec pastilles
  de couleur, même liste `legendStates` que la légende), étapes (Input), + bouton
  « Réinitialiser les filtres » (`q`/`tag`/`state`/`stages` remis à vide — pas la date).
- **Onglet Affichage** : tri (Select), agrégation (Select), Zoom auto (toggle),
  Groupes/Liste (toggle), Tout replier/déplier, ⟳ Rafraîchir, et le texte de statut
  fenêtre/buckets.
- **Légende en bas** : inchangée (reste cliquable, partage `stateFilter`/`toggleState`).

### Contrainte technique : pas de Tabs/Checkbox Chakra garantis

Le widget consomme le Chakra de l'hôte via `globalThis` (`webpack externals`) ; seuls
Box/Flex/HStack/VStack/Text/Input/Button/Badge/NativeSelect* sont utilisés aujourd'hui,
avec un garde-fou `HasNativeSelect` pour le seul composant incertain. Le pattern
« onglets » s'implémente donc **en Box/Button Chakra existants** (rôles ARIA
`role="tablist"`/`role="tab"`, aria-selected, clic + touches Entrée/Espace) et les cases
à états en `as="button"` comme la légende actuelle — zéro dépendance à un composant
Chakra incertain, même dégradation partout.

## Files to modify

| Fichier | Changement |
|---|---|
| `js/src/DagGanttWidget.jsx` | Refonte du rendu de la barre du haut : nouveau sous-composant `ControlRibbon` (ligne permanente + chips + panneau à onglets) ; état local `panelTab`/`panelOpen` ; les états de filtres existants ne bougent pas |
| `js/test/render.test.mjs` | Stubs éventuels (aucun nouveau composant Chakra attendu) + tests : onglets rendus, bascule Filtres↔Affichage, repli/dépli, chips de filtres actifs + retrait par ✕, cases états ↔ légende synchronisées |
| `pyproject.toml` | `version = "0.7.0"` |
| `src/airflow_dag_gantt/__init__.py` / test packaging | Cohérence de version (le test `tests/test_plugin_packaging.py` la vérifie) |
| `README.md` | Section captures/ description de l'UI : mentionner le panneau à onglets |
| `js/package.json` | version du paquet npm interne (reprise à chaque release) |

## Reuse (existant, à ne pas réécrire)

- `URL_KEYS` + `useUrlSync` (`DagGanttWidget.jsx`) : **aucune nouvelle clé d'URL** —
  l'onglet actif et l'ouverture du panneau ne sont pas shareables (état purement local).
- `Select` + garde `HasNativeSelect` : réutilisé tels quels dans les deux onglets.
- `legendStates`, `stateSet`, `toggleState`, `STATE_COLORS` : alimentent à la fois la
  légende du bas et les cases de l'onglet Filtres.
- `SORT_OPTIONS`, `BIN_OPTIONS`/`binTitle`, `toggleCollapseAll`, `fetchData`,
  `computeWindow` : simplement déplacés dans l'onglet Affichage.
- Pattern `as="button"` de la légende (ligne ~1030) : même style pour les chips ✕.

## Steps

- [x] Step 1 — Extraire la barre du haut en sous-composant `ControlRibbon` (props : les
      états/setters existants), sans changement visuel (refactor à plat, vérifié au
      navigateur).
- [x] Step 2 — Ligne permanente : titre, date, emplacement onglets, statut condensé ;
      déplacer tri / agrégation / zoom / groupes / refresh dans un bloc « Affichage »
      caché, nom / tag / états / étapes dans un bloc « Filtres » caché.
- [x] Step 3 — Onglets Filtres / Affichage (Box/Button + ARIA, badge compteur de filtres
      actifs sur Filtres) + repli/dépli du panneau (déplié par défaut).
- [x] Step 4 — Chips des filtres actifs sous les onglets (tag, états, étapes, nom), ✕
      qui remet la valeur à vide.
- [x] Step 5 — Cases à cocher états dans l'onglet Filtres (mêmes données que la
      légende, légende du bas inchangée) + bouton « Réinitialiser les filtres ».
- [x] Step 6 — Tests headless (`js/test/render.test.mjs`) : onglets, panneau, chips,
      synchro cases↔légende ; `bun run test` et `test:dom` au vert.
- [x] Step 7 — Version 0.7.0 (`pyproject.toml` + cohérence Python + `js/package.json`),
      build (`cd js && bun run build`, recopie du bundle dans `static/`), README.
- [ ] Step 8 — (après validation, si demandé) commit local — jamais de push.

## Verification

- `cd js && bun run test && bun run test:dom` — au vert, y compris les nouveaux cas.
- `cd js && bun run build` puis recopie `dist/dag-gantt-widget.js` dans
  `src/airflow_dag_gantt/static/` (comme `build.sh`).
- `.venv` : `pytest` (dont `tests/test_plugin_packaging.py`, cohérence 0.7.0).
- Manuel (`dev.sh`) : charger `/dag-gantt` — panneau déplié sur Filtres ; basculer
  d'onglet ; replier → chips seules + Gantt qui remonte ; activer tag + 2 états →
  badge compteur + chips ; ✕ sur une chip → filtre retiré et la case/légende correspond
  se décoche ; URL partagée avec `?tag=…&state=failed` → mêmes chips au rechargement ;
  thème sombre/clair OK.


---

## Réalisé (11/11/2026) — écarts et décisions prises à l'exécution

Le plan a été suivi ; cinq précisions sont nées du code ou des tests :

1. **Le ruban ne se replie jamais en laissant des filtres actifs.** Cliquer l'onglet actif
   replie le panneau **seulement si aucun filtre n'agit** ; sinon il renvoie sur Filtres.
   Sinon on pouvait refermer le panneau avec la vue encore filtrée et pour seuls recours
   les puces (qui disent *ce qui* filtre, pas *comment* le retirer).
2. **Masquer, jamais démonter** (`hidden` + `data-visible` / `data-state`) : DOM et
   sélecteurs stables, et le Gantt ne se remonte pas quand on change d'onglet. Le marqueur
   `data-visible`/`data-state` existe parce que happy-dom ne rend pas l'attribut booléen
   `hidden` reçu en prop React — le test ne peut donc pas lire `hidden` directement.
3. **Cases d'état = états présents _ou_ sélectionnés** (pas tous les états connus) : une
   case grisée et muette pendant que la puce affiche encore le filtre est un piège ; les
   états absents de la journée encombrent inutilement. Chaque case porte son compteur de
   runs, calculé **hors filtre d'état** (ce que la case va ajouter/retirer).
4. **`data-gk-ui`** (interface) ≠ **`data-gk`** (barres) : le tooltip délégué s'appuie sur
   `data-gk`, un contrôle d'UI portant la même clé faussait le survol et les tests.
5. **`js/package.json` n'est pas aligné sur la version du plugin** (reste à 1.0.0) : seule
   la paire `pyproject.toml` / `__init__.py` bouge, contrôlée par
   `tests/test_plugin_packaging.py`.

### Vérifications faites

- `bun run test` : 30 tests (module d'agrégation) ;
- `bun run test:dom` : rendu headless sur 1127 runs **+ les 24 nouvelles assertions du
  ruban** (onglets, ouverture/repli, puces et ✕, cases d'état liées à la légende,
  réinitialisation qui garde la date, garde-fou « filtres actifs ») ;
- `pytest` : 8 passed, 1 skipped — dont la cohérence de version 0.7.0 ;
- `./build.sh` puis `./dev.sh js` : wheel 0.7.0 + bundle poussé dans le conteneur qui tourne.

### Reste à valider à l'œil (navigateur, Ctrl+Shift+R)

- densité réelle des deux panneaux (les libellés 10 px au-dessus des champs suffent-ils ?) ;
- rendu du thème sombre/clair sur les puces (`bg.subtle` + bordure) ;
- ordre des onglets et intitulés (« Filtres » / « Affichage ») — renommer est une ligne.

---

## Retour utilisateur sur la première mouture (11/11) — appliqué

Capture à l'appui, trois remarques ; les trois sont intégrées, la troisième avec une nuance :

1. **« il faut pouvoir replier les boutons Filtres pour regagner de la place »** — le garde-fou
   décrit plus haut (« pas de repli tant qu'un filtre est actif ») était **une erreur** : il
   privait justement de la place que le ruban est censé rendre. Il est retiré — le panneau se
   plie toujours. Ce qui rendait le garde-fou « nécessaire » (perdre la trace des filtres) est
   réglé autrement : les puces, désormais toujours visibles, portent chacune leur ✕.
2. **Puces à droite des onglets** (et non sous la ligne) : la ligne du haut ne fait plus jamais
   deux hauteurs, c'est plus lisible et ça ne mange pas la verticalité.
3. **`07:00 AM → 04:00 PM · 9h 00m` en haut à droite** : suppression, motif pris que **l'axe du
   Gantt dit déjà la fenêtre**. La ligne ne garde que ce que l'axe ne dit pas :
   `1 127 runs · 1 097 fusionnés`. La fenêtre, le mode (zoom auto / journée) et la tranche
   d'agrégation restent accessibles **en infobulle** sur ce texte.
   → Le « `vue 24h // vue détaillée` » proposé n'a pas été repris : ce mode est déjà le bouton
   🔍 Zoom auto / 🕐 Journée complète de l'onglet Affichage, l'afficher deux fois ferait deux
   sources de vérité. À rediscuter si l'état de la fenêtre te semble trop caché dans l'onglet.

Tests adaptés en conséquence : le repli avec filtres actifs est maintenant **assertion** (puces
restantes, retrait d'un filtre sans jamais rouvrir le panneau, vue qui change), et la fenêtre
vérifiée dans l'infobulle plutôt que dans la ligne.

## Deuxième retour (11/11) — appliqué

1. **Puce d'état de fenêtre `🔍 9 h` / `🕐 24 h`** à gauche du compteur de runs : l'étendue en
   deux caractères + le mode, et **cliquable** — elle bascule le même état `zoomAuto` que le
   bouton de l'onglet Affichage (une seule source de vérité, deux points d'entrée), et elle
   reste accessible **ruban replié** là où le bouton disparaît. Testée dans les deux sens
   (puce → bouton, bouton → puce).
2. **Panneau détaché du fond de page** : `bg="bg.subtle"` + `boxShadow="sm"` sur les deux
   panneaux (au lieu d'un `#eee` en dur : le token suit le thème et le branding d'instance,
   sombre comme clair). Liseré supérieur accentué **non retenu** : il reposait sur un token
   (`border.default`) jamais éprouvé sur cet hôte — un token inconnu en prod ne casse rien
   mais ne dessine rien, et rien ne le prouvait en test. À ajouter si le rendu te demande
   plus de structure.
3. La ligne du haut résumée : `🔍 9 h` `1 127 runs · 1 097 fusionnés`, le détail (bornes,
   mode, tranche d'agrégation) en infobulle.

## Troisième retour (11/11) — le fond sans l'ombre

`boxShadow="sm"` rendu sur l'instance : un **dégradé intense**, beaucoup plus présent que le
trait attendu. Ombre retirée, remplacée par ce qui était demandé — une arête basse :

- panneau : `bg="bg.subtle"` (inchangé) + contour `border.muted` + **`borderBottomColor="border.default"`** ;
- puces et cases d'état : contour `border.default` — `border.subtle` vaut gray.50 sur cet hôte,
  donc **invisible** sur fond blanc (c'est le nom qui trompe : « subtle » est le plus pâle ici).

Tokens vérifiés dans le bundle UI de l'hôte (`border.{subtle,muted,DEFAULT,emphasized}` =
gray.50 / 100 / 200 / … selon le mode) : `border.default` = gray.200 en clair ≈ le `#ddd` demandé,
gray.800 en sombre. D'où le token plutôt que le hex — un `#ddd` en dur ferait une tache en thème sombre.

## Quatrième retour (11/11) — les étapes ne sont pas un filtre

`Étapes (tags, ordre de priorité)` réglait le **regroupement** (quel tag devient le groupe, dans
quel ordre) mais vivait dans l'onglet Filtres, avec une puce retirable. Conséquences de la
reclassement en Affichage, champ **Ordre des groupes (tags, par priorité)** :

- **il sort des puces** : une puce dit « la vue est tronquée, clique pour arrêter » — ce n'est
  pas le cas ici, les mêmes runs restent affichés, seulement mieux rangés ;
- **il sort de `Réinitialiser les filtres`** (qui ne vide plus que nom / tag / états) : on ne
  perd pas son ordre de groupes en voulant enlever un tag ;
- **il ne compte plus dans `hasActiveFilters`** ;
- `?stages=` **voyage toujours** dans l'URL : l'ordre des groupes reste partageable, c'est bien
  un réglage de la vue — simplement pas un filtre.

Test : `?…&stages=collecte` donne **trois** puces (nom, tag, états) et pas quatre, le champ est
retrouvé dans `panel-view` et sa valeur survit à la réinitialisation.

## Quatrième retour (11/11) — les étapes sont un réglage de regroupement, pas un filtre

`Étapes (tags, ordre de priorité)` réglait le regroupement mais vivait dans Filtres, avec une puce
retirable. Déplacé dans l'onglet **Affichage**, champ **« Ordre des groupes (tags, par priorité) »**,
juste après le bouton Groupes/Liste. Trois conséquences qui découlent du reclassement :

- **suppression de la puce** : une puce dit « la vue est tronquée, clique pour arrêter » — faux ici,
  les mêmes runs restent affichés, seulement mieux rangés ;
- **`Réinitialiser les filtres` ne touche plus les étapes** (il ne vide plus que nom / tag / états) :
  on ne perd pas son ordre de groupes en voulant enlever un tag ;
- les étapes **ne comptent plus** dans `hasActiveFilters`.

Ce qui **ne change pas** : `?stages=` reste dans l'URL partageable — c'est bien un réglage de la vue,
simplement pas un filtre. Test : `?…&stages=collecte` donne **trois** puces (nom, tag, états), le
champ est retrouvé dans `panel-view` (`data-gk-ui="stages-input"`) et **sa valeur survit** à la
réinitialisation.
