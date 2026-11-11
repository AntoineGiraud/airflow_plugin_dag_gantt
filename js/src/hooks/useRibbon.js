import React, { useState, useCallback } from 'react';

/* Ouvert au montage, sur l'onglet Filtres ; re-cliquer l'onglet actif le replie, **y
   compris avec des filtres actifs** : la place rendue au Gantt prime, et rien n'est perdu
   — les puces restent visibles dans la ligne du haut et chacune se retire par son ✕. */
export const useRibbon = () => {
  const [ribbon, setRibbon] = useState({ open: true, tab: 'filters' });
  const toggle = useCallback(
    (tab) =>
      setRibbon((prev) =>
        !prev.open || prev.tab !== tab ? { open: true, tab } : { open: false, tab: prev.tab }
      ),
    []
  );
  return { ...ribbon, toggle };
};