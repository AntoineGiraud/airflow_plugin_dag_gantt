/**
 * Dag Gantt — **conteneur** : état de la vue, pipeline de dérivation, assemblage.
 *
 * Le reste du Gantt est ailleurs, et c'est le principe :
 *   `lib/`        fonctions pures (temps, agrégation, tags, dérivations, infobulles) —
 *                 testées sous Node sans React ; `lib/host.js` est le seul à toucher
 *                 l'hôte (Chakra / React Router exposés sur `globalThis`, cf. webpack
 *                 externals : rien n'est bundlé, thème et branding de l'hôte appliqués).
 *   `hooks/`      logistique (runs + horloge, largeur mesurée, tooltip délégué, URL
 *                 partageable, onglets du ruban).
 *   `components/` rendu (barre, ligne, en-tête de groupe, échelle, légende, ruban…).
 *
 * Ici ne restent donc que : les `useState` de la vue, les `useMemo` qui appellent les pures,
 * et la mise en page.
 */
import React, { useState, useMemo, useCallback } from 'react';
import { BIN_OPTIONS, binLabel, parseBin } from './lib/aggregation';
import { DEFAULT_SORT, NO_ITEMS, SORT_OPTIONS } from './lib/constants';
import { Box, HasNavigate, Router, Text, VStack } from './lib/host';
import { buildTicks, computeWindow, fmtClock, fmtDuration, fmtSpanShort, todayLocal } from './lib/time';
import { buildGroups, primaryTagOf } from './lib/grouping';
import {
  buildGroupingInputs, buildItemsByDag, buildRows, buildTipIndex, filterRuns,
  listStates, listTags, mergeLegendStates, resolveBinMs, stateCounts as countStates,
} from './lib/view';
import { ControlRibbon } from './components/ControlRibbon';
import { DagRow } from './components/DagRow';
import { GroupHeader } from './components/GroupHeader';
import { HoverTip } from './components/HoverTip';
import { StateLegend } from './components/StateLegend';
import { TimeScale } from './components/TimeScale';
import { useChartWidth } from './hooks/useChartWidth';
import { useHoverTip } from './hooks/useHoverTip';
import { useRibbon } from './hooks/useRibbon';
import { useRuns } from './hooks/useRuns';
import { readInitialQuery, useUrlSync } from './hooks/useUrlSync';

const DagGanttWidget = () => {
  // Hydratation depuis l'URL au montage (les valeurs par defaut ne sont pas reecrites).
  const [initialQuery] = useState(readInitialQuery);
  const hydratedSort = initialQuery.get('sort');

  const [date, setDate] = useState(initialQuery.get('date') || todayLocal());
  // Runs de la journée + rafraîchissement + horloge (voir hooks/useRuns).
  const { data, loading, error, refresh, now, nowQ } = useRuns(date);

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

  const allTags = useMemo(() => listTags(data), [data.runs]);
  const allStates = useMemo(() => listStates(data), [data.runs]);

  // Legende = tous les etats connus, meme absents de la journee (grises, non cliquables).
  const legendStates = useMemo(() => mergeLegendStates(allStates), [allStates]);
  const toggleState = useCallback((s) => {
    setStateFilter((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : prev.concat(s)));
  }, []);
  const stateSet = useMemo(() => new Set(stateFilter), [stateFilter]);

  // Nombre de runs par état **sur les filtres hors état** : ce que chaque case ajoutera
  // ou retirera (la légende du bas, elle, compte sur la journée entière).
  // comptes hors filtre d'état (la fonction importée est aliasée pour ne pas masquer la variable)
  const stateCounts = useMemo(() => countStates(data, nameFilter, tagFilter), [data.runs, nameFilter, tagFilter]);

  // Filtrage instantane sans rappel API
  const filtered = useMemo(
    () => filterRuns(data, nameFilter, tagFilter, stateFilter, stateSet),
    [data.runs, nameFilter, tagFilter, stateFilter, stateSet]
  );

  // Une ligne par DAG, triee selon le critere choisi
  const rows = useMemo(() => buildRows(filtered, sortKey, nowQ), [filtered, sortKey, nowQ]);

  // ---- Groupement par tag principal (le tri choisi s'applique à l'intérieur des groupes) ----
  const { stages, tagRank } = useMemo(() => buildGroupingInputs(rows, stagesText), [rows, stagesText]);

  const groups = useMemo(() => buildGroups(rows, stages, tagRank), [rows, stages, tagRank]);

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

  // Largeur réelle de la zone de temps : sait quelles barres peuvent afficher leur durée.
  const { chartRef, chartWidth } = useChartWidth(rows.length > 0);
  const { windowStart, windowSpan, zoomed } = useMemo(
    () => computeWindow(filtered, dayStart, zoomAuto, nowQ),
    [filtered, dayStart, zoomAuto, nowQ]
  );

  // Graduations adaptatives : palier choisi pour <= MAX_TICKS traits, aligne sur minuit local.
  const ticks = useMemo(
    () => buildTicks({ windowStart, windowSpan, dayStart }),
    [dayStart, windowStart, windowSpan]
  );

  // ---- Ce qu'on dessine : items (runs isolés + buckets) ----
  // La granularité `auto` dépend de la fenêtre, elle-même calculée sur les runs bruts
  // (jamais sur les buckets) : pas de boucle de rétroaction fenêtre <-> agrégation.
  const binMs = useMemo(() => resolveBinMs(bin, windowSpan), [bin, windowSpan]);

  const { itemsByDag, mergedCount } = useMemo(
    () => buildItemsByDag(rows, dayStart, binMs, nowQ),
    [rows, dayStart, binMs, nowQ]
  );

  // Clé -> item : le texte du tooltip n'est construit que pour la barre survolée.
  const tipItems = useMemo(() => buildTipIndex(itemsByDag), [itemsByDag]);

  // Un seul tooltip pour tout le Gantt, piloté par délégation (voir hooks/useHoverTip).
  const { tip, onChartMouseOver, onChartMouseLeave } = useHoverTip(tipItems);

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
          onRefresh={refresh}
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
            <TimeScale
              date={date}
              ticks={ticks}
              chartRef={chartRef}
              now={now}
              windowStart={windowStart}
              windowSpan={windowSpan}
            />
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

        <StateLegend
          legendStates={legendStates}
          allStates={allStates}
          stateSet={stateSet}
          toggleState={toggleState}
          hasFilter={stateFilter.length > 0}
          onClear={() => setStateFilter([])}
        />
      </VStack>
    </Box>
  );
};

export default DagGanttWidget;
