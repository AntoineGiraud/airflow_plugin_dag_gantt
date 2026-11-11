import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TIP_DELAY_MS } from '../lib/tipText';
import { tipTextFor } from '../lib/tipText';

/* Un seul tooltip pour tout le Gantt, piloté par délégation d'événement : 1 127 barres ne
   portent pas 1 127 gestionnaires. Le survol ne relie qu'une **clé** (`data-gk`) à l'item,
   et le texte n'est construit que pour celle-là. */
export const useHoverTip = (tipItems) => {
  const [tip, setTip] = useState(null);
  const tipItemsRef = useRef(tipItems);
  const hoverKeyRef = useRef(null);
  const tipTimerRef = useRef(null);
  useEffect(() => {
    tipItemsRef.current = tipItems;
    hoverKeyRef.current = null; // le contenu de la barre survolée a changé
  }, [tipItems]);
  useEffect(() => () => clearTimeout(tipTimerRef.current), []);

  const onChartMouseOver = useCallback((event) => {
    const target = event.target && event.target.closest ? event.target.closest('[data-gk]') : null;
    const key = target ? target.dataset.gk : null;
    if (key === hoverKeyRef.current) return; // rien à faire au mousemove : pas de re-render
    hoverKeyRef.current = key;
    clearTimeout(tipTimerRef.current);
    setTip(null);
    if (!key) return;
    const text = tipTextFor(tipItemsRef.current.get(key));
    if (!text) return;
    const rect = target.getBoundingClientRect();
    tipTimerRef.current = setTimeout(() => {
      setTip({ x: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom, text });
    }, TIP_DELAY_MS);
  }, []);

  const onChartMouseLeave = useCallback(() => {
    hoverKeyRef.current = null;
    clearTimeout(tipTimerRef.current);
    setTip(null);
  }, []);
  return { tip, onChartMouseOver, onChartMouseLeave };
};
