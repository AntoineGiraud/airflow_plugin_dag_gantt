/**
 * Tests du tag principal et du groupement — **sans React ni DOM** :
 *
 *   bun ./test/grouping.test.mjs
 *
 * Ces fonctions n'étaient couvertes que de façon indirecte par le test de rendu : or c'est
 * elles qui décident de « dans quel groupe tombe ce DAG », et donc de toute la lecture
 * verticale du Gantt.
 */
import assert from 'node:assert/strict';
import {
  OTHER_GROUP,
  buildGroups,
  computeTagRank,
  normalizeTag,
  parseStages,
  primaryTagOf,
} from '../src/lib/grouping.js';

const row = (dagId, tags, count = 1, runs = []) => ({ dagId, tags, count, runs, firstStart: 0 });

/* ------------------------------- normalisation ------------------------------- */

assert.equal(normalizeTag('  Collecte '), 'collecte', 'espace + casse ignorés');
assert.equal(normalizeTag(null), '', 'null → chaîne vide');
assert.equal(normalizeTag(undefined), '');
assert.deepEqual(parseStages('collecte, normalisation ,, export'), ['collecte', 'normalisation', 'export'], 'vides ignorés');
assert.deepEqual(parseStages(''), [], 'champ vide = aucune étape');
assert.deepEqual(parseStages(null), [], 'null ne casse pas');

/* ------------------------------- classement auto ------------------------------- */

// « spark » sur 3 DAGs, « nuit » sur 1 : spark est mieux classé (rang 0).
const rows = [row('a', ['Spark', 'nuit']), row('b', ['spark']), row('c', ['spark']), row('d', ['Nuit'])];
const rank = computeTagRank(rows);
assert.equal(rank.get('spark'), 0, 'tag le plus fréquent = rang 0');
assert.equal(rank.get('nuit'), 1);
assert.equal(rank.size, 2, 'un tag compté **une fois par DAG**, pas par run');

// Égalité de fréquence → alphabétique (sinon l'ordre dépendrait de l'ordre des runs).
const tie = computeTagRank([row('x', ['zoulou']), row('y', ['alpha'])]);
assert.equal(tie.get('alpha'), 0, 'à fréquence égale, alphabétique');
assert.equal(tie.get('zoulou'), 1);

/* ------------------------------- tag principal ------------------------------- */

// Auto : le tag le mieux classé, dans sa **casse d'origine** (c'est ce qui s'affiche).
assert.equal(primaryTagOf(['nuit', 'Spark'], [], rank), 'Spark', 'le plus discriminant gagne');
assert.equal(primaryTagOf([], [], rank), '', 'aucun tag = pas de groupe → « autre »');
assert.equal(primaryTagOf(['  ', ''], [], rank), '', 'tags vides ignorés');

// Un tag absent du classement ne devient **pas** tag principal : sans rang connu il reste
// à `Infinity` et ne bat jamais le meilleur. Dans l'app c'est hors chemin — `computeTagRank`
// est toujours calculé sur les lignes qu'on groupe juste après — mais ça vaut pour un appel
// isolé : un tel tag tombe donc dans « autre ». Épinglé tel quel, **comportement inchangé**
// par le refactor (à discuter séparément si on veut le rendre tolérant).
assert.equal(primaryTagOf(['inconnu'], [], rank), '', 'rang inconnu = pas de groupe');
assert.equal(primaryTagOf(['inconnu', 'spark'], [], rank), 'spark', 'le tag classé prend la main');

// Étapes = **priorité** : le premier étape présente sur le DAG, où qu'il soit dans ses tags.
const stages = ['export', 'collecte'];
assert.equal(primaryTagOf(['collecte', 'export'], stages, rank), 'export', 'l\'ordre saisi prime sur l\'ordre des tags');
assert.equal(primaryTagOf(['Collecte'], stages, rank), 'Collecte', 'insensible à la casse, casse d\'origine rendue');
assert.equal(primaryTagOf(['spark'], stages, rank), '', 'aucune étape en commun = pas de groupe');

/* ------------------------------- groupes ------------------------------- */

const grouped = buildGroups(
  [row('a', ['collecte'], 2), row('b', ['collecte'], 5), row('c', ['export'], 1), row('d', [], 1)],
  parseStages('export,collecte'),
  computeTagRank([row('a', ['collecte']), row('b', ['collecte']), row('c', ['export']), row('d', [])])
);

assert.deepEqual(
  grouped.map((g) => g.key),
  ['export', 'collecte', OTHER_GROUP],
  'ordre des étapes, puis « autre » **toujours en dernier**'
);
assert.deepEqual(
  grouped.map((g) => g.dagCount),
  [1, 2, 1],
  'taille de groupe lisible'
);
assert.equal(grouped[1].runCount, 7, 'runCount cumule les runs des DAGs du groupe');
assert.equal(grouped[1].rows.map((r) => r.dagId).join(','), 'a,b', 'l\'ordre des lignes est celui du tri choisi');
assert.equal(grouped[1].rows[0].primaryTag, 'collecte', 'la ligne garde son tag principal affiché');

// Sans étapes : regroupement automatique, « autre » en dernier, puis fréquence décroissante.
const auto = buildGroups(
  [row('a', ['spark']), row('b', ['spark']), row('c', ['rare']), row('d', [])],
  [],
  computeTagRank([row('a', ['spark']), row('b', ['spark']), row('c', ['rare']), row('d', [])])
);
assert.deepEqual(auto.map((g) => g.key), ['spark', 'rare', OTHER_GROUP], 'fréquence décroissante, « autre » en dernier');

// Les échecs remontent par groupe (pastille rouge de l'en-tête).
const failedRows = [
  { ...row('a', ['collecte']), runs: [{ state: 'failed' }, { state: 'success' }] },
  { ...row('b', ['collecte']), runs: [{ state: 'success' }] },
];
const withFails = buildGroups(failedRows, [], computeTagRank(failedRows));
assert.equal(withFails[0].failedCount, 1, 'failedCount compte les runs en échec du groupe');

console.log('grouping.test.mjs : tags principaux, étapes prioritaires et ordre des groupes — ok');
