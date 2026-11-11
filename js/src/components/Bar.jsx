import React from 'react';
import { barHref } from '../lib/aggregation';
import { BAR_HEIGHT, DEFAULT_COLOR, MIN_COUNT_PX, MIN_DUR_PX, ROW_HEIGHT, STATE_COLORS } from '../lib/constants';
import { fmtDuration } from '../lib/time';
import { Box } from '../lib/host';


/* ------------------------------------------------------------------ */
/* Barre : run isolé ou bucket de runs (plus de lien / tooltip unitaire) */
/* ------------------------------------------------------------------ */

// `barHref` (lien d'une barre) et `packLanes` (hauteur de ligne) vivent dans
// `aggregation.js` : ce sont des fonctions pures, couvertes par le test node.


export const Bar = React.memo(function Bar({ item, windowStart, windowSpan, chartWidth, dayStartMs }) {
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
