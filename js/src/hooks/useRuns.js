import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { API_URL, REFRESH_MS } from '../lib/constants';
import { hasLiveRuns } from '../lib/view';

/* ------------------------------------------------------------------ */
/* Runs de la journée + rafraîchissement périodique léger + horloge     */
/* ------------------------------------------------------------------ */

/* Les runs vivent dans un **cache de module**, pas seulement dans le `useState` du
   composant, pour la raison apprise à leurs dépens avec `useRibbon` : l'UI d'Airflow recrée
   notre composant quand ça l'arrange (README §3.2, plan `20261112_03`). Sans mémoire, chaque
   remontage repartait de zéro et faisait défiler « Loading… » pendant un aller-retour API —
   le « hic-up » que l'on voit. Avec mémoire, le nouveau montage dessine **tout de suite** ce
   qu'il a déjà, puis rafraîchit en tâche de fond.

   Même gain sur la navigation de journée en journée (⬅️/➡️) : une journée déjà vue se
   redessine instantanément au lieu d'un « Loading… » par clic.

   D'où le plafond en LRU : une journée dense pèse plusieurs centaines de kilo-octets, on
   ne promène pas un mois de navigation en mémoire. Et « afficher d'abord, rafraîchir
   ensuite » ne veut pas dire afficher du périmé : la requête part quand même à chaque
   montage et à chaque changement de journée. */

const EMPTY = { runs: [], count: 0 };
const MAX_CACHED_DAYS = 5;

/** date -> payload, le plus récemment écrit en dernier (l'itération de `keys()` = le plus vieux). */
const cache = new Map();

const remember = (date, payload) => {
  cache.delete(date); // re-insertion = « le plus récent »
  cache.set(date, payload);
  if (cache.size > MAX_CACHED_DAYS) cache.delete(cache.keys().next().value);
};

export const useRuns = (date) => {
  // Initialiseurs **lazy** : un remontage repart de la mémoire, jamais d'une page blanche.
  // `state.date` porte la journée du payload : tant que l'effet réseau n'a pas répondu, c'est
  // cette clé qui décide si `state.data` est bien la journée demandée — jamais l'autre.
  const [state, setState] = useState(() => ({ date, data: cache.get(date) || EMPTY }));
  // Des requêtes en vol, pas un booléen : deux rafraîchissements qui se chevauchent ne peuvent
  // alors pas effacer le drapeau l'un de l'autre, et le `finally` peut être inconditionnel.
  const [inFlight, setInFlight] = useState(() => (cache.has(date) ? 0 : 1));
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  // Temps « gelé » à la minute : alimente rows, la fenêtre et les barres. Un run qui
  // tourne ne fait plus glisser la fenêtre ni re-render tout le Gantt toutes les 5 s ;
  // seule la ligne « maintenant » (1 élément) garde le `now` brut.
  const nowQ = Math.floor(now / 60000) * 60000;

  // Ce qu'on affiche **à ce rendu** : le payload de la journée demandée, qu'il vienne de l'état
  // ou de la mémoire. Un `useEffect` ne pourrait pas le faire — il tourne après la peinture, et
  // on verrait une frame de la journée précédente à chaque coup de ⬅️/➡️.
  const data = state.date === date ? state.data : cache.get(date) || EMPTY;

  const fetchData = useCallback(
    async (cancelToken) => {
      setInFlight((n) => n + 1);
      try {
        const response = await fetch(`${API_URL}?date=${date}`);
        if (cancelToken && cancelToken.aborted) return;
        if (!response.ok) throw new Error(`API ${response.status}`);
        const payload = await response.json();
        setState({ date, data: payload });
        remember(date, payload);
        setError(null);
      } catch (err) {
        if (cancelToken && cancelToken.aborted) return;
        setError(err.message);
      } finally {
        setInFlight((n) => Math.max(0, n - 1)); // inconditionnel : succès comme échec libèrent
      }
    },
    [date]
  );

  // Chargement + rafraichissement periodique leger (runs running, nouveaux runs)
  useEffect(() => {
    const cancelToken = { aborted: false };
    fetchData(cancelToken);
    const timer = setInterval(() => fetchData({ aborted: false }), REFRESH_MS);
    return () => {
      cancelToken.aborted = true;
      clearInterval(timer);
    };
  }, [fetchData]);

  // Tick leger pour etirer les barres running jusqu'a l'instant T : court seulement
  // s'il y a du mouvement (sinon 60 s, de toute façon rien ne bouge à la minute près).
  // `runs` plutot que `data` : la capture du memo est exactement sa dépendance.
  const { runs } = data;
  const hasLive = useMemo(() => hasLiveRuns(runs), [runs]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), hasLive ? 5000 : 60000);
    return () => clearInterval(timer);
  }, [hasLive]);

  const refresh = useCallback(() => fetchData(), [fetchData]);

  // « Loading… » **seulement quand il n'y a rien à montrer** : une requête en cours sur des
  // runs déjà affichés doit les laisser en place, pas les effacer 20 ms.
  return {
    data,
    loading: inFlight > 0 && data.runs.length === 0,
    error,
    refresh,
    now,
    nowQ,
  };
};
