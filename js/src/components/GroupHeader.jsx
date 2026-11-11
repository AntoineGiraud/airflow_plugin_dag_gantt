import React from 'react';
import { OTHER_GROUP } from '../lib/grouping';
import { Badge, Box, Flex, HStack, Text } from '../lib/host';

/* ------------------------------------------------------------------ */
/* En-tete d'un groupe de tags (clic = replier / déplier)              */
/* ------------------------------------------------------------------ */

export const GroupHeader = ({ group, collapsed, onToggle }) => (
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
