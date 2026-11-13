import React, { useCallback, useEffect, useState } from 'react';

/* ------------------------------------------------------------------ */
/* Onglet actif + ouvert/replié du ruban                               */
/* ------------------------------------------------------------------ */

/* Ouvert au montage, sur l'onglet Filtres ; re-cliquer l'onglet actif le replie, **y
   compris avec des filtres actifs** : la place rendue au Gantt prime, et rien n'est perdu
   — les puces restent visibles dans la ligne du haut et chacune se retire par son ✕.

   Pourquoi un état de **module** et non le `useState` du composant : l'UI d'Airflow recrée
   notre composant quand ça l'arrange (navigation, hydratation de sa propre liste de plugins).
   Mesuré dans la console le 12/11 — `ctrl+R` → onglet Affichage → un clic → le nœud du ruban
   est remplacé — et le `useState` local repartait alors à « ouvert sur Filtres » : le panneau
   se refermait « tout seul » à la première interaction, puis plus jamais (l'hôte, lui, ne
   remonte plus rien ensuite). Un `useState` est vassal du cycle de vie de l'hôte ; ce store
   non.

   La règle du plan 20261110_04 tient toujours : cet état ne va **pas** dans l'URL partageable
   (l'URL porte la VUE — filtres, tri, agrégation — pas l'interface). Il survit simplement aux
   remontages, le temps de l'onglet de navigateur. */

const DEFAULT_RIBBON = { open: true, tab: 'filters' };

let ribbon = DEFAULT_RIBBON;
const listeners = new Set();

const setRibbon = (next) => {
  ribbon = typeof next === 'function' ? next(ribbon) : next;
  listeners.forEach((notify) => notify());
};

export const useRibbon = () => {
  const [local, setLocal] = useState(ribbon);

  // Store externe vu de React : abonnement au montage, désabonnement au démontage. Pas de
  // `useSyncExternalStore` — le React consommé est celui de l'hôte (`globalThis`), et ce motif
  // là fonctionne sur toutes les versions qui ont des hooks.
  useEffect(() => {
    const notify = () => setLocal(ribbon);
    listeners.add(notify);
    setLocal(ribbon); // rattrape ce qui aurait changé entre le rendu et l'abonnement
    return () => {
      listeners.delete(notify);
    };
  }, []);

  const toggle = useCallback(
    (tab) =>
      setRibbon((prev) =>
        !prev.open || prev.tab !== tab ? { open: true, tab } : { open: false, tab: prev.tab }
      ),
    []
  );

  return { ...local, toggle };
};
