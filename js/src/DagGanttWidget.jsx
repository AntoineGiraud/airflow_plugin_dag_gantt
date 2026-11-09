/**
 * Dag Gantt — vue macro de tous les DagRun d'une journée sur une ligne de temps.
 *
 * Consomme les libraries exposees par l'UI Airflow 3.3 sur globalThis
 * (voir webpack externals) : React, ChakraUI, ReactRouterDOM.
 * Rien n'est bundle : theme et branding de l'hote automatiquement appliqués.
 */
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import * as Chakra from '@chakra-ui/react';
import * as Router from 'react-router-dom';

const { Box, Flex, HStack, VStack, Text, Input, Button, Badge, Spacer } = Chakra;
// Guard : si un composant Chakra manque dans la version hotee, on degrade proprement.
const HasTooltip = Boolean(Chakra.TooltipRoot && Chakra.TooltipTrigger && Chakra.TooltipContent);
const HasNativeSelect = Boolean(Chakra.NativeSelectRoot && Chakra.NativeSelectField);
const RLink = Router.Link;

const API_URL = '/dag-gantt-plugin/api/runs';

// Palette officielle Airflow 3 (verifiee dans le bundle UI :
// {failed:'failed.solid', planned:'stone.solid', queued:'queued.solid',
//  running:'running.solid', success:'success.solid'})
const STATE_COLORS = {
  success: 'success.solid',
  failed: 'failed.solid',
  running: 'running.solid',
  queued: 'queued.solid',
  planned: 'stone.solid',
};
const DEFAULT_COLOR = 'gray.solid';
const STATE_ORDER = ['queued', 'running', 'success', 'failed'];

const LABEL_WIDTH = 240;
const BAR_HEIGHT = 18;
const BAR_GAP = 4;
const MAX_LANES = 6;
const REFRESH_MS = 30000; // rafraichissement leger (barres running + donnees)

const DAY_MS = 24 * 3600 * 1000;
const MIN_SPAN_MS = 3 * 3600 * 1000; // largeur mini de la fenetre en zoom auto : 3 h
const MARGIN_RATIO = 0.05; // ~5 % d'air de chaque cote
const TICK_STEPS_MIN = [5, 10, 15, 30, 60, 120, 240]; // paliers de graduation
const MAX_TICKS = 12;

