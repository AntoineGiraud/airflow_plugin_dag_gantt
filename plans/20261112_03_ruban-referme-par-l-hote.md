# Ruban refermé par l'hôte : état d'interface hors `useState` (v0.7.3)

## Contexte

Signal utilisateur, reproductible : `ctrl+R` sur `/dag-gantt` → onglet **Affichage** → un clic
quelque part → « paf, tout est rafraîchi », le panneau est refermé. **Une seule fois** : ensuite
tout roule, aussi bien sur les sélecteurs que sur les boutons.

Ce n'est **pas** une régression du refactor v0.7.3 (react-doctor reste à 92/100, 1 seul constat) :
c'est une fragilité préexistante, introduite par le plan `20261110_04` quand l'onglet ouvert et
l'ouvert/replié sont devenus un `useState` **local au composant** (pour ne pas polluer l'URL
partageable — intention toujours juste, support mal choisi).

## Diagnostic

**Ce qui a été éliminé.** Le geste rejoué dans le harnais headless (vrai composant, vrai DOM,
1 127 runs) : ouvrir Affichage → changer le sélecteur d'agrégation → cliquer « Fenêtre » → revenir
sur Filtres → changer un tag. Le panneau reste ouvert à chaque étape et le compteur de `fetch` ne
bouge pas → `useRibbon` n'est jamais remis à zéro par notre code. `useRibbon.toggle` n'est appelé
que par un clic sur un onglet.

**Ce qui a confirmé.** Sonde en console (MutationObserver sur `[data-gk-ui="ribbon"]` + sur
`data-visible` du panneau) :

```text
[gk] panel-view → yes        ← ouverture de l'onglet Affichage
[gk] REMONTAGE du widget     ← l'UI d'Airflow recrée notre composant
```

L'hôte **détruit et recrée** le composant. Or un `useState` est vassal du cycle de vie de celui-ci :
au remontage, le ruban revient à « ouvert sur Filtres ». Le « une seule fois » s'explique par la
nature du déclencheur côté hôte (hydratation de sa liste de plugins / navigation), qui ne se
produit qu'une fois par chargement de page.

Ce que le log de l'`api-server` ne **prouve pas** : il montre les requêtes du bundle, pas les
remontages sans rechargement — d'où la sonde.

## Approche

Deux changements, dans l'ordre d'importance :

1. **`hooks/useRibbon.js` : état de module + abonnement**, plus `useState` du composant. Petit store
   externe (`ribbon` + `listeners`) ; le hook s'abonne au montage et se désabonne au démontage. Pas
   de `useSyncExternalStore` : le React consommé est celui de l'hôte (`globalThis`), le motif
   classique fonctionne sur toute version à hooks. **L'URL ne change pas d'un octet** : l'onglet
   ouvert et l'ouvert/replié n'y entrent toujours pas — ils survivent juste aux remontages, le
   temps de l'onglet navigateur.
