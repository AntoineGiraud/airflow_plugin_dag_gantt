/**
 * Le **seul** endroit qui touche les bibliothèques de l'hôte.
 *
 * L'UI Airflow 3.3 expose React, Chakra et React Router sur `globalThis` (voir les
 * `externals` de webpack) : rien n'est bundlé ici, donc le thème et le branding de l'hôte
 * s'appliquent tout seuls. Quand l'hôte change de version, c'est ici qu'on regarde — et
 * c'est aussi le point d'entrée du stub utilisé par le test headless (`js/test/render.test.mjs`).
 */
import * as Chakra from '@chakra-ui/react';
import * as Router from 'react-router-dom';

export { Chakra, Router };

export const { Box, Flex, HStack, VStack, Text, Input, Button, Badge, Spacer } = Chakra;

// Gardes : si un composant ou un hook manque dans la version de l'hôte, on dégrade proprement.
export const HasNativeSelect = Boolean(Chakra.NativeSelectRoot && Chakra.NativeSelectField);
export const HasNavigate = Boolean(Router && typeof Router.useNavigate === 'function');
export const HasSearchParams = Boolean(Router && typeof Router.useSearchParams === 'function');

/**
 * Le hook de navigation est choisi **ici**, pas dans un composant.
 *
 * Un hook appelé dans une condition (`HasNavigate ? Router.useNavigate() : null`) ferait
 * varier le nombre de hooks vus par React entre deux rendus s'il arrivait que la condition
 * tourne : React attacherait alors un état au mauvais hook. Un `?:` de module ne tourne
 * qu'une fois, à l'évaluation de ce fichier — l'ordre des hooks est donc le même à chaque
 * rendu, **par construction**.
 *
 * Sans `useNavigate` sur l'hôte, `navigate` vaut `null` : les `<a>` gardent leur comportement
 * natif (chargement complet), et le gestionnaire de clic délégué n'a rien à intercepter.
 */
export const useNavigateSafe = HasNavigate ? Router.useNavigate : () => null;
