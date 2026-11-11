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
import { BIN_OPTIONS, autoBinMs, barHref, binLabel, bucketize, packLanes, parseBin } from './aggregation';

const { Box, Flex, HStack, VStack, Text, Input, Button, Badge, Spacer } = Chakra;
// Guard : si un composant Chakra manque dans la version hotee, on degrade proprement.
const HasNativeSelect = Boolean(Chakra.NativeSelectRoot && Chakra.NativeSelectField);
const HasNavigate = Boolean(Router && typeof Router.useNavigate === 'function');

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
const NO_ITEMS = []; // array partagé : garde l'identity stable pour React.memo
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

const fmtTimeMs = (ms) =>
  Number.isFinite(ms)
    ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';

const fmtTime = (iso) => fmtTimeMs(Date.parse(iso));

const fmtDuration = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

const fmtClock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Étendue de la fenêtre en deux caractères pour la puce : « 9 h », « 45 min », « 24 h ».
const fmtSpanShort = (ms) => {
  const h = Math.round(ms / 3600000);
  if (h >= 1) return `${h} h`;
  return `${Math.max(1, Math.round(ms / 60000))} min`;
};

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
/* Barre : run isolé ou bucket de runs (plus de lien / tooltip unitaire) */
/* ------------------------------------------------------------------ */

const MIN_COUNT_PX = 24; // place pour « 12× »
const MIN_DUR_PX = 55; // place pour « 4m 12s »

// `barHref` (lien d'une barre) et `packLanes` (hauteur de ligne) vivent dans
// `aggregation.js` : ce sont des fonctions pures, couvertes par le test node.


const Bar = React.memo(function Bar({ item, windowStart, windowSpan, chartWidth, dayStartMs }) {
  const startMs = item.startMs == null ? windowStart : item.startMs;
  const endMs = item.endMs == null || item.endMs < startMs ? startMs : item.endMs;
  const left = Math.max(0, ((startMs - windowStart) / windowSpan) * 100);
  const right = Math.min(100, ((endMs - windowStart) / windowSpan) * 100);
  const width = Math.max(right - left, 0.35);
  // Label dans la barre sans mesure (ResizeObserver absent) : seuil approximatif.
  const widthPx = chartWidth ? (width / 100) * chartWidth : null;
  const fits = (px) => (widthPx != null ? widthPx >= px : width >= 8);

  const parts = [];
  if (item.count > 1 && fits(MIN_COUNT_PX)) parts.push(`${item.count}×`);
  if (fits(MIN_DUR_PX)) parts.push(fmtDuration(endMs - startMs));

  const common = {
    bg: STATE_COLORS[item.state] || DEFAULT_COLOR,
    color: 'white',
    borderRadius: '3px',
    fontSize: '10px',
    lineHeight: `${BAR_HEIGHT}px`,
    px: 1,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    opacity: item.state && item.state !== 'success' ? 1 : 0.9,
    border: item.running ? '1px solid' : 'none', // bucket contenant un run en cours
    borderColor: 'running.solid',
  };
  const label = `${item.running ? '▶' : ''}${parts.length ? `${item.running ? ' ' : ''}${parts.join(' · ')}` : ''}`;

  // Seule une barre utile en clic est un lien : un **échec** (y compris dans un bucket,
  // pour aller voir les logs) ou un **run unique** (sa grille). Les buckets réussis
  // restent muets : moins de <a> dans le DOM, pas de fausse affordance, et le tooltip
  // donne déjà le détail. Le lien mène à la liste des runs du DAG **de cette journée**.
  const failed = item.state === 'failed';
  const linkable = failed || item.count === 1;
  const style = {
    position: 'absolute',
    top: `${(item.lane || 0) * ROW_HEIGHT}px`,
    left: `${left}%`,
    width: `${width}%`,
    height: `${BAR_HEIGHT}px`,
    // <a> est inline par défaut : sans bloc, la largeur/position en % ne suivent pas.
    display: 'block',
  };

  if (!linkable) {
    return (
      <Box
        data-gk={item.key}
        position="absolute"
        top={style.top}
        left={style.left}
        width={style.width}
        height={`${BAR_HEIGHT}px`}
        cursor="default"
        {...common}
      >
        {label}
      </Box>
    );
  }
  return (
    <a
      href={barHref(item, dayStartMs)}
      data-nav=""
      data-gk={item.key}
      className="gk-nav"
      title={
        item.kind === 'bucket'
          ? `${item.count} runs — ouvrir les runs du DAG de cette journée`
          : 'Ouvrir ce run'
      }
      style={style}
    >
      <Box width="100%" height="100%" cursor="pointer" {...common}>
        {label}
      </Box>
    </a>
  );
});

