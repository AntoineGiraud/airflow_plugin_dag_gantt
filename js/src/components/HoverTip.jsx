import React from 'react';
import { TIP_MAX_WIDTH } from '../lib/tipText';
import { Box } from '../lib/host';

/* ---------------------- Tooltip partagé de tout le Gantt ---------------------- */

export const HoverTip = ({ tip }) => {
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
