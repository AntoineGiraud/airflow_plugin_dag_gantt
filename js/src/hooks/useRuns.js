import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { API_URL, REFRESH_MS } from '../lib/constants';
import { hasLiveRuns } from '../lib/view';

/* Chargement des runs d'une journée + rafraîchissement périodique léger + horloge.
   Trois effets qui n'ont rien à voir avec le rendu : mieux vaut les lire isolés. */
export const useRuns = (date) => {
  const [data, setData] = useState({ runs: [], count: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  // Temps « gelé » à la minute : alimente rows, la fenêtre et les barres. Un run qui
  // tourne ne fait plus glisser la fenêtre ni re-render tout le Gantt toutes les 5 s ;
  // seule la ligne « maintenant » (1 élément) garde le `now` brut.
  const nowQ = Math.floor(now / 60000) * 60000;


  const fetchData = useCallback(
    async (cancelToken) => {
      try {
        const response = await fetch(`${API_URL}?date=${date}`);
        if (cancelToken && cancelToken.aborted) return;
        if (!response.ok) throw new Error(`API ${response.status}`);
        const payload = await response.json();
        setData(payload);
        setError(null);
      } catch (err) {
        if (cancelToken && cancelToken.aborted) return;
        setError(err.message);
      } finally {
        if (!cancelToken || !cancelToken.aborted) setLoading(false);
      }
    },
    [date]
  );

  // Chargement + rafraichissement periodique leger (runs running, nouveaux runs)
  useEffect(() => {
    setLoading(true);
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
  const hasLive = useMemo(() => hasLiveRuns(data), [data.runs]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), hasLive ? 5000 : 60000);
    return () => clearInterval(timer);
  }, [hasLive]);

  return { data, loading, error, refresh: () => fetchData(), now, nowQ };
};
