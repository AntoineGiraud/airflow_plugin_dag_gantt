import React from 'react';
import { DagRow } from './DagRow';
import { GroupHeader } from './GroupHeader';
import { TimeScale } from './TimeScale';
import { NO_ITEMS } from '../lib/constants';
import { primaryTagOf } from '../lib/grouping';
import { Box, Text } from '../lib/host';

/* ------------------------------------------------------------------ */
/* Le Gantt lui-même : chargement / vide / graphique (groupé ou à plat) */
/* ------------------------------------------------------------------ */

/* Le conteneur décide **quand** dessiner, ce fichier décide **quoi**. Trois rendus
   mutuellement exclusifs, et deux façons d'aligner les lignes — chacun a son petit
   composant, donc aucun `if` imbriqué n'atteint le conteneur.

   `React.memo` compte ici : l'onglet du ruban, une frappe dans un champ ou un clic sur la
   légende re-renderaient 1 127 barres pour rien. `Bar` et `DagRow` sont déjà mémoïsés, mais
   l'arbre du dessous n'était jamais épargné ; avec cette porte, une bascule d'onglet ne
   recalcule plus rien tant que les runs, la fenêtre et l'ordre n'ont pas bougé. */

/* Ligne de DAG : mêmes props dans les deux modes, seul le tag principal change de source. */
const GanttRow = ({ row, primaryTag, groupTag, model }) => (
  <DagRow
    dagId={row.dagId}
    items={model.itemsByDag.get(row.dagId) || NO_ITEMS}
    runCount={row.count}
    tags={row.tags}
    primaryTag={primaryTag}
    groupTag={groupTag}
    windowStart={model.windowStart}
    windowSpan={model.windowSpan}
    chartWidth={model.chartWidth}
    dayStartMs={model.dayStart}
  />
);

/* Mode groupé : un en-tête par tag, et les lignes seulement si le groupe est déplié.
   Le tri choisi s'applique à l'intérieur du groupe (`buildGroups` s'en charge). */
const GroupedRows = ({ groups, collapsed, onToggle, model }) => (
  <>
    {groups.map((group) => (
      <Box key={group.key}>
        <GroupHeader
          group={group}
          collapsed={collapsed.has(group.key)}
          onToggle={() => onToggle(group.key)}
        />
        {!collapsed.has(group.key) &&
          group.rows.map((row) => <GanttRow key={row.dagId} row={row} groupTag={group.tag} model={model} />)}
      </Box>
    ))}
  </>
);

/* Mode liste plate : le tag principal est calculé par ligne, il n'y a plus d'en-tête. */
const FlatRows = ({ rows, stages, tagRank, model }) => (
  <>
    {rows.map((row) => (
      <GanttRow
        key={row.dagId}
        row={row}
        primaryTag={primaryTagOf(row.tags, stages, tagRank)}
        model={model}
      />
    ))}
  </>
);

export const GanttChart = React.memo(function GanttChart({
  loading,
  rows,
  groups,
  grouped,
  collapsed,
  onToggleGroup,
  stages,
  tagRank,
  itemsByDag,
  date,
  ticks,
  chartRef,
  now,
  windowStart,
  windowSpan,
  chartWidth,
  dayStart,
  onChartMouseOver,
  onChartMouseLeave,
  onChartClick,
}) {
  if (loading) return <Text>Loading…</Text>;
  if (rows.length === 0)
    return <Text color="fg.muted">Aucun run pour cette journée / ces filtres.</Text>;

  // Les cinq valeurs dont a besoin chaque ligne, regroupées pour ne pas les ressasser
  // dans les deux modes. Aucun calcul ici : ce sont les `useMemo` du conteneur, tels quels.
  const model = { itemsByDag, windowStart, windowSpan, chartWidth, dayStart };

  return (
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
      {grouped ? (
        <GroupedRows groups={groups} collapsed={collapsed} onToggle={onToggleGroup} model={model} />
      ) : (
        <FlatRows rows={rows} stages={stages} tagRank={tagRank} model={model} />
      )}
    </Box>
  );
});
