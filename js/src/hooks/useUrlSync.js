import React, { useEffect, useRef } from 'react';
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

/* Signature de la vue : la même chaîne sert de **seule** dépendance des effets ci-dessous.
   L'objet `query` est neuf à chaque rendu (il sort de `viewToQuery`), sa forme sérialisée ne
   change que si la vue change — comparer la chaîne évite d'écrire dans l'URL à chaque rendu. */
const serialize = (query) =>
  URL_KEYS.filter((k) => query[k]).map((k) => `${k}=${encodeURIComponent(query[k])}`).join('&');

/* Ecrit les parametres non par defaut dans la query string (replaceState /
   setSearchParams replace = pas de spam dans l'historique). Les parametres etrangers a la
   vue sont conserves.
   Deux implémentations, choisies **au niveau du module** : un hook appelé dans une condition
   ferait varier l'ordre des hooks entre deux rendus, et React attacherait un état au mauvais
   hook. `HasSearchParams` est fixé à l'évaluation de `lib/host.js`, donc chaque variante
   appelle toujours les mêmes hooks, dans le même ordre.

   Même garde-fou dans les deux : **on n'écrit rien tant que la vue n'a pas bougé depuis le
   montage**. L'effet tourne à chaque montage, et sa première réaction serait de « remettre
   l'URL à l'aplomb » (un `?bin=auto` redondant, une date déjà implicite…). Or écrire dans
   l'URL passe par le routeur, donc est une **navigation** — et l'hôte remonte le widget sur
   navigation (README §3.2) : sans ce garde-fou, le widget s'offre un remontage à chaque
   ouverture de page, pour un gain nul. `dirty` reste vrai dès le premier changement, pour que
   revenir en arrière sur un filtre **nettoie** son paramètre au lieu de le laisser en fantôme. */
const useUrlSyncRouter = (query) => {
  const nextSearch = serialize(query);
  const baseline = useRef(nextSearch); // forme canonique de la vue au montage
  const dirty = useRef(false);
  const [sp, setSp] = Router.useSearchParams();
  useEffect(() => {
    if (!dirty.current) {
      if (nextSearch === baseline.current) return; // rien n'a été touché : on ne navigue pas
      dirty.current = true;
    }
    const merged = new URLSearchParams();
    sp.forEach((v, k) => {
      if (!URL_KEYS.includes(k)) merged.set(k, v);
    });
    URL_KEYS.forEach((k) => {
      if (query[k]) merged.set(k, query[k]);
    });
    if (merged.toString() !== sp.toString()) setSp(merged, { replace: true });
  }, [nextSearch, sp, setSp]); // eslint-disable-line react-hooks/exhaustive-deps
};

const useUrlSyncHistory = (query) => {
  const nextSearch = serialize(query);
  const baseline = useRef(nextSearch);
  const dirty = useRef(false);
  useEffect(() => {
    if (!dirty.current) {
      if (nextSearch === baseline.current) return;
      dirty.current = true;
    }
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

/** Routeur de l'hôte disponible → `setSearchParams`, sinon `history.replaceState`. */
export const useUrlSync = HasSearchParams ? useUrlSyncRouter : useUrlSyncHistory;
