
---

## Bilan (exécution du 11/11)

**1 523 lignes → 21 fichiers**, conteneur descendu à **335 lignes**. `git diff --stat` :
1 908 ajouts / 1 268 suppressions (les suppressions *sont* les ajouts, déménagement).

| | avant | après |
| --- | --- | --- |
| `DagGanttWidget.jsx` | 1 523 | **335** |
| plus gros fichier | — | `ControlRibbon.jsx` 397 |
| tests JS | 30 + test DOM | **~120 assertions** (4 fichiers purs) + test DOM |

### Ce que la partie « mécanique » a attrapé, et pas l'œil

Le plan disait « recopier, pas retaper ». Trois retapes de moi sont passées par là et **une
n'aurait pas été vue par les tests** :

- `STATE_COLORS` : j'avais écrit `success: 'green.600'`… alors que l'original utilise les
  **tokens de thème** `success.solid`, `stone.solid` (et un état `planned` que j'avais perdu).
  Le stub Chakra du test DOM ignore les couleurs → **rendu silencieusement faux en
  production**. Rattrapé en comparant les tokens du fichier aux tranches d'origine.
- `PANEL_TABS` : `{ key, label, icon }`, pas `{ id, button, panel }`.
- `SORT_OPTIONS` : libellés préfixés « Tri : … », ordre différent.

D'où la règle appliquée ensuite sans exception : **corps des fonctions et constantes découpés
au ciseau dans le fichier d'origine**, puis vérification token à token (multiset des
identifiants, signature déduite) — `view.js` (6 fonctions), `buildTicks`, `buildGroups` et
`constants.js` sont ainsi **prouvés conformes**, à `export` près.

### Le garde-fou qui a vraiment décidé

`parseBin is not defined` : un identifiant libre n'est une erreur **ni pour webpack ni pour
Bun** — c'est une `ReferenceError` à l'exécution, vue seulement par le test DOM. D'où deux
contrôles ajoutés en cours de route :

- balayage « symbole de `lib/` utilisé mais non importé » sur les 9 nouveaux fichiers ;
- **parité DOM** : ancien code rejoué dans un arbre séparé, 9 instants du rendu vidés,
  `diff -rq` → **identique au bit près**. C'est ce qui conclut un refactor, mieux qu'un
  « les tests passent ».

Deux piges au passage : le harnais headless **avale les erreurs React** dans un tableau
vérifié en fin de fichier — un composant mort au montage 2 ne faisait échouer que l'assertion
de compteur, trois lignes plus loin ; et `console.log` dans le composant est le seul moyen de
voir que `data` restait à 0.

### Ce qui a dû être adapté hors périmètre JS

`tests/test_plugin_packaging.py` pointait `js/src/DagGanttWidget.jsx` pour deux contrats
(l'`API_URL` du bundle, l'absence de clé `truncated`). Le contrat est sain, l'emplacement non :
les deux tests balaient maintenant **toute l'arborescence `js/src`**, et le premier exige
**exactement une** définition d'`API_URL` (une duplication serait attrapée).

Version **0.7.1**, wheel rebâtie, bundle poussé dans le conteneur (md5 identiques).
