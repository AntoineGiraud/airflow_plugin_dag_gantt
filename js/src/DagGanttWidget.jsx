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
 *   `components/` rendu (barre, ligne, en-tête de groupe, échelle, légende, ruban, gantt).
 *
 * Ici ne restent donc que : les `useState` de la vue, les `useMemo` qui appellent les pures,
 * et la mise en page. Deux règles de lisibilité s'y appliquent, vérifiées par `react-doctor`
 * (voir README §3.4) :
 *
 * - **un `useMemo` ne capture que ce qu'il déclare** : les dérivations prennent le tableau
 *   `runs`, jamais l'objet `data` — une dépendance oubliée afficherait des données périmées
 *   sans la moindre erreur en console ;
 * - **`useState` ne calcule rien** : la lecture de l'URL passe par un initialiseur lazy
 *   (`() => readInitialView(...)`, appelé une fois) et chaque état reçoit une valeur déjà lue.
 */
import React, { useState, useMemo, useCallback } from 'react';
import { buildTicks, computeWindow, fmtSpanShort } from './lib/time';
import { buildGroups } from './lib/grouping';
import {
  binHint, buildGroupingInputs, buildItemsByDag, buildRows, buildTipIndex, filterRuns,
  listStates, listTags, mergeLegendStates, readInitialView, resolveBinMs,
  stateCounts as countStates, summaryLabel, summaryTitle, viewToQuery, windowChipTitle,
} from './lib/view';
import { Box, VStack, useNavigateSafe } from './lib/host';
import { ControlRibbon } from './components/ControlRibbon';
import { GanttChart } from './components/GanttChart';
import { HoverTip } from './components/HoverTip';
import { StateLegend } from './components/StateLegend';
import { useChartWidth } from './hooks/useChartWidth';
import { useHoverTip } from './hooks/useHoverTip';
import { useRibbon } from './hooks/useRibbon';
import { useRuns } from './hooks/useRuns';
import { readInitialQuery, useUrlSync } from './hooks/useUrlSync';

const DagGanttWidget = () => {
  // Hydratation depuis l'URL **au montage seulement** : l'initialiseur lazy ne tourne qu'une
  // fois, et `readInitialView` applique les défauts (les valeurs par défaut ne sont jamais
  // réécrites dans l'URL, voir `viewToQuery`).
  const [view0] = useState(() => readInitialView(readInitialQuery()));

  const [date, setDate] = useState(view0.date);
  // Runs de la journée + rafraîchissement + horloge (voir hooks/useRuns).
  const { data, loading, error, refresh, now, nowQ } = useRuns(date);

  // Filtres client-side
  const [nameFilter, setNameFilter] = useState(view0.nameFilter);
  const [tagFilter, setTagFilter] = useState(view0.tagFilter);
  const [stateFilter, setStateFilter] = useState(view0.stateFilter); // multi-sélection via la légende
  const [zoomAuto, setZoomAuto] = useState(view0.zoomAuto); // false = journée complète 24 h
  const [sortKey, setSortKey] = useState(view0.sortKey);

  // Agrégation des runs en buckets : 'auto' (granularité selon la fenêtre, 30 min max),
  // 'off' (une barre par run) ou une tranche fixe ('1m'..'60m').
  const [bin, setBin] = useState(view0.bin);

  // Groupement par tag principal (défaut : activé, ?group=0 = liste plate)
  const [grouped, setGrouped] = useState(view0.grouped);
  const [stagesText, setStagesText] = useState(view0.stagesText); // ex. « collecte, normalisation, export »
  const [collapsed, setCollapsed] = useState(view0.collapsed); // Set de clés de groupe

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

  useUrlSync(
    viewToQuery({
      date,
      nameFilter,
      tagFilter,
      stateFilter,
      sortKey,
      zoomAuto,
      bin,
      grouped,
      stagesText,
      collapsed,
    })
  );

  // Les dérivations ne voient que `runs` : la capture du memo est sa dépendance.
  const { runs } = data;
  const allTags = useMemo(() => listTags(runs), [runs]);
  const allStates = useMemo(() => listStates(runs), [runs]);

  // Legende = tous les etats connus, meme absents de la journee (grises, non cliquables).
  const legendStates = useMemo(() => mergeLegendStates(allStates), [allStates]);
  const toggleState = useCallback((s) => {
    setStateFilter((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : prev.concat(s)));
  }, []);
  const stateSet = useMemo(() => new Set(stateFilter), [stateFilter]);

  // Nombre de runs par état **sur les filtres hors état** : ce que chaque case ajoutera
  // ou retirera (la légende du bas, elle, compte sur la journée entière).
  // comptes hors filtre d'état (la fonction importée est aliasée pour ne pas masquer la variable)
  const stateCounts = useMemo(() => countStates(runs, nameFilter, tagFilter), [runs, nameFilter, tagFilter]);

  // Filtrage instantane sans rappel API
  const filtered = useMemo(
    () => filterRuns(runs, nameFilter, tagFilter, stateFilter, stateSet),
    [runs, nameFilter, tagFilter, stateFilter, stateSet]
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
  // `useNavigateSafe` est déjà choisi dans `lib/host.js` : sans `useNavigate` sur l'hôte il
  // vaut `() => null`, on laisse le <a> faire son travail.
  const navigate = useNavigateSafe();
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
          binTitle={binHint(bin)}
          zoomAuto={zoomAuto}
          setZoomAuto={setZoomAuto}
          grouped={grouped}
          setGrouped={setGrouped}
          showCollapseAll={grouped && groupKeys.length > 1}
          allCollapsed={allCollapsed}
          toggleCollapseAll={toggleCollapseAll}
          onRefresh={refresh}
          summaryLabel={summaryLabel(filtered.length, mergedCount)}
          summaryTitle={summaryTitle({ windowStart, windowSpan, zoomed, mergedCount, binMs })}
          windowChipLabel={fmtSpanShort(windowSpan)}
          windowChipTitle={windowChipTitle({ windowStart, windowSpan, zoomAuto })}
        />

        <GanttChart
          loading={loading}
          rows={rows}
          groups={groups}
          grouped={grouped}
          collapsed={collapsed}
          onToggleGroup={toggleCollapse}
          stages={stages}
          tagRank={tagRank}
          itemsByDag={itemsByDag}
          date={date}
          ticks={ticks}
          chartRef={chartRef}
          now={now}
          windowStart={windowStart}
          windowSpan={windowSpan}
          chartWidth={chartWidth}
          dayStart={dayStart}
          onChartMouseOver={onChartMouseOver}
          onChartMouseLeave={onChartMouseLeave}
          onChartClick={onChartClick}
        />

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