2. **`hooks/useUrlSync.js : plus aucune écriture d'URL tant que la vue n'a pas bougé** (`baseline` +
   `dirty`, dans les deux variantes routeur et `replaceState`). L'effet tournait au montage et
   « remettait l'URL à l'aplomb » (un `?bin=auto` redondant, une date déjà implicite) ; écrire dans
   l'URL passe par le routeur, donc **est une navigation**, et l'hôte remonte le widget sur
   navigation (README §3.2) : le widget s'offrait donc un remontage gratuit à chaque ouverture.
   `dirty` reste vrai après le premier changement, pour que revenir en arrière **nettoie** le
   paramètre au lieu de le laisser en fantôme.

## Fichiers modifiés

| Fichier | Changement |
| --- | --- |
| `js/src/hooks/useRibbon.js` | store de module + abonnement au lieu du `useState` local |
| `js/src/hooks/useUrlSync.js` | garde-fou `baseline` / `dirty` dans les deux variantes |
| `js/test/render.test.mjs` | le stub `useSearchParams` **enregistre** ses appels ; nouvelle section « l'hôte peut remonter le widget » ; la section repli amène le ruban explicitement sur Filtres |
| `README.md` | §3.2 : le remontage n'est pas que la navigation, l'état d'interface vit hors `useState` |
| `pyproject.toml`, `src/airflow_dag_gantt/__init__.py` | `0.7.2` → `0.7.3` |

## Vérification

```bash
cd js && bun run test && bun run test:dom   # + le scénario de remontage
npx -y react-doctor@latest                  # 92/100, 1 constat (le follow-up), rien de nouveau
./build.sh && AIRFLOW_HOME=$PWD/.airflow-home .venv/bin/pytest -q -rs tests
```

Pouvoir discriminant des deux nouvelles assertions (vérifié en raisonnant sur l'ancien code) :

- **aucune écriture au montage** : avec `?date=2026-11-10&bin=auto`, l'ancien code calculait
  `merged = date=…` contre `sp = date=…&bin=auto` → **écrivait** → l'assertion rouge ;
- **le panneau survit au remontage** : avec l'ancien `useRibbon`, après démontage/re-montage,
  `panel-view` revenait masqué → assertion rouge.

Contrôle manuel dans le navigateur (là où la sonde avait vu le remontage) : `ctrl+R` → Affichage →
clic partout → le panneau reste ouvert ; l'onglet choisi est encore là après être allé voir
ailleurs et être revenu.

## Suite donnée le même jour : le hic-up rendu **invisible**

Retour utilisateur après le premier correctif : « je retombe bien sur l'onglet où j'étais, mais j'ai encore le
hic-up ». Logique : le correctif précédent rend l'état **survivant**, il ne supprime pas le
remontage — c'est l'hôte qui le décide, on n'a pas la main. Ce qui reste visible, c'est son **coût** :
`useRuns` repartait de zéro, donc le Gantt **disparaissait** le temps d'un aller-retour API.

Même remède, appliqué aux données : `hooks/useRuns.js` garde les payloads dans un **cache LRU de
module** (5 journées, une journée dense pèse plusieurs centaines de ko). Un remontage redessine
tout de suite ce qu'il a en mémoire et rafraîchit en tâche de fond ; un ⬅️/➡️ sur une journée déjà
vue fait de même. Trois conséquences non triviales :

- **`loading` n'est plus un état mais une dérivation** : `inFlight > 0 && runs.length === 0`.
  « Loading… » n'apparaît donc **que quand il n'y a rien à montrer** — une requête de fond sur des
  runs déjà affichés ne les efface plus.
- **le nombre de requêtes en vol remplace le booléen** : deux rafraîchissements qui se chevauchent
  ne peuvent plus se marcher dessus, et le `finally` devient inconditionnel — c'est ce qu'exige la
  règle `no-loading-flag-reset-outside-finally`, apparue sur le coup (le reset était dans un
  `finally` mais **conditionnel** par le `cancelToken`, donc sautable : le détecteur n'avait pas
  tort). Le garde-fou `cancelToken` reste, mais ne protège plus que `setError`.
- **la journée affichée sette dérive au rendu, pas dans un effet** : `{ date, data }` dans l'état,
  et `data = state.date === date ? state.data : cache.get(date)`. Un `useEffect` n'aurait pas pu :
  il tourne **après** la peinture, et on aurait eu une frame de la journée précédente à chaque coup
  de flèche — montrer du périmé est pire qu'un « Loading… ».

### Vérification

Section « le hic-up lui-même » de `render.test.mjs`, avec réponse API volontairement **lente**
(250 ms) pour que la fenêtre de peinture soit observable :

- remontage → mêmes barres, aucun « Loading… » ;
- la requête de fond part quand même (compteur de `fetch`) — rien n'est retenu périmé ;
- ⬅️ vers une journée inédite → « Loading… » (jamais la journée d'à côté) ;
- ➡️ de retour sur la journée vue → barres identiques, sans « Loading… ».

Pouvoir discriminant vérifié : ces assertions **rougissent** sur le `useRuns` d'avant le cache. Et
`react-doctor` revient à **92/100, 1 constat** (le follow-up `js-set-map-lookups`), sans que la
nouvelle règle `no-loading-flag-reset-outside-finally` n'ait été supprimée ni masquée.

## Suite

- Le déclencheur exact côté hôte (hydratation des plugins ? navigation interne ?) reste **non
  identifié** — et n'a plus d'importance depuis que l'état d'interface ne dépend plus du cycle de
  vie du composant. À rouvrir seulement si un **autre** état local se met à clignoter : les
  filtres, le tri et l'agrégation, eux, vivent dans l'URL et y survivent donc déjà.
- `js-set-map-lookups` (`StateLegend.jsx:12`), follow-up du pass react-doctor.