const todayLocal = () => {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const fmtTime = (iso) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';

const fmtDuration = (ms) => {
  if (ms == null || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Plus petit palier tel qu'on garde <= MAX_TICKS graduations sur le span donne.
const pickStepMs = (spanMs) => {
  const step = TICK_STEPS_MIN.find((m) => spanMs / (m * 60000) <= MAX_TICKS);
  return (step || TICK_STEPS_MIN[TICK_STEPS_MIN.length - 1]) * 60000;
};

/* Fenetre affichee : journee complete [00:00, 24:00), ou zoom sur les runs filtres
   (1er start -> derniere fin, MIN_SPAN_MS minimum, bornes arrondies sur le palier
   de graduation et clampées dans la journee). */
const computeWindow = (runs, dayStart, zoom, nowMs) => {
  const dayEnd = dayStart + DAY_MS;
  const full = { windowStart: dayStart, windowSpan: DAY_MS, zoomed: false };
  if (!zoom || runs.length === 0) return full;

  let t0 = Infinity;
  let t1 = -Infinity;
  runs.forEach((r) => {
    const s = Date.parse(r.start);
    if (Number.isNaN(s)) return; // run sans start exploitable : ignore
    const e = r.end ? Date.parse(r.end) : nowMs; // running / queued -> etire jusqu'a maintenant
    t0 = Math.min(t0, s);
    t1 = Math.max(t1, Number.isNaN(e) ? s : e);
  });
  if (!Number.isFinite(t0)) return full; // aucun run avec un start valide

  const margin = Math.max((t1 - t0) * MARGIN_RATIO, 60000); // au moins 1 min d'air
  t0 -= margin;
  t1 += margin;
  if (t1 - t0 < MIN_SPAN_MS) {
    const mid = (t0 + t1) / 2; // run isolé / journee tres chargee -> 3 h centrees
    t0 = mid - MIN_SPAN_MS / 2;
    t1 = mid + MIN_SPAN_MS / 2;
  }
  if (t1 - t0 >= DAY_MS) return full;

  // Arrondi sur le palier de graduation, aligne sur minuit local (pas sur l'epoch :
  // les decalages de fuseau ne sont pas tous ronds).
  const stepMs = pickStepMs(t1 - t0);
  const align = (t, dir) => dayStart + dir((t - dayStart) / stepMs) * stepMs;
  t0 = align(t0, Math.floor);
  t1 = align(t1, Math.ceil);
  // Clamp dans la journee : si un bord depasse, on glisse la fenetre de l'autre cote.
  const span = Math.min(t1 - t0, DAY_MS);
  t0 = Math.min(Math.max(t0, dayStart), dayEnd - span);
  t1 = t0 + span;
  return { windowStart: t0, windowSpan: t1 - t0, zoomed: true };
};

/* ------------------------------------------------------------------ */
/* Barre d'un run                                                      */
/* ------------------------------------------------------------------ */

const GanttBar = ({ run, windowStart, windowSpan, now, chartWidth }) => {
  const startMs = Date.parse(run.start);
  const endMs = run.end ? Date.parse(run.end) : now; // running / queued -> etire jusqu'a maintenant
  const left = Math.max(0, ((startMs - windowStart) / windowSpan) * 100);
  const right = Math.min(100, ((endMs - windowStart) / windowSpan) * 100);
  const width = Math.max(right - left, 0.35);
  const color = STATE_COLORS[run.state] || DEFAULT_COLOR;
  const duration = endMs - startMs;
  // Label duree dans la barre si elle est assez large (~55 px) ; sans mesure
  // (ResizeObserver absent), seuil approximatif en % de la largeur totale.
  const widthPx = chartWidth ? (width / 100) * chartWidth : null;
  const showDuration = widthPx != null ? widthPx >= 55 : width >= 8;

  const gridUrl = `/dags/${encodeURIComponent(run.dag_id)}/runs/${encodeURIComponent(run.run_id)}`;

  const tooltipText =
    `${run.run_id}\n` +
    `${fmtTime(run.start)} → ${run.end ? fmtTime(run.end) : '(en cours)'} · ${fmtDuration(duration)}` +
    (run.tags.length ? `\ntags: ${run.tags.join(', ')}` : '');

  const bar = (
    <Box
      title={HasTooltip ? undefined : tooltipText} // fallback si pas de Tooltip hote
      bg={color}
      color="white"
      height={`${BAR_HEIGHT}px`}
      borderRadius="4px"
      position="absolute"
      top={`${(run._lane || 0) * (BAR_HEIGHT + BAR_GAP)}px`}
      left={`${left}%`}
      width={`${width}%`}
      fontSize="11px"
      lineHeight={`${BAR_HEIGHT}px`}
      px={1}
      whiteSpace="nowrap"
      overflow="hidden"
      cursor="pointer"
      opacity={run.state && run.state !== 'success' ? 1 : 0.9}
      border={run.state === 'running' ? '1px solid' : 'none'}
      borderColor="running.solid"
    >
      {run.state === 'running' ? '▶' : ''}
      {showDuration ? `${run.state === 'running' ? ' ' : ''}${fmtDuration(duration)}` : ''}
    </Box>
  );

  const linked = RLink ? (
    <RLink to={gridUrl} title={tooltipText}>
      {bar}
    </RLink>
  ) : (
    <a href={gridUrl} title={tooltipText}>{bar}</a>
  );

  if (!HasTooltip) return linked;

  return (
    <Chakra.TooltipRoot positioning={{ placement: 'top' }} openDelay={100}>
      <Chakra.TooltipTrigger asChild>{linked}</Chakra.TooltipTrigger>
      <Chakra.TooltipContent fontSize="12px" whiteSpace="pre-line">
        {tooltipText}
      </Chakra.TooltipContent>
    </Chakra.TooltipRoot>
  );
};

/* ------------------------------------------------------------------ */
/* Ligne d'un DAG (lane packing simple)                                */
/* ------------------------------------------------------------------ */

const DagRow = ({ dagId, runs, tags, windowStart, windowSpan, now, chartWidth }) => {
  // lanes gredy : chaque run dans la premiere lane libre
  const laneEnds = [];
  runs.forEach((run) => {
    const endMs = run.end ? Date.parse(run.end) : now;
    let lane = laneEnds.findIndex((end) => end <= Date.parse(run.start));
    if (lane === -1) {
      if (laneEnds.length < MAX_LANES) {
        laneEnds.push(endMs);
        lane = laneEnds.length - 1;
      } else {
        lane = MAX_LANES - 1; // surcharge : on empile dans la derniere
      }
    } else {
      laneEnds[lane] = endMs;
    }
    run._lane = lane;
  });
  const height = Math.max(laneEnds.length, 1) * (BAR_HEIGHT + BAR_GAP) + 4;

  return (
    <Flex borderBottom="1px solid" borderColor="border.subtle" alignItems="flex-start" py={1}>
      <Box width={`${LABEL_WIDTH}px`} flexShrink={0} pr={3} title={`${dagId}\ntags: ${tags.join(', ') || '—'}`}>
        <Text fontSize="13px" fontWeight="semibold" truncate>
          {dagId}
        </Text>
        <HStack gap={1} flexWrap="wrap">
          {tags.slice(0, 3).map((t) => (
            <Badge key={t} size="sm" colorPalette="purple" fontSize="9px">{t}</Badge>
          ))}
          {runs.length > 1 && (
            <Badge size="sm" colorPalette="gray" fontSize="9px">{runs.length}×{/* runs */ ''}</Badge>
          )}
        </HStack>
      </Box>
      <Box position="relative" flex="1" height={`${height}px`}>
        {runs.map((run) => (
          <GanttBar
            key={run.run_id}
            run={run}
            windowStart={windowStart}
            windowSpan={windowSpan}
            now={now}
            chartWidth={chartWidth}
          />
        ))}
      </Box>
    </Flex>
  );
};

/* ------------------------------------------------------------------ */
/* Widget principal                                                    */
/* ------------------------------------------------------------------ */

const Select = ({ value, onChange, options, placeholder }) => {
  // options : chaines ou {value, label} ; placeholder absent = pas d'option vide.
  const norm = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const field = norm.map((o) => (
    <option key={o.value} value={o.value}>{o.label}</option>
  ));
  if (!HasNativeSelect) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ height: '32px' }}>
        {placeholder && <option value="">{placeholder}</option>}
        {field}
      </select>
    );
  }
  return (
    <Chakra.NativeSelectRoot size="sm" width="auto" minW="120px">
      <Chakra.NativeSelectField placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)}>
        {field}
      </Chakra.NativeSelectField>
    </Chakra.NativeSelectRoot>
  );
};

