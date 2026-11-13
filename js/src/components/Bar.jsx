import React from 'react';
import { barGeometry, barHref, barLabel, barStyle, barVisualProps, isLinkable } from '../lib/aggregation';
import { BAR_HEIGHT } from '../lib/constants';
import { Box } from '../lib/host';

/* ------------------------------------------------------------------ */
/* Barre : run isolé ou bucket de runs (plus de lien / tooltip unitaire) */
/* ------------------------------------------------------------------ */

/* Tout ce qui est **calcul** vit dans `lib/aggregation.js` — `barGeometry`, `barLabel`,
   `barVisualProps`, `isLinkable`, `barStyle`, `barHref`, `packLanes` : des fonctions pures,
   couvertes par le test node. Ici ne reste que la seule question de rendu : la barre est-elle
   un lien, ou une simple zone survolable ? */

export const Bar = React.memo(function Bar({ item, windowStart, windowSpan, chartWidth, dayStartMs }) {
  const geometry = barGeometry(item, { windowStart, windowSpan, chartWidth });
  const common = barVisualProps(item);
  const label = barLabel(item, geometry);
  const style = barStyle(item, geometry);

  // Le lien mène à la liste des runs du DAG **de cette journée** (voir `barHref`).
  if (!isLinkable(item)) {
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