/* ---------------------- Tooltip partagé de tout le Gantt ---------------------- */

const TIP_DELAY_MS = 100; // même ressenti que l'ancien openDelay des TooltipRoot
const TIP_MAX_WIDTH = 380;
const TIP_RUN_LINES = 5; // lignes de runs détaillées dans le tooltip d'un bucket

const clip = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Texte du tooltip, construit **à la demande** (plus de concaténation de ~1270 chaînes au render). */
const tipTextFor = (item) => {
  if (!item) return '';
  if (item.kind !== 'bucket') {
    const run = item.run;
    const tags = run.tags && run.tags.length ? `\ntags: ${run.tags.join(', ')}` : '';
    return (
      `${run.run_id}\n` +
      `${fmtTime(run.start)} → ${run.end ? fmtTime(run.end) : '(en cours)'} · ` +
      `${fmtDuration(item.endMs - item.startMs)}${tags}`
    );
  }
  const repartition = Object.keys(item.states)
    .sort((a, b) => item.states[b] - item.states[a] || a.localeCompare(b))
    .map((state) => `${state} ${item.states[state]}`)
    .join(' · ');
  const lines = item.runs
    .slice(0, TIP_RUN_LINES)
    .map((run) => `  ${clip(run.run_id, 58)}  ${run.state || 'none'}`);
  const rest = item.count - lines.length;
  return [
    `${item.dagId} · ${item.count} runs · ${fmtTimeMs(item.startMs)} → ` +
      `${item.open ? '(en cours)' : fmtTimeMs(item.endMs)} · ${fmtDuration(item.endMs - item.startMs)}`,
    repartition,
    ...lines,
    rest > 0 ? `  … +${rest} autres` : '',
  ]
    .filter(Boolean)
    .join('\n');
};

const HoverTip = ({ tip }) => {
  if (!tip) return null;
  const vw = typeof window === 'undefined' ? 1280 : window.innerWidth;
  const half = TIP_MAX_WIDTH / 2;
  const left = Math.min(Math.max(tip.x, half + 4), Math.max(vw - half - 4, half + 4));
  const above = tip.top > 170; // sinon on passe sous la barre
  return (
    <Box
      data-tip="" /* marqueur du tooltip unique (tests / inspection devtools) */
      position="fixed"
      left={`${left}px`}
      top={`${(above ? tip.top : tip.bottom) + (above ? -8 : 8)}px`}
      transform={above ? 'translate(-50%, -100%)' : 'translate(-50%, 0)'}
      maxW={`${TIP_MAX_WIDTH}px`}
      zIndex={1200}
      bg="bg.panel"
      borderWidth="1px"
      borderColor="border.subtle"
      borderRadius="md"
      px={2}
      py={1}
      fontSize="11px"
      lineHeight="1.4"
      whiteSpace="pre-line"
      pointerEvents="none"
      boxShadow="md"
    >
      {tip.text}
    </Box>
  );
};

/* ------------------------------------------------------------------ */
/* Ligne d'un DAG (lane packing sur les items)                         */
/* ------------------------------------------------------------------ */

const DagRow = React.memo(function DagRow({
  dagId,
  items,
  runCount,
  tags,
  primaryTag,
  groupTag,
  windowStart,
  windowSpan,
  chartWidth,
  dayStartMs,
}) {
  const { packed, lanes } = useMemo(() => packLanes(items, MAX_LANES), [items]);
  const height = lanes * ROW_HEIGHT + 2;

  // Badges : le tag principal est masqué quand il est déjà porté par l'en-tête de groupe ;
  // sinon (liste plate) il reste en 1er badge. Max 2 badges au total.
  const primaryShown = !(groupTag && groupTag.toLowerCase() === (primaryTag || '').toLowerCase());
  const secondary = tags.filter((t) => t !== primaryTag);
  const shownTags = (primaryShown && primaryTag ? [primaryTag] : []).concat(secondary).slice(0, 2);

  return (
    <Flex borderBottom="1px solid" borderColor="border.subtle" alignItems="center" py={0}>
      <Box width={`${LABEL_WIDTH}px`} flexShrink={0} px={2} display="flex" alignItems="center" gap={1} overflow="hidden" height={`${height}px`}>
        {/* Le nom du DAG est le seul lien systématique de la ligne. */}
        <a
          href={`/dags/${encodeURIComponent(dagId)}`}
          data-nav=""
          className="gk-nav"
          title={`${dagId}\ntags: ${tags.join(', ') || '—'}\n\nOuvrir ce DAG`}
          style={{ minWidth: '150px', flexShrink: 1, display: 'block', overflow: 'hidden' }}
        >
          <Text fontSize="12px" fontWeight="semibold" truncate>
            {dagId}
          </Text>
        </a>
        {shownTags.map((t) => (
          <Badge key={t} size="sm" colorPalette="purple" fontSize="9px" flexShrink={0}>{t}</Badge>
        ))}
        {runCount > 1 && (
          <Badge size="sm" colorPalette="gray" fontSize="9px" flexShrink={0}>{runCount}×{/* runs */ ''}</Badge>
        )}
      </Box>
      <Box position="relative" flex="1" height={`${height}px`}>
        {packed.map((item) => (
          <Bar key={item.key} item={item} windowStart={windowStart} windowSpan={windowSpan} chartWidth={chartWidth} dayStartMs={dayStartMs} />
        ))}
      </Box>
    </Flex>
  );
});

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

