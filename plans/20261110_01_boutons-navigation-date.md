# Boutons ◀ / ▶ autour du date picker

## Context

Dans la vue Dag Gantt, changer de journée impose d'ouvrir le date picker natif et de cliquer
dans le calendrier. Proposition retenue précédemment : encadrer le `<Input type="date">` de deux
boutons avec emoji flèche (⬅️ / ➡️) pour reculer/avancer d'un jour en un clic.

## Approach

Dans `js/src/DagGanttWidget.jsx` :

1. **Helper `shiftDate(iso, days)`** à côté de `todayLocal()` (l.~45) : décale une date
   `YYYY-MM-DD` de N jours en **temps local** (éviter les pièges UTC via `Date.parse`),
   en réutilisant le même formatage `pad()` que `todayLocal()`.

   ```js
   const shiftDate = (iso, days) => {
     const [y, m, d] = iso.split('-').map(Number);
     const dt = new Date(y, m - 1, d + days); // minuit local
     const pad = (n) => String(n).padStart(2, '0');
     return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
   };
   ```

2. **UI (l.~507-513)** : remplacer l'`Input type="date"` isolé par un `HStack gap={1}` compact :
   `⬅️ Button` — `Input` — `➡️ Button` (`size="sm"`, `variant="outline"`, même style que le
   bouton Refresh). `title="Jour précédent"` / `title="Jour suivant"`.

   Le reste de la toolbar (HStack gap={3}) est inchangé ; le groupe date reste un seul enfant du
   HStack parent, donc l'impact layout est minimal.

3. **Comportement** : `onClick={() => setDate((d) => shiftDate(d, -1))}` / `+1`.
   Le `date` change → `fetchData` se redéclenche déjà (useCallback dépend de `date`) et l'URL se
   synchronise via `useUrlSync` : aucune autre modif nécessaire.

4. **Blocage futur (décidé)** : bouton ➡️ `disabled={date >= todayLocal()}` (comparaison lexicale
   valide sur `YYYY-MM-DD`) — une journée future n'afficherait aucun run. ⬅️ reste toujours actif.
   Emojis retenus : **⬅️ / ➡️**.

## Files to modify

- `js/src/DagGanttWidget.jsx` — helper `shiftDate` + bloc date picker de la toolbar.

## Reuse

- `todayLocal()` (même fichier, l.~45) : pattern de formatage `YYYY-MM-DD` local.
- `Button` Chakra déjà destructuré (l.12) ; style `size="sm" variant="outline"` identique au
  bouton « ⟳ Refresh » (l.523).
- Chaîne de reactive existante : `date` → `fetchData` → `useUrlSync` (rien à ajouter).

## Steps

- [x] Ajouter `shiftDate()` à côté de `todayLocal()`
- [x] Encadrer l'Input de deux Buttons ⬅️/➡️ dans un HStack compact
- [x] Désactiver le bouton ➡️ quand `date >= todayLocal()`
- [x] Rebuild du bundle JS (`build.sh` / `dev.sh`) et vérification manuelle

## Verification

- `npm run build` dans `js/` (ou `./build.sh`) puis recharger la page du plugin.
- Cliquer ⬅️/➡️ : la date change d'un jour (y compris changement de mois/année : 31/01 → 01/02,
  31/12 → 01/01), le Gantt se recharge, l'URL `?date=` suit (et disparaît si on revient à
  aujourd'hui).
- Clavier : le date picker natif reste utilisable comme avant.
