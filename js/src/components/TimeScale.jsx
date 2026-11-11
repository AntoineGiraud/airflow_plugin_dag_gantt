import React from 'react';
import { LABEL_WIDTH } from '../lib/constants';
import { Box, Flex, Text } from '../lib/host';

/* Echelle de temps : graduations + ligne « maintenant ».
   Le `ref` de la zone de temps vient du conteneur (c'est lui qui mesure la largeur en px
   via useChartWidth) : c'est ici qu'il est posé, puisque c'est cette zone qui sert de
   référence aux pourcentages des barres. */
export const TimeScale = ({ date, ticks, chartRef, now, windowStart, windowSpan }) => (
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
);
