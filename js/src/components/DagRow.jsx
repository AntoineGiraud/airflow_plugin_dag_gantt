import React, { useMemo } from 'react';
import { Bar } from './Bar';
import { packLanes } from '../lib/aggregation';
import { LABEL_WIDTH, MAX_LANES, ROW_HEIGHT } from '../lib/constants';
import { Badge, Box, Flex, Text } from '../lib/host';

/* ------------------------------------------------------------------ */
/* Ligne d'un DAG (lane packing sur les items)                         */
/* ------------------------------------------------------------------ */

export const DagRow = React.memo(function DagRow({
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
