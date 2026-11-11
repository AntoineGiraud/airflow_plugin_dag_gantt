import React from 'react';
import { DEFAULT_COLOR, STATE_COLORS } from '../lib/constants';
import { Box, Button, HStack, Text } from '../lib/host';

/* Légende du bas = filtre multi-états cliquable (rien de sélectionné = tous les états).
   Elle partage le même état `stateFilter` que les cases de l'onglet Filtres : les deux
   se répondent, et un état absent de la journée reste affiché, grisé et inerte — voir la
   vue d'ensemble sans avoir à deviner ce qui manque. */
export const StateLegend = ({ legendStates, allStates, stateSet, toggleState, hasFilter, onClear }) => (
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
    {hasFilter && (
      <Button size="xs" variant="ghost" onClick={onClear}>
        ✕ tous les états
      </Button>
    )}
  </HStack>
);
