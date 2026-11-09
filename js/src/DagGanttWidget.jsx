/**
 * Dag Gantt — vue macro de tous les DagRun d'une journée sur une ligne de temps.
 *
 * Consomme les libraries exposees par l'UI Airflow 3.3 sur globalThis
 * (voir webpack externals) : React, ChakraUI, ReactRouterDOM.
 * Rien n'est bundle : theme et branding de l'hote automatiquement appliqués.
 */
import React, { useState, useEffect, useMemo, useCallback } from 'react';
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

/* ------------------------------------------------------------------ */
/* Barre d'un run                                                      */
/* ------------------------------------------------------------------ */

const GanttBar = ({ run, windowStart, windowSpan, now }) => {
  const startMs = Date.parse(run.start);
  const endMs = run.end ? Date.parse(run.end) : now; // running / queued -> etire jusqu'a maintenant
  const left = Math.max(0, ((startMs - windowStart) / windowSpan) * 100);
  const right = Math.min(100, ((endMs - windowStart) / windowSpan) * 100);
  const width = Math.max(right - left, 0.35);
  const color = STATE_COLORS[run.state] || DEFAULT_COLOR;
  const duration = endMs - startMs;

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

const DagRow = ({ dagId, runs, tags, windowStart, windowSpan, now }) => {
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
  if (!HasNativeSelect) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} style={{ height: '32px' }}>
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    );
  }
  return (
    <Chakra.NativeSelectRoot size="sm" width="auto" minW="120px">
      <Chakra.NativeSelectField placeholder={placeholder} value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </Chakra.NativeSelectField>
    </Chakra.NativeSelectRoot>
  );
};

const DagGanttWidget = () => {
  const [date, setDate] = useState(todayLocal());
  const [data, setData] = useState({ runs: [], truncated: false, count: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());

  // Filtres client-side
  const [nameFilter, setNameFilter] = useState('');
  const [tagFilter, setTagFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('');

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

  // Fenetre = journee locale [00:00, 24:00)
  const { windowStart, windowSpan } = useMemo(() => {
    const start = new Date(`${date}T00:00:00`).getTime();
    return { windowStart: start, windowSpan: 24 * 3600 * 1000 };
  }, [date]);

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

  // Filtrage instantane sans rappel API
  const filtered = useMemo(() => {
    const needle = nameFilter.trim().toLowerCase();
    return data.runs.filter(
      (r) =>
        (!needle || r.dag_id.toLowerCase().includes(needle) || r.run_id.toLowerCase().includes(needle)) &&
        (!tagFilter || r.tags.includes(tagFilter)) &&
        (!stateFilter || (r.state || 'none') === stateFilter)
    );
  }, [data.runs, nameFilter, tagFilter, stateFilter]);

  // Une ligne par DAG, triee par 1ere start
  const rows = useMemo(() => {
    const byDag = new Map();
    filtered.forEach((r) => {
      if (!byDag.has(r.dag_id)) byDag.set(r.dag_id, []);
      byDag.get(r.dag_id).push(r);
    });
    return Array.from(byDag.entries())
      .map(([dagId, runs]) => {
        runs.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
        return { dagId, runs, tags: runs[0].tags || [], firstStart: Date.parse(runs[0].start) };
      })
      .sort((a, b) => a.firstStart - b.firstStart);
  }, [filtered]);

  // Graduations horaires (label 1x / 2h)
  const ticks = useMemo(() => {
    const out = [];
    for (let h = 0; h <= 24; h += 1) {
      out.push({ pct: (h / 24) * 100, label: h % 2 === 0 ? `${String(h % 24).padStart(2, '0')}h` : '' });
    }
    return out;
  }, []);

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
          <Select value={stateFilter} onChange={setStateFilter} options={allStates} placeholder="Tous les états" />
          <Button size="sm" variant="outline" onClick={() => fetchData()}>
            ⟳ Refresh
          </Button>
          <Spacer />
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
              <Box position="relative" flex="1" height="22px">
                {ticks.map((t) => (
                  <Box
                    key={t.pct}
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
                {/* ligne "maintenant" */}
                {new Date(now).toDateString() === new Date(windowStart).toDateString() && (
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
              />
            ))}
          </Box>
        )}

        {/* Legende */}
        <HStack gap={4} flexWrap="wrap">
          {STATE_ORDER.map((s) => (
            <HStack key={s} gap={1}>
              <Box width="12px" height="12px" borderRadius="2px" bg={STATE_COLORS[s]} />
              <Text fontSize="12px" color="fg.muted">{s}</Text>
            </HStack>
          ))}
        </HStack>
      </VStack>
    </Box>
  );
};

export default DagGanttWidget;