// Tri des rangees de DAGs (valeurs partagees avec l'URL, cf. step URL sync)
const SORT_OPTIONS = [
  { value: 'first', label: 'Tri : 1er run' },
  { value: 'last', label: 'Tri : Dernier run' },
  { value: 'name', label: 'Tri : Nom DAG' },
  { value: 'count', label: 'Tri : Nb de runs' },
  { value: 'duration', label: 'Tri : Durée max' },
];
const DEFAULT_SORT = 'first';

/* --------- Etat des filtres dans l'URL (partageable, pas d'historique) --------- */

const HasSearchParams = Boolean(Router && typeof Router.useSearchParams === 'function');
const URL_KEYS = ['date', 'q', 'tag', 'state', 'sort', 'zoom'];

const readInitialQuery = () => {
  try {
    return new URLSearchParams(window.location.search);
  } catch (err) {
    return new URLSearchParams();
  }
};

// Ecrit les parametres non par defaut dans la query string (replaceState /
// setSearchParams replace = pas de spam dans l'historique). Les parametres
// etrangers a la vue sont conserves.
const useUrlSync = (query) => {
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

const DagGanttWidget = () => {
  // Hydratation depuis l'URL au montage (les valeurs par defaut ne sont pas reecrites).
  const [initialQuery] = useState(readInitialQuery);
  const hydratedSort = initialQuery.get('sort');

  const [date, setDate] = useState(initialQuery.get('date') || todayLocal());
  const [data, setData] = useState({ runs: [], truncated: false, count: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());

  // Filtres client-side
  const [nameFilter, setNameFilter] = useState(initialQuery.get('q') || '');
  const [tagFilter, setTagFilter] = useState(initialQuery.get('tag') || '');
  const [stateFilter, setStateFilter] = useState(() =>
    (initialQuery.get('state') || '').split(',').filter(Boolean)
  ); // multi-selection via la legende
  const [zoomAuto, setZoomAuto] = useState(initialQuery.get('zoom') !== 'day'); // false = journee complete 24 h
  const [sortKey, setSortKey] = useState(
    SORT_OPTIONS.some((o) => o.value === hydratedSort) ? hydratedSort : DEFAULT_SORT
  );

  // Largeur reelle de la zone de temps (px) -> sait quelles barres peuvent afficher leur duree.
  const chartRef = useRef(null);
  const [chartWidth, setChartWidth] = useState(0);

  useUrlSync({
    date: date !== todayLocal() ? date : '',
    q: nameFilter.trim(),
    tag: tagFilter,
    state: stateFilter.join(','),
    sort: sortKey !== DEFAULT_SORT ? sortKey : '',
    zoom: zoomAuto ? '' : 'day',
  });

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

  // Tick leger pour etirer les barres running jusqu'a l'instant T
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const allTags = useMemo(
    () => Array.from(new Set(data.runs.flatMap((r) => r.tags))).sort(),
    [data.runs]
  );
  const allStates = useMemo(() => {
    const found = new Set(data.runs.map((r) => r.state || 'none'));
    return STATE_ORDER.filter((s) => found.has(s)).concat(
      Array.from(found).filter((s) => !STATE_ORDER.includes(s)).sort()
    );
  }, [data.runs]);

  // Legende = tous les etats connus, meme absents de la journee (grises, non cliquables).
  const legendStates = useMemo(
    () => STATE_ORDER.concat(allStates.filter((s) => !STATE_ORDER.includes(s))),
    [allStates]
  );
  const toggleState = useCallback((s) => {
    setStateFilter((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : prev.concat(s)));
  }, []);
  const stateSet = useMemo(() => new Set(stateFilter), [stateFilter]);

  // Filtrage instantane sans rappel API
  const filtered = useMemo(() => {
    const needle = nameFilter.trim().toLowerCase();
    return data.runs.filter(
      (r) =>
        (!needle || r.dag_id.toLowerCase().includes(needle) || r.run_id.toLowerCase().includes(needle)) &&
        (!tagFilter || r.tags.includes(tagFilter)) &&
        (!stateFilter.length || stateSet.has(r.state || 'none'))
    );
  }, [data.runs, nameFilter, tagFilter, stateFilter, stateSet]);

  // Une ligne par DAG, triee selon le critere choisi
  const rows = useMemo(() => {
    const byDag = new Map();
    filtered.forEach((r) => {
      if (!byDag.has(r.dag_id)) byDag.set(r.dag_id, []);
      byDag.get(r.dag_id).push(r);
    });
    const list = Array.from(byDag.entries()).map(([dagId, runs]) => {
      runs.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      const lastRun = runs[runs.length - 1];
      const lastEnd = Date.parse(lastRun.end) || Date.parse(lastRun.start) || now;
      const maxDuration = Math.max(
        ...runs.map((r) => (r.end ? Date.parse(r.end) : now) - Date.parse(r.start))
      );
      return {
        dagId,
        runs,
        tags: runs[0].tags || [],
        firstStart: Date.parse(runs[0].start),
        lastEnd,
        count: runs.length,
        maxDuration,
      };
    });
    const comparators = {
      first: (a, b) => b.firstStart - a.firstStart,
      last: (a, b) => b.lastEnd - a.lastEnd,
      duration: (a, b) => b.maxDuration - a.maxDuration,
      count: (a, b) => b.count - a.count || a.dagId.localeCompare(b.dagId),
      name: (a, b) => a.dagId.localeCompare(b.dagId),
    };
    return list.sort(comparators[sortKey] || comparators[DEFAULT_SORT]);
  }, [filtered, sortKey, now]);

  // Fenetre affichee : zoom auto sur les runs filtres ou journee complete.
  const dayStart = useMemo(() => new Date(`${date}T00:00:00`).getTime(), [date]);

  // Mesure de la zone de temps (le header de l'echelle fait la meme largeur que les rangees)
  const hasRows = rows.length > 0;
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
  const { windowStart, windowSpan, zoomed } = useMemo(
    () => computeWindow(filtered, dayStart, zoomAuto, now),
    [filtered, dayStart, zoomAuto, now]
  );

  // Graduations adaptatives : palier choisi pour <= MAX_TICKS traits, aligne sur minuit local.
  const ticks = useMemo(() => {
    const stepMs = pickStepMs(windowSpan);
    const out = [];
    const first = dayStart + Math.ceil((windowStart - dayStart) / stepMs) * stepMs;
    const end = windowStart + windowSpan;
    for (let t = first; t <= end + 1; t += stepMs) {
      const d = new Date(t);
      const label =
        stepMs < 3600000
          ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : `${String(d.getHours()).padStart(2, '0')}h`;
      out.push({ t, pct: ((t - windowStart) / windowSpan) * 100, label });
    }
    return out;
  }, [dayStart, windowStart, windowSpan]);

  return (
    <Box p={4} maxW="100%" overflowX="auto">
      <VStack alignItems="stretch" gap={3}>
        <HStack gap={3} flexWrap="wrap">
          <Text fontSize="xl" fontWeight="bold">📊 Global Dag Gantt</Text>
          <Input
            type="date"
            size="sm"
            width="auto"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          <Input
            placeholder="Filtrer par nom de DAG ou run…"
            size="sm"
            maxW="240px"
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
          />
          <Select value={tagFilter} onChange={setTagFilter} options={allTags} placeholder="Tous les tags" />
          <Select value={sortKey} onChange={setSortKey} options={SORT_OPTIONS} />
          <Button size="sm" variant="outline" onClick={() => fetchData()}>
            ⟳ Refresh
          </Button>
          <Button
            size="sm"
            variant={zoomAuto ? 'solid' : 'outline'}
            onClick={() => setZoomAuto((z) => !z)}
            title="Zoom sur les runs filtres (3 h mini) / journee complete"
          >
            {zoomAuto ? '🔍 Zoom auto' : '🕐 Journée complète'}
          </Button>
          <Spacer />
          <Text fontSize="sm" color="fg.muted" title={zoomed ? 'Fenêtre ajustée aux runs filtrés' : 'Journée complète'}>
            {fmtClock(windowStart)} → {fmtClock(windowStart + windowSpan)} · {fmtDuration(windowSpan)}
          </Text>
          <Text fontSize="sm" color="fg.muted">
            {filtered.length} run{filtered.length > 1 ? 's' : ''}
            {data.truncated ? ' (tronqué, limite API)' : ''}
          </Text>
        </HStack>

        {error && (
          <Box bg="failed.surface" p={3} borderRadius="md">
            <Text color="failed.solid">Erreur API : {error}</Text>
          </Box>
        )}

        {loading ? (
          <Text>Loading…</Text>
        ) : rows.length === 0 ? (
          <Text color="fg.muted">Aucun run pour cette journée / ces filtres.</Text>
        ) : (
          <Box borderWidth="1px" borderColor="border.subtle" borderRadius="md" overflow="hidden">
            {/* Echelle de temps */}
            <Flex borderBottomWidth="1px" borderColor="border.subtle" bg="bg.subtle">
              <Box width={`${LABEL_WIDTH}px`} flexShrink={0} px={2}>
                <Text fontSize="11px" fontWeight="bold">DAG ({date})</Text>
              </Box>
              <Box ref={chartRef} position="relative" flex="1" height="22px">
                {ticks.map((t) => (
                  <Box
                    key={t.t}
                    position="absolute"
                    left={`${t.pct}%`}
                    top={0}
                    bottom={0}
                    borderLeftWidth="1px"
                    borderColor="border.subtle"
                  >
                    {t.label && (
                      <Text fontSize="10px" color="fg.muted" pl={1} whiteSpace="nowrap">
                        {t.label}
                      </Text>
                    )}
                  </Box>
                ))}
                {/* ligne "maintenant" : seulement si now est dans la fenetre affichee */}
                {now >= windowStart && now <= windowStart + windowSpan && (
                  <Box
                    position="absolute"
                    left={`${((now - windowStart) / windowSpan) * 100}%`}
                    top={0}
                    bottom={0}
                    borderLeftWidth="2px"
                    borderColor="running.solid"
                  />
                )}
              </Box>
            </Flex>
            {rows.map((row) => (
              <DagRow
                key={row.dagId}
                dagId={row.dagId}
                runs={row.runs}
                tags={row.tags}
                windowStart={windowStart}
                windowSpan={windowSpan}
                now={now}
                chartWidth={chartWidth}
              />
            ))}
          </Box>
        )}

        {/* Legende = filtre multi-etats cliquable (rien selectionne = tous les etats) */}
        <HStack gap={4} flexWrap="wrap">
          {legendStates.map((s) => {
            const present = allStates.includes(s);
            const active = stateSet.has(s);
            return (
              <HStack
                key={s}
                gap={1}
                as="button"
                type="button"
                cursor={present ? 'pointer' : 'not-allowed'}
                opacity={present ? 1 : 0.35}
                onClick={present ? () => toggleState(s) : undefined}
                title={
                  !present
                    ? `Aucun run « ${s} » cette journée`
                    : active
                      ? `Retirer le filtre « ${s} »`
                      : 'Filtrer sur cet état (cumulable)'
                }
              >
                <Box
                  width="12px"
                  height="12px"
                  borderRadius="2px"
                  bg={STATE_COLORS[s] || DEFAULT_COLOR}
                  outline={active ? '2px solid' : 'none'}
                  outlineColor="fg.default"
                  outlineOffset="1px"
                />
                <Text
                  fontSize="12px"
                  color="fg.muted"
                  fontWeight={active ? 'bold' : 'normal'}
                  textDecoration={active ? 'underline' : 'none'}
                >
                  {s}
                </Text>
              </HStack>
            );
          })}
          {stateFilter.length > 0 && (
            <Button size="xs" variant="ghost" onClick={() => setStateFilter([])}>
              ✕ tous les états
            </Button>
          )}
        </HStack>
      </VStack>
    </Box>
  );
};

export default DagGanttWidget;