const Select = ({ value, onChange, options, placeholder, title }) => {
  // options : chaines ou {value, label} ; placeholder absent = pas d'option vide.
  const norm = options.map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  const field = norm.map((o) => (
    <option key={o.value} value={o.value}>{o.label}</option>
  ));
  if (!HasNativeSelect) {
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} title={title} style={{ height: '32px' }}>
        {placeholder && <option value="">{placeholder}</option>}
        {field}
      </select>
    );
  }
  return (
    <Chakra.NativeSelectRoot size="sm" width="auto" minW="120px" title={title}>
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
const URL_KEYS = ['date', 'q', 'tag', 'state', 'sort', 'zoom', 'group', 'stages', 'collapsed', 'bin'];

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

/* ------------------------------------------------------------------ */
/* Ruban de contrôles (ligne permanente + puces + panneau à onglets)   */
/* ------------------------------------------------------------------ */

/* Organisation « à la Word/Excel » : les contrôles sont rangés par catégorie dans deux
   onglets, la ligne du haut ne gardant que l'essentiel (titre, date, onglets, compteurs).

   Deux règles non évidentes, toutes deux couvertes par `js/test/render.test.mjs` :

   - l'onglet actif et l'état ouvert/replié sont **locaux** : l'URL partageable ne porte
     toujours que la VUE (filtres, tri, agrégation, groupement…) ;
   - le ruban **masque, il ne démonte pas** — `hidden` pour le navigateur, plus
     `data-visible` / `data-state` relus par le test headless (happy-dom ne rend pas
     l'attribut booléen `hidden` reçu en prop React). Les contrôles d'interface portent
     donc `data-gk-ui`, à ne pas confondre avec `data-gk` qui identifie les **barres**
     (le survol et le tooltip délégué en dépendent). */
const PANEL_TABS = [
  { key: 'filters', label: 'Filtres', icon: '🔍' },
  { key: 'view', label: 'Affichage', icon: '⚙️' },
];

/* Ouvert au montage, sur l'onglet Filtres ; re-cliquer l'onglet actif le replie, **y
   compris avec des filtres actifs** : la place rendue au Gantt prime, et rien n'est perdu
   — les puces restent visibles dans la ligne du haut et chacune se retire par son ✕. */
const useRibbon = () => {
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

/* Libellé d'un contrôle du panneau, en 10 px au-dessus : chaque bloc se lit sans deviner
   à quoi sert le champ (le placeholder seul ne suffit pas, surtout pour les selects).
   Sans libellé, une espace insécable est réservée : un bouton aligné à droite du panneau
   se trouve ainsi sur la même ligne que les champs, pas collé en haut. */
const NBSP = '\u00a0';
const Field = ({ label = NBSP, title, children }) => (
  <VStack gap={1} alignItems="flex-start">
    <Text fontSize="10px" color="fg.muted" title={title}>
      {label}
    </Text>
    {children}
  </VStack>
);

/* Puce de filtre actif : libellé + valeur + ✕ qui remet la valeur à vide. Visible tant que
   le filtre est actif, masquée sinon — jamais démontée : une vue filtrée doit rester
   explicable même ruban replié. */
const FilterChip = ({ name, shown, label, value, onClear }) => (
  <HStack
    gap={1}
    as="button"
    type="button"
    data-gk-ui={`chip-${name}`}
    data-visible={shown ? 'yes' : 'no'}
    hidden={!shown}
    px={2}
    py="2px"
    borderWidth="1px"
    borderColor="border.default"
    borderRadius="full"
    fontSize="11px"
    cursor="pointer"
    bg="bg.subtle"
    onClick={onClear}
    title={`${label} : ${value} — cliquer pour retirer ce filtre`}
  >
    <Text as="span" fontSize="11px" color="fg.muted">{label}</Text>
    <Text as="span" fontWeight="semibold">{clip(value, 40)}</Text>
    <Text as="span" color="fg.muted">✕</Text>
  </HStack>
);

/* Cases d'état du panneau Filtres : **mêmes données et même état** que la légende
   cliquable du bas (legendStates / toggleState) — les deux restent synchronisées.

   Rendues pour les états **présents dans la journée ou déjà sélectionnés**, dans cet
   ordre : un état sélectionné reste donc toujours maniable (sinon la case deviendrait
   muette pendant que la puce, elle, affiche encore ce filtre), et les états absents
   n'encombrent pas le panneau. */
const StateChecks = ({ states, stateSet, counts, onToggle }) => {
  const shownStates = states.filter((s) => (counts[s] || 0) > 0 || stateSet.has(s));
  return (
    <HStack gap={3} flexWrap="wrap" data-gk-ui="state-checks">
      {shownStates.map((s) => {
        const active = stateSet.has(s);
        const count = counts[s] || 0;
        return (
          <HStack
            key={s}
            gap={1}
            as="button"
            type="button"
            data-gk-ui={`state-${s}`}
            data-state={active ? 'on' : 'off'}
            aria-pressed={active}
            onClick={() => onToggle(s)}
            title={
              active
                ? `Retirer le filtre « ${s} »`
                : `Filtrer sur cet état (cumulable)${count ? ` · ${count} runs` : ''}`
            }
          >
            <Box
              width="12px"
              height="12px"
              borderRadius="3px"
              borderWidth="1px"
              borderColor="border.default"
              bg={active ? STATE_COLORS[s] || DEFAULT_COLOR : 'transparent'}
              color="white"
              fontSize="9px"
              lineHeight="12px"
              textAlign="center"
            >
              {active ? '✓' : ''}
            </Box>
            <Text as="span" fontSize="12px" fontWeight={active ? 'bold' : 'normal'}>
              {s}
              {count ? ` (${count})` : ''}
            </Text>
          </HStack>
        );
      })}
    </HStack>
  );
};

const ControlRibbon = ({
  ribbon,
  date,
  setDate,
  loading,
  error,
  nameFilter,
  setNameFilter,
  tagFilter,
  setTagFilter,
  allTags,
  stagesText,
  setStagesText,
  legendStates,
  stateSet,
  stateCounts,
  toggleState,
  setStateFilter,
  resetFilters,
  hasActiveFilters,
  sortKey,
  setSortKey,
  bin,
  setBin,
  binTitle,
  zoomAuto,
  setZoomAuto,
  grouped,
  setGrouped,
  showCollapseAll,
  allCollapsed,
  toggleCollapseAll,
  onRefresh,
  summaryLabel,
  summaryTitle,
  windowChipLabel,
  windowChipTitle,
}) => {
  // Combien de puces sont visibles : 0 -> le conteneur lui-même se met en `hidden`
  // (il reste dans le DOM, comme les puces et les panneaux).
  const activeChips = (nameFilter.trim() ? 1 : 0) + (tagFilter ? 1 : 0) + (stateSet.size > 0 ? 1 : 0);
  return (
    <VStack alignItems="stretch" gap={2} data-gk-ui="ribbon">
      {/* Ligne permanente : titre, date, onglets, statut — visible même ruban replié. */}
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
        {/* Onglets fabriqués avec les composants déjà sûrs de l'hôte (pas de Tabs
            Chakra dont la présence n'est pas garantie — même garde-fou que NativeSelect). */}
        <HStack gap={1} role="tablist" data-gk-ui="tabs" aria-label="Catégories de contrôles">
          {PANEL_TABS.map((t) => {
            const active = ribbon.open && ribbon.tab === t.key;
            return (
              <Button
                key={t.key}
                size="sm"
                role="tab"
                data-gk-ui={`tab-${t.key}`}
                variant={active ? 'solid' : 'outline'}
                aria-selected={active}
                aria-expanded={active}
                onClick={() => ribbon.toggle(t.key)}
                title={`${t.label} — cliquer pour ${active ? 'replier' : 'ouvrir'}`}
              >
                {t.icon} {t.label}
              </Button>
            );
          })}
        </HStack>
        {/* Puces des filtres actifs, **à droite des onglets** : c'est ce qui rappelle que
            la vue est filtrée quand le panneau est replié, et chacune se retire par son ✕.
            Jamais démontées, seulement masquées — DOM et sélecteurs restent stables. */}
        <HStack gap={2} flexWrap="wrap" data-gk-ui="chips" hidden={activeChips === 0}>
          <FilterChip name="q" shown={Boolean(nameFilter.trim())} label="nom" value={nameFilter.trim()} onClear={() => setNameFilter('')} />
          <FilterChip name="tag" shown={Boolean(tagFilter)} label="tag" value={tagFilter} onClear={() => setTagFilter('')} />
          <FilterChip
            name="state"
            shown={stateSet.size > 0}
            label="états"
            value={Array.from(stateSet).join(', ')}
            onClear={() => setStateFilter([])}
          />
        </HStack>
        <Spacer />
        {/* Puce d'état de la fenêtre : ce que l'axe montre (l'étendue) et le mode qui le
            produit, en deux caractères — et **cliquable**, puisqu'elle ne fait que renvoyer
            au même état `zoomAuto` que l'onglet Affichage : une seule source de vérité,
            deux façons d'agir dessus. */}
        <HStack
          as="button"
          type="button"
          gap={1}
          px={2}
          py="2px"
          borderWidth="1px"
          borderColor="border.default"
          borderRadius="full"
          bg="bg.subtle"
          fontSize="11px"
          cursor="pointer"
          whiteSpace="nowrap"
          data-gk-ui="window-chip"
          onClick={() => setZoomAuto((z) => !z)}
          title={windowChipTitle}
        >
          <Text as="span">{zoomAuto ? '🔍' : '🕐'}</Text>
          <Text as="span" fontWeight="semibold">{windowChipLabel}</Text>
        </HStack>
        {/* La ligne du haut ne garde que ce que l'axe du Gantt ne dit pas : combien de runs
            survivent aux filtres et combien l'agrégation en a fusionnés. Fenêtre, bornes et
            tranche passent en infobulle. */}
        <Text fontSize="sm" color="fg.muted" data-gk-ui="summary" title={summaryTitle}>
          {summaryLabel}
        </Text>
      </HStack>

      {/* Panneau : fond `bg.subtle` (gray.50 / gray.950) pour le détacher de la page, bord
          `border.muted` et **arête basse** `border.default` (gray.200 / gray.800) — le liseré
          demandé, en tokens : un #ddd en dur ferait une tache en thème sombre. Pas d'ombre :
          `boxShadow` rend un dégradé bien plus lourd que le trait attendu (retour utilisateur).
          Tokens vérifiés dans le thème de l'hôte (bundle UI : border.{subtle,muted,DEFAULT,
          emphasized} = gray.50/100/200/… selon le mode). */}
      <Flex
        data-gk-ui="panel-filters"
        role="tabpanel"
        data-visible={ribbon.open && ribbon.tab === 'filters' ? 'yes' : 'no'}
        hidden={!(ribbon.open && ribbon.tab === 'filters')}
        wrap="wrap"
        gap={4}
        alignItems="flex-start"
        px={3}
        py={2}
        borderWidth="1px"
        borderColor="border.muted"
        borderBottomColor="border.default"
        borderRadius="md"
        bg="bg.subtle"
      >
        <Field label="Nom de DAG / run">
          <Input
            placeholder="Filtrer par nom de DAG ou run…"
            size="sm"
            maxW="240px"
            value={nameFilter}
            onChange={(e) => setNameFilter(e.target.value)}
          />
        </Field>
        <Field label="Tag">
          <Select value={tagFilter} onChange={setTagFilter} options={allTags} placeholder="Tous les tags" />
        </Field>
        <Field label="États (cumulables)" title="Les mêmes que la légende cliquable en bas du Gantt — les deux sont synchronisés.">
          <StateChecks states={legendStates} stateSet={stateSet} counts={stateCounts} onToggle={toggleState} />
        </Field>
        <Spacer />
        <Field>
          <Button
            size="sm"
            variant="ghost"
            disabled={!hasActiveFilters}
            onClick={resetFilters}
            title="Remettre à vide nom, tag, états et étapes (la date est conservée)"
          >
            ✕ Réinitialiser les filtres
          </Button>
        </Field>
      </Flex>

      <Flex
        data-gk-ui="panel-view"
        role="tabpanel"
        data-visible={ribbon.open && ribbon.tab === 'view' ? 'yes' : 'no'}
        hidden={!(ribbon.open && ribbon.tab === 'view')}
        wrap="wrap"
        gap={4}
        alignItems="flex-start"
        px={3}
        py={2}
        borderWidth="1px"
        borderColor="border.muted"
        borderBottomColor="border.default"
        borderRadius="md"
        bg="bg.subtle"
      >
        <Field label="Ordre des lignes">
          <Select value={sortKey} onChange={setSortKey} options={SORT_OPTIONS} />
        </Field>
        <Field label="Agrégation des runs">
          <Select value={bin} onChange={setBin} options={BIN_OPTIONS} title={binTitle} />
        </Field>
        <Field label="Fenêtre">
          <Button
            size="sm"
            variant={zoomAuto ? 'solid' : 'outline'}
            onClick={() => setZoomAuto((z) => !z)}
            title="Zoom sur les runs filtres (3 h mini) / journee complete"
          >
            {zoomAuto ? '🔍 Zoom auto' : '🕐 Journée complète'}
          </Button>
        </Field>
        <Field label="Regroupement">
          <HStack gap={1}>
            <Button
              size="sm"
              variant={grouped ? 'solid' : 'outline'}
              onClick={() => setGrouped((g) => !g)}
              title="Regrouper les DAGs par tag principal / liste plate"
            >
              {grouped ? '🗂 Groupes' : '📄 Liste'}
            </Button>
            {showCollapseAll && (
              <Button size="sm" variant="ghost" onClick={toggleCollapseAll}>
                {allCollapsed ? '▸ Tout déplier' : '▾ Tout replier'}
              </Button>
            )}
          </HStack>
        </Field>
        {/* Les étapes ne filtrent rien : elles disent **comment** les DAGs sont groupés
            (quel tag devient le groupe, et dans quel ordre). Leur place est donc ici, à
            côté du regroupement — ni dans les filtres, ni dans les puces retirables. */}
        <Field label="Ordre des groupes (tags, par priorité)">
          <Input
            data-gk-ui="stages-input"
            placeholder="ex. collecte, normalisation, export"
            size="sm"
            maxW="220px"
            value={stagesText}
            onChange={(e) => setStagesText(e.target.value)}
            title="Ex. collecte, normalisation, raffinement, export — le tag principal (donc le groupe) est le premier de cette liste présent sur le DAG. Vide = détection automatique par fréquence. Ne filtre rien : ça ne change que l'ordre et l'appartenance des groupes."
          />
        </Field>
        <Spacer />
        <Field>
          {/* `data-gk-ui` : sélecteur stable pour les tests, sans rapport avec `data-gk` (les barres). */}
          <Button
            size="sm"
            variant="outline"
            data-gk-ui="refresh"
            onClick={onRefresh}
            title="Recharger les runs de la journée (sinon rafraîchissement auto toutes les 30 s)"
          >
            ⟳ Rafraîchir
          </Button>
        </Field>
      </Flex>

      {error && (
        <Box bg="failed.surface" p={3} borderRadius="md">
          <Text color="failed.solid">Erreur API : {error}</Text>
        </Box>
      )}
    </VStack>
  );
};

const DagGanttWidget = () => {
  // Hydratation depuis l'URL au montage (les valeurs par defaut ne sont pas reecrites).
  const [initialQuery] = useState(readInitialQuery);
  const hydratedSort = initialQuery.get('sort');

  const [date, setDate] = useState(initialQuery.get('date') || todayLocal());
  const [data, setData] = useState({ runs: [], count: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(Date.now());
  // Temps « gelé » à la minute : alimente rows, la fenêtre et les barres. Un run qui
  // tourne ne fait plus glisser la fenêtre ni re-render tout le Gantt toutes les 5 s ;
  // seule la ligne « maintenant » (1 élément) garde le `now` brut.
  const nowQ = Math.floor(now / 60000) * 60000;

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

  // Agrégation des runs en buckets : 'auto' (granularité selon la fenêtre, 30 min max),
  // 'off' (une barre par run) ou une tranche fixe ('1m'..'60m').
  const [bin, setBin] = useState(() => {
    const raw = initialQuery.get('bin');
    return BIN_OPTIONS.some((o) => o.value === raw) ? raw : 'auto';
  });

  // Groupement par tag principal (défaut : activé, ?group=0 = liste plate)
  const [grouped, setGrouped] = useState(initialQuery.get('group') !== '0');
  const [stagesText, setStagesText] = useState(initialQuery.get('stages') || ''); // ex. « collecte, normalisation, export »
  const [collapsed, setCollapsed] = useState(() =>
    // clés = tags normalisés (ou « autre »), séparés par des virgules dans l'URL
    new Set((initialQuery.get('collapsed') || '').split(',').filter(Boolean))
  );

  // Filtres « agissants » : ce que le ruban affiche en puces. `resetFilters` ne touche ni
  // la date (on remet la vue à zéro sans changer de journée) ni les étapes (réglage de
  // regroupement, pas un filtre — voir l'onglet Affichage).
  const hasActiveFilters = Boolean(nameFilter.trim() || tagFilter || stateFilter.length > 0);
  const resetFilters = useCallback(() => {
    setNameFilter('');
    setTagFilter('');
    setStateFilter([]);
  }, []);

  // Onglet actif + ouvert/replié du ruban : état **local**, jamais dans l'URL partageable.
  const ribbon = useRibbon();

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
    bin: bin !== 'auto' ? bin : '', // défaut = auto -> URL propre
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

  // Tick leger pour etirer les barres running jusqu'a l'instant T : court seulement
  // s'il y a du mouvement (sinon 60 s, de toute façon rien ne bouge à la minute près).
  const hasLive = useMemo(
    () => data.runs.some((r) => r.state === 'running' || r.state === 'queued'),
    [data.runs]
  );
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), hasLive ? 5000 : 60000);
    return () => clearInterval(timer);
  }, [hasLive]);

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

  // Nombre de runs par état **sur les filtres hors état** : ce que chaque case ajoutera
  // ou retirera (la légende du bas, elle, compte sur la journée entière).
  const stateCounts = useMemo(() => {
    const needle = nameFilter.trim().toLowerCase();
    const out = {};
    data.runs.forEach((r) => {
      if (needle && !(r.dag_id.toLowerCase().includes(needle) || r.run_id.toLowerCase().includes(needle))) return;
      if (tagFilter && !r.tags.includes(tagFilter)) return;
      const s = r.state || 'none';
      out[s] = (out[s] || 0) + 1;
    });
    return out;
  }, [data.runs, nameFilter, tagFilter]);

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
      const lastEnd = Date.parse(lastRun.end) || Date.parse(lastRun.start) || nowQ;
      // Reduce et non Math.max(...runs) : sans plafond API, une journée peut porter
      // assez de runs pour faire exploser la pile avec un spread.
      let maxDuration = 0;
      runs.forEach((r) => {
        const duration = (r.end ? Date.parse(r.end) : nowQ) - Date.parse(r.start);
        if (Number.isFinite(duration) && duration > maxDuration) maxDuration = duration;
      });
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
  }, [filtered, sortKey, nowQ]);

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
    () => computeWindow(filtered, dayStart, zoomAuto, nowQ),
    [filtered, dayStart, zoomAuto, nowQ]
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

  // ---- Ce qu'on dessine : items (runs isolés + buckets) ----
  // La granularité `auto` dépend de la fenêtre, elle-même calculée sur les runs bruts
  // (jamais sur les buckets) : pas de boucle de rétroaction fenêtre <-> agrégation.
  const binMs = useMemo(() => {
    const fixed = parseBin(bin);
    return fixed === undefined ? autoBinMs(windowSpan) : fixed;
  }, [bin, windowSpan]);

  const { itemsByDag, mergedCount } = useMemo(() => {
    const map = new Map();
    let runs = 0;
    let items = 0;
    rows.forEach((row) => {
      const list = bucketize(row.runs, dayStart, binMs, nowQ);
      map.set(row.dagId, list);
      runs += row.count;
      items += list.length;
    });
    return { itemsByDag: map, mergedCount: runs - items };
  }, [rows, dayStart, binMs, nowQ]);

  // Clé -> item : le texte du tooltip n'est construit que pour la barre survolée.
  const tipItems = useMemo(() => {
    const map = new Map();
    itemsByDag.forEach((list) => list.forEach((item) => map.set(item.key, item)));
    return map;
  }, [itemsByDag]);

  // ---- Un seul tooltip et un seul gestionnaire de clic pour tout le Gantt ----
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

  // Navigation SPA pour les seuls liens qui restent (nom du DAG, barres en échec).
  // Sans `useNavigate` sur l'hôte, on laisse le <a> faire son travail.
  const navigate = HasNavigate ? Router.useNavigate() : null;
  const onChartClick = useCallback(
    (event) => {
      if (!navigate || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; // nouvel onglet
      const link = event.target && event.target.closest ? event.target.closest('[data-nav]') : null;
      const href = link && link.getAttribute('href');
      if (!href) return;
      event.preventDefault();
      navigate(href);
    },
    [navigate]
  );

  const binTitle =
    bin === 'auto'
      ? "Fusionne les runs d'un même DAG démarrés dans la même tranche ; granularité choisie d'après la fenêtre affichée, 30 min maximum. Rouge dès qu'un run du bucket a échoué."
      : bin === 'off'
        ? 'Une barre par run : aucune agrégation.'
        : `Une barre par tranche de ${binLabel(parseBin(bin))} ; rouge dès qu'un run du bucket a échoué.`;

  return (
    <Box p={4} maxW="100%" overflowX="auto">
      {/* Un seul <style> pour l'hover des rares liens (nom du DAG, barres en échec) : les
          <a> natifs ne peuvent pas recevoir de prop Chakra `_hover`. */}
      <style>{'.gk-nav{color:inherit;text-decoration:none;cursor:pointer}.gk-nav:hover{text-decoration:underline}'}</style>
      <VStack alignItems="stretch" gap={3}>
        <ControlRibbon
          ribbon={ribbon}
          date={date}
          setDate={setDate}
          loading={loading}
          error={error}
          nameFilter={nameFilter}
          setNameFilter={setNameFilter}
          tagFilter={tagFilter}
          setTagFilter={setTagFilter}
          allTags={allTags}
          stagesText={stagesText}
          setStagesText={setStagesText}
          legendStates={legendStates}
          stateSet={stateSet}
          stateCounts={stateCounts}
          toggleState={toggleState}
          setStateFilter={setStateFilter}
          resetFilters={resetFilters}
          hasActiveFilters={hasActiveFilters}
          sortKey={sortKey}
          setSortKey={setSortKey}
          bin={bin}
          setBin={setBin}
          binTitle={binTitle}
          zoomAuto={zoomAuto}
          setZoomAuto={setZoomAuto}
          grouped={grouped}
          setGrouped={setGrouped}
          showCollapseAll={grouped && groupKeys.length > 1}
          allCollapsed={allCollapsed}
          toggleCollapseAll={toggleCollapseAll}
          onRefresh={() => fetchData()}
          summaryLabel={
            `${filtered.length} run${filtered.length > 1 ? 's' : ''}` +
            (mergedCount > 0 ? ` · ${mergedCount} fusionnés` : '')
          }
          summaryTitle={
            `${fmtClock(windowStart)} → ${fmtClock(windowStart + windowSpan)} ` +
            `(${fmtDuration(windowSpan)}, ${zoomed ? 'fenêtre ajustée aux runs filtrés' : 'journée complète'})` +
            (mergedCount > 0 ? ` · ${mergedCount} runs fusionnés par tranche de ${binLabel(binMs)}` : '')
          }
          windowChipLabel={fmtSpanShort(windowSpan)}
          windowChipTitle={
            `${fmtClock(windowStart)} → ${fmtClock(windowStart + windowSpan)} · ${fmtDuration(windowSpan)}\n` +
            `${zoomAuto ? 'Zoom auto sur les runs filtrés (3 h minimum)' : 'Journée complète'}\n` +
            `Cliquer pour ${zoomAuto ? 'afficher les 24 h' : 'zoomer sur les runs filtrés'}`
          }
        />

        {loading ? (
          <Text>Loading…</Text>
        ) : rows.length === 0 ? (
          <Text color="fg.muted">Aucun run pour cette journée / ces filtres.</Text>
        ) : (
          <Box
            borderWidth="1px"
            borderColor="border.subtle"
            borderRadius="md"
            overflow="hidden"
            onMouseOver={onChartMouseOver}
            onMouseLeave={onChartMouseLeave}
            onClick={onChartClick}
          >
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
                          items={itemsByDag.get(row.dagId) || NO_ITEMS}
                          runCount={row.count}
                          tags={row.tags}
                          primaryTag={row.primaryTag}
                          groupTag={group.tag}
                          windowStart={windowStart}
                          windowSpan={windowSpan}
                          chartWidth={chartWidth}
                          dayStartMs={dayStart}
                        />
                      ))}
                  </Box>
                ))
              : rows.map((row) => (
                  <DagRow
                    key={row.dagId}
                    dagId={row.dagId}
                    items={itemsByDag.get(row.dagId) || NO_ITEMS}
                    runCount={row.count}
                    tags={row.tags}
                    primaryTag={primaryTagOf(row.tags, stages, tagRank)}
                    windowStart={windowStart}
                    windowSpan={windowSpan}
                    chartWidth={chartWidth}
                    dayStartMs={dayStart}
                  />
                ))}
          </Box>
        )}

        {/* Le tooltip de toutes les barres : un seul composant pour 1270 barres. */}
        <HoverTip tip={tip} />

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
