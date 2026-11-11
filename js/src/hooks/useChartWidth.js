import React, { useEffect, useRef, useState } from 'react';

/* Largeur réelle de la zone de temps (px) : c'est elle qui dit si une barre est assez
   grosse pour afficher sa durée ou son compte. `hasRows` en dépendance parce que la zone
   mesurée n'existe qu'une fois les lignes rendues. */
export const useChartWidth = (hasRows) => {
  const chartRef = useRef(null);
  const [chartWidth, setChartWidth] = useState(0);

  // Mesure de la zone de temps (le header de l'echelle fait la meme largeur que les rangees)
  useEffect(() => {
    const el = chartRef.current;
    if (!el) return undefined;
    if (typeof ResizeObserver === 'undefined') {
      setChartWidth(el.getBoundingClientRect().width);
      return undefined;
    }
    const observer = new ResizeObserver((entries) => {
      const w = entries[0] && entries[0].contentRect ? entries[0].contentRect.width : 0;
      if (w) setChartWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasRows]);

  return { chartRef, chartWidth };
};
