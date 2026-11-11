/**
 * Tag principal et groupement des DAGs — **fonctions pures**, sans React
 * (`js/test/grouping.test.mjs`).
 *
 * Un DAG est rattache a **un seul** groupe : le premier tag de la liste d'etapes saisie par
 * l'utilisateur qui figure aussi sur le DAG, sinon son tag le mieux classe par frequence
 * (moins un tag est partage, plus il est discriminant). Sans tag -> groupe « autre »,
 * toujours remonte en dernier pour ne pas noyer l'essentiel.
 */

export const OTHER_GROUP = 'autre';

export const normalizeTag = (t) => String(t || '').trim().toLowerCase();

// Liste d'étapes priorisées saisie par l'utilisateur : « collecte, normalisation, export ».
export const parseStages = (raw) =>
  String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

// Classement auto des tags par fréquence décroissante sur les DAGs affichés
// (égalité -> alphabétique : déterministe). Retourne Map tag -> rang (0 = mieux classé).
export const computeTagRank = (rows) => {
  const freq = new Map();
  rows.forEach((row) => {
    new Set((row.tags || []).map(normalizeTag).filter(Boolean)).forEach((t) => {
      freq.set(t, (freq.get(t) || 0) + 1);
    });
  });
  const ranked = Array.from(freq.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const rank = new Map();
  ranked.forEach(([t], i) => rank.set(t, i));
  return rank;
};

// Tag principal d'un DAG : premier tag de la liste d'étapes présent sur le DAG (override),
// sinon le tag le mieux classé par fréquence (auto). '' si aucun tag -> groupe « autre ».
export const primaryTagOf = (tags, stages, tagRank) => {
  const lower = (tags || []).map((t) => [t, normalizeTag(t)]).filter(([, n]) => n);
  if (stages.length) {
    for (const stage of stages) {
      const ns = normalizeTag(stage);
      const hit = lower.find(([, n]) => n === ns);
      if (hit) return hit[0];
    }
    return '';
  }
  let best = '';
  let bestRank = Infinity;
  lower.forEach(([t, n]) => {
    const r = tagRank.has(n) ? tagRank.get(n) : Infinity;
    if (r < bestRank) {
      bestRank = r;
      best = t;
    }
  });
  return best;
};

/**
 * Range les lignes en groupes (tag principal). Corps **recopié tel quel** du `useMemo` du
 * composant : le tri choisi s'applique a l'interieur des groupes (les lignes y sont deja
 * rangees) ; entre eux, ordre des etapes saisies puis nombre de DAGs decroissant, et
 * « autre » toujours en dernier dans les deux cas.
 */
export const buildGroups = (rows, stages, tagRank) => {
    const byKey = new Map();
    rows.forEach((row) => {
      const primary = primaryTagOf(row.tags, stages, tagRank); // casse d'origine conservée
      const key = normalizeTag(primary) || OTHER_GROUP;
      if (!byKey.has(key)) byKey.set(key, { key, tag: primary, rows: [] });
      byKey.get(key).rows.push({ ...row, primaryTag: primary });
    });
    const list = Array.from(byKey.values()).map((g) => ({
      key: g.key,
      tag: g.tag,
      rows: g.rows,
      dagCount: g.rows.length,
      runCount: g.rows.reduce((n, r) => n + r.count, 0),
      failedCount: g.rows.reduce(
        (n, r) => n + r.runs.filter((run) => run.state === 'failed').length,
        0
      ),
    }));
    const stageIdx = new Map(stages.map((s, i) => [normalizeTag(s), i]));
    const orderOf = (g) => (g.key !== OTHER_GROUP && stageIdx.has(g.key) ? stageIdx.get(g.key) : Infinity);
    list.sort((a, b) => {
      const otherA = a.key === OTHER_GROUP ? 1 : 0;
      const otherB = b.key === OTHER_GROUP ? 1 : 0;
      if (otherA !== otherB) return otherA - otherB; // « autre » toujours en dernier
      const oa = orderOf(a);
      const ob = orderOf(b);
      if (oa !== ob) return oa - ob; // ordre des étapes…
      return b.dagCount - a.dagCount || a.key.localeCompare(b.key); // …puis fréquence décroissante (auto)
    });
    return list;
  
};
