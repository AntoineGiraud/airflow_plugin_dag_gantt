import React, { useEffect } from 'react';
import { HasSearchParams, Router } from '../lib/host';

/* --------- Etat des filtres dans l'URL (partageable, pas d'historique) --------- */

export const URL_KEYS = ['date', 'q', 'tag', 'state', 'sort', 'zoom', 'group', 'stages', 'collapsed', 'bin'];

export const readInitialQuery = () => {
  try {
    return new URLSearchParams(window.location.search);
  } catch (err) {
    return new URLSearchParams();
  }
};

// Ecrit les parametres non par defaut dans la query string (replaceState /
// setSearchParams replace = pas de spam dans l'historique). Les parametres
// etrangers a la vue sont conserves.
export const useUrlSync = (query) => {
  const nextSearch = URL_KEYS.filter((k) => query[k]).map((k) => `${k}=${encodeURIComponent(query[k])}`).join('&');
  if (HasSearchParams) {
    const [sp, setSp] = Router.useSearchParams();
    useEffect(() => {
      const merged = new URLSearchParams();
      sp.forEach((v, k) => {
        if (!URL_KEYS.includes(k)) merged.set(k, v);
      });
      URL_KEYS.forEach((k) => {
        if (query[k]) merged.set(k, query[k]);
      });
      if (merged.toString() !== sp.toString()) setSp(merged, { replace: true });
    }, [nextSearch, sp, setSp]); // eslint-disable-line react-hooks/exhaustive-deps
    return;
  }
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      URL_KEYS.forEach((k) => url.searchParams.delete(k));
      URL_KEYS.forEach((k) => {
        if (query[k]) url.searchParams.set(k, query[k]);
      });
      if (url.search !== window.location.search) {
        window.history.replaceState(window.history.state, '', url);
      }
    } catch (err) {
      /* hors navigateur / URL invalide : on ignore */
    }
  }, [nextSearch]); // eslint-disable-line react-hooks/exhaustive-deps
};
