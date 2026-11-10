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

const LABEL_WIDTH = 280; // colonne de gauche : 150 px garantis au nom + place pour les badges
const BAR_HEIGHT = 14;
const BAR_GAP = 3;
const ROW_HEIGHT = BAR_HEIGHT + BAR_GAP; // pas vertical d'une lane (px)
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

// Decale une date locale 'YYYY-MM-DD' de `days` jours (minuit local : pas de decalage UTC).
const shiftDate = (iso, days) => {
  const [y, m, d] = (iso || todayLocal()).split('-').map(Number);
  if (!y || !m || !d) return todayLocal();
  const dt = new Date(y, m - 1, d + days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
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
/* Tag principal & groupement (fonctions pures, testables sans React)  */
/* ------------------------------------------------------------------ */

const OTHER_GROUP = 'autre';

const normalizeTag = (t) => String(t || '').trim().toLowerCase();

// Liste d'étapes priorisées saisie par l'utilisateur : « collecte, normalisation, export ».
const parseStages = (raw) =>
  String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Classement auto des tags par fréquence décroissante sur les DAGs affichés
// (égalité -> alphabétique : déterministe). Retourne Map tag -> rang (0 = mieux classé).
const computeTagRank = (rows) => {
  const freq = new Map();
  rows.forEach((row) => {
    new Set((row.tags || []).map(normalizeTag).filter(Boolean)).forEach((t) => {
      freq.set(t, (freq.get(t) || 0) + 1);
    });
  });
  const ranked = Array.from(freq.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rank = new Map();
  ranked.forEach(([t], i) => rank.set(t, i));
  return rank;
};

// Tag principal d'un DAG : premier tag de la liste d'étapes présent sur le DAG (override),
// sinon le tag le mieux classé par fréquence (auto). '' si aucun tag -> groupe « autre ».
const primaryTagOf = (tags, stages, tagRank) => {
  const lower = (tags || []).map((t) => [t, normalizeTag(t)]).filter(([, n]) => n);
  if (stages.length) {
    for (const stage of stages) {
      const ns = normalizeTag(stage);
      const hit = lower.find(([, n]) => n === ns);
      if (hit) return hit[0];
    }
    return '';
  }
  let best = '';
  let bestRank = Infinity;
  lower.forEach(([t, n]) => {
    const r = tagRank.has(n) ? tagRank.get(n) : Infinity;
    if (r < bestRank) {
      bestRank = r;
      best = t;
    }
  });
  return best;
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
      borderRadius="3px"
      position="absolute"
      top={`${(run._lane || 0) * (BAR_HEIGHT + BAR_GAP)}px`}
      left={`${left}%`}
      width={`${width}%`}
      fontSize="10px"
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

const DagRow = ({ dagId, runs, tags, primaryTag, groupTag, windowStart, windowSpan, now, chartWidth }) => {
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
  const height = Math.max(laneEnds.length, 1) * ROW_HEIGHT + 2;

  // Badges : le tag principal est masque quand il est deja porte par l'en-tete de groupe ;
  // sinon (liste plate) il reste en 1er badge. Max 2 badges au total, le reste en tooltip.
  const primaryShown = !(groupTag && groupTag.toLowerCase() === (primaryTag || '').toLowerCase());
  const secondary = tags.filter((t) => t !== primaryTag);
  const shownTags = (primaryShown && primaryTag ? [primaryTag] : []).concat(secondary).slice(0, 2);

  return (
    <Flex borderBottom="1px solid" borderColor="border.subtle" alignItems="center" py={0}>
      <Box
        width={`${LABEL_WIDTH}px`}
        flexShrink={0}
        px={2}
        display="flex"
        alignItems="center"
        gap={1}
        overflow="hidden"
        height={`${height}px`}
        title={`${dagId}\ntags: ${tags.join(', ') || '—'}`}
      >
        <Text fontSize="12px" fontWeight="semibold" truncate flexShrink={1} minW="150px">
          {dagId}
        </Text>
        {shownTags.map((t) => (
          <Badge key={t} size="sm" colorPalette="purple" fontSize="9px" flexShrink={0}>{t}</Badge>
        ))}
        {runs.length > 1 && (
          <Badge size="sm" colorPalette="gray" fontSize="9px" flexShrink={0}>{runs.length}×{/* runs */ ''}</Badge>
        )}
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
/* En-tete d'un groupe de tags (clic = replier / déplier)              */
/* ------------------------------------------------------------------ */

const GroupHeader = ({ group, collapsed, onToggle }) => (
  <Flex
    as="button"
    type="button"
    width="100%"
    alignItems="center"
    gap={2}
    px={2}
    py={1}
    bg="bg.subtle"
    borderBottomWidth="1px"
    borderColor="border.subtle"
    cursor="pointer"
    onClick={onToggle}
    title={collapsed ? 'Déplier ce groupe' : 'Replier ce groupe'}
  >
    <Text fontSize="11px" w="14px" flexShrink={0}>{collapsed ? '▶' : '▼'}</Text>
    {group.tag ? (
      <Badge size="sm" colorPalette="purple" fontSize="10px">{group.tag}</Badge>
    ) : (
      <Text fontSize="11px" fontStyle="italic" color="fg.muted">« {OTHER_GROUP} »</Text>
    )}
    <Text fontSize="11px" color="fg.muted">
      {group.dagCount} DAG{group.dagCount > 1 ? 's' : ''} · {group.runCount} run{group.runCount > 1 ? 's' : ''}
    </Text>
    {group.failedCount > 0 && (
      <HStack gap={1}>
        <Box width="8px" height="8px" borderRadius="2px" bg="failed.solid" />
        <Text fontSize="11px" color="failed.solid" fontWeight="bold">{group.failedCount} failed</Text>
      </HStack>
    )}
  </Flex>
);

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
const URL_KEYS = ['date', 'q', 'tag', 'state', 'sort', 'zoom', 'group', 'stages', 'collapsed'];

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

  // Groupement par tag principal (défaut : activé, ?group=0 = liste plate)
  const [grouped, setGrouped] = useState(initialQuery.get('group') !== '0');
  const [stagesText, setStagesText] = useState(initialQuery.get('stages') || ''); // ex. « collecte, normalisation, export »
  const [collapsed, setCollapsed] = useState(() =>
    // clés = tags normalisés (ou « autre »), séparés par des virgules dans l'URL
    new Set((initialQuery.get('collapsed') || '').split(',').filter(Boolean))
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
    group: grouped ? '' : '0', // défaut : groupé -> rien dans l'URL
    stages: stagesText.trim(),
    collapsed: Array.from(collapsed).join(','),
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

  // ---- Groupement par tag principal (le tri choisi s'applique à l'intérieur des groupes) ----
  const stages = useMemo(() => parseStages(stagesText), [stagesText]);
  const tagRank = useMemo(() => computeTagRank(rows), [rows]);

  const groups = useMemo(() => {
    const byKey = new Map();
    rows.forEach((row) => {
      const primary = primaryTagOf(row.tags, stages, tagRank); // casse d'origine conservée
      const key = normalizeTag(primary) || OTHER_GROUP;
      if (!byKey.has(key)) byKey.set(key, { key, tag: primary, rows: [] });
      byKey.get(key).rows.push({ ...row, primaryTag: primary });
    });
    const list = Array.from(byKey.values()).map((g) => ({
      key: g.key,
      tag: g.tag,
      rows: g.rows,
      dagCount: g.rows.length,
      runCount: g.rows.reduce((n, r) => n + r.count, 0),
      failedCount: g.rows.reduce(
        (n, r) => n + r.runs.filter((run) => run.state === 'failed').length,
        0
      ),
    }));
    const stageIdx = new Map(stages.map((s, i) => [normalizeTag(s), i]));
    const orderOf = (g) => (g.key !== OTHER_GROUP && stageIdx.has(g.key) ? stageIdx.get(g.key) : Infinity);
    list.sort((a, b) => {
      const otherA = a.key === OTHER_GROUP ? 1 : 0;
      const otherB = b.key === OTHER_GROUP ? 1 : 0;
      if (otherA !== otherB) return otherA - otherB; // « autre » toujours en dernier
      const oa = orderOf(a);
      const ob = orderOf(b);
      if (oa !== ob) return oa - ob; // ordre des étapes…
      return b.dagCount - a.dagCount || a.key.localeCompare(b.key); // …puis fréquence décroissante (auto)
    });
    return list;
  }, [rows, stages, tagRank]);

  const toggleCollapse = useCallback((key) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const groupKeys = useMemo(() => groups.map((g) => g.key), [groups]);
  const allCollapsed = groupKeys.length > 0 && groupKeys.every((k) => collapsed.has(k));
  const toggleCollapseAll = useCallback(() => {
    setCollapsed(() => (allCollapsed ? new Set() : new Set(groupKeys)));
  }, [allCollapsed, groupKeys]);

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
          <HStack gap={1}>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDate((d) => shiftDate(d, -1))}
              title="Jour précédent"
              aria-label="Jour précédent"
            >
              ⬅️
            </Button>
            <Input
              type="date"
              size="sm"
              width="auto"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => setDate((d) => shiftDate(d, 1))}
              disabled={!date || date >= todayLocal()}
              title={date >= todayLocal() ? "Aujourd'hui : pas de date future" : 'Jour suivant'}
              aria-label="Jour suivant"
            >
              ➡️
            </Button>
          </HStack>
          <Input
            placeholder="Filtrer par nom de DAG ou run…"
            size="sm"
            maxW="240px"
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
          />
          <Select value={tagFilter} onChange={setTagFilter} options={allTags} placeholder="Tous les tags" />
          <Input
            placeholder="Étapes (tags, ordre de priorité)…"
            size="sm"
            maxW="220px"
            value={stagesText}
            onChange={(e) => setStagesText(e.target.value)}
            title="Ex. collecte, normalisation, raffinement, export — le tag principal (donc le groupe) est le premier de cette liste présent sur le DAG. Vide = détection automatique."
          />
          <Select value={sortKey} onChange={setSortKey} options={SORT_OPTIONS} />
          <Button
            size="sm"
            variant={grouped ? 'solid' : 'outline'}
            onClick={() => setGrouped((g) => !g)}
            title="Regrouper les DAGs par tag principal / liste plate"
          >
            {grouped ? '🗂 Groupes' : '📄 Liste'}
          </Button>
          {grouped && groupKeys.length > 1 && (
            <Button size="sm" variant="ghost" onClick={toggleCollapseAll}>
              {allCollapsed ? '▸ Tout déplier' : '▾ Tout replier'}
            </Button>
          )}
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
              <Box ref={chartRef} position="relative" flex="1" height="20px">
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
            {grouped
              ? groups.map((group) => (
                  <Box key={group.key}>
                    <GroupHeader
                      group={group}
                      collapsed={collapsed.has(group.key)}
                      onToggle={() => toggleCollapse(group.key)}
                    />
                    {!collapsed.has(group.key) &&
                      group.rows.map((row) => (
                        <DagRow
                          key={row.dagId}
                          dagId={row.dagId}
                          runs={row.runs}
                          tags={row.tags}
                          primaryTag={row.primaryTag}
                          groupTag={group.tag}
                          windowStart={windowStart}
                          windowSpan={windowSpan}
                          now={now}
                          chartWidth={chartWidth}
                        />
                      ))}
                  </Box>
                ))
              : rows.map((row) => (
                  <DagRow
                    key={row.dagId}
                    dagId={row.dagId}
                    runs={row.runs}
                    tags={row.tags}
                    primaryTag={primaryTagOf(row.tags, stages, tagRank)}
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
