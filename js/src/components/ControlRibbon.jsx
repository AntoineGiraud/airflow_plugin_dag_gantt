import React from 'react';
import { Select } from './Select';
import { BIN_OPTIONS } from '../lib/aggregation';
import { DEFAULT_COLOR, NBSP, PANEL_TABS, SORT_OPTIONS, STATE_COLORS } from '../lib/constants';
import { shiftDate, todayLocal } from '../lib/time';
import { clip } from '../lib/tipText';
import { Box, Button, Flex, HStack, Input, Spacer, Text, VStack } from '../lib/host';

/* ------------------------------------------------------------------ */
/* Ruban de contrôles (ligne permanente + puces + panneau à onglets)   */
/* ------------------------------------------------------------------ */

/* Organisation « à la Word/Excel » : les contrôles sont rangés par catégorie dans deux
   onglets, la ligne du haut ne gardant que l'essentiel (titre, date, onglets, compteurs).

   Deux règles non évidentes, toutes deux couvertes par `js/test/render.test.mjs` :

   - l'onglet actif et l'état ouvert/replié sont **locaux** : l'URL partageable ne porte
     toujours que la VUE (filtres, tri, agrégation, groupement…) ;
   - le ruban **masque, il ne démonte pas** — `hidden` pour le navigateur, plus
     `data-visible` / `data-state` relus par le test headless (happy-dom ne rend pas
     l'attribut booléen `hidden` reçu en prop React). Les contrôles d'interface portent
     donc `data-gk-ui`, à ne pas confondre avec `data-gk` qui identifie les **barres**
     (le survol et le tooltip délégué en dépendent). */

const Field = ({ label = NBSP, title, children }) => (
  <VStack gap={1} alignItems="flex-start">
    <Text fontSize="10px" color="fg.muted" title={title}>
      {label}
    </Text>
    {children}
  </VStack>
);

/* Navigation de journée : ⬅️ / date / ➡️. Le jour suivant reste interdit à partir d'aujourd'hui
   — le Gantt n'a rien à montrer sur une journée qui n'a pas encore eu lieu. */
const DateNav = ({ date, setDate }) => (
  <HStack gap={1}>
    <Button
      size="sm"
      variant="outline"
      onClick={() => setDate((d) => shiftDate(d, -1))}
      title="Jour précédent"
      aria-label="Jour précédent"
    >
      ⬅️
    </Button>
    <Input
      type="date"
      size="sm"
      width="auto"
      value={date}
      onChange={(e) => setDate(e.target.value)}
    />
    <Button
      size="sm"
      variant="outline"
      onClick={() => setDate((d) => shiftDate(d, 1))}
      disabled={!date || date >= todayLocal()}
      title={date >= todayLocal() ? "Aujourd'hui : pas de date future" : 'Jour suivant'}
      aria-label="Jour suivant"
    >
      ➡️
    </Button>
  </HStack>
);

/* Puce de filtre actif : libellé + valeur + ✕ qui remet la valeur à vide. Visible tant que
   le filtre est actif, masquée sinon — jamais démontée : une vue filtrée doit rester
   explicable même ruban replié. */
const FilterChip = ({ name, shown, label, value, onClear }) => (
  <HStack
    gap={1}
    as="button"
    type="button"
    data-gk-ui={`chip-${name}`}
    data-visible={shown ? 'yes' : 'no'}
    hidden={!shown}
    px={2}
    py="2px"
    borderWidth="1px"
    borderColor="border.default"
    borderRadius="full"
    fontSize="11px"
    cursor="pointer"
    bg="bg.subtle"
    onClick={onClear}
    title={`${label} : ${value} — cliquer pour retirer ce filtre`}
  >
    <Text as="span" fontSize="11px" color="fg.muted">{label}</Text>
    <Text as="span" fontWeight="semibold">{clip(value, 40)}</Text>
    <Text as="span" color="fg.muted">✕</Text>
  </HStack>
);

/* Cases d'état du panneau Filtres : **mêmes données et même état** que la légende
   cliquable du bas (legendStates / toggleState) — les deux restent synchronisées.

   Rendues pour les états **présents dans la journée ou déjà sélectionnés**, dans cet
   ordre : un état sélectionné reste donc toujours maniable (sinon la case deviendrait
   muette pendant que la puce, elle, affiche encore ce filtre), et les états absents
   n'encombrent pas le panneau. */
const StateChecks = ({ states, stateSet, counts, onToggle }) => {
  const shownStates = states.filter((s) => (counts[s] || 0) > 0 || stateSet.has(s));
  return (
    <HStack gap={3} flexWrap="wrap" data-gk-ui="state-checks">
      {shownStates.map((s) => {
        const active = stateSet.has(s);
        const count = counts[s] || 0;
        return (
          <HStack
            key={s}
            gap={1}
            as="button"
            type="button"
            data-gk-ui={`state-${s}`}
            data-state={active ? 'on' : 'off'}
            aria-pressed={active}
            onClick={() => onToggle(s)}
            title={
              active
                ? `Retirer le filtre « ${s} »`
                : `Filtrer sur cet état (cumulable)${count ? ` · ${count} runs` : ''}`
            }
          >
            <Box
              width="12px"
              height="12px"
              borderRadius="3px"
              borderWidth="1px"
              borderColor="border.default"
              bg={active ? STATE_COLORS[s] || DEFAULT_COLOR : 'transparent'}
              color="white"
              fontSize="9px"
              lineHeight="12px"
              textAlign="center"
            >
              {active ? '✓' : ''}
            </Box>
            <Text as="span" fontSize="12px" fontWeight={active ? 'bold' : 'normal'}>
              {s}
              {count ? ` (${count})` : ''}
            </Text>
          </HStack>
        );
      })}
    </HStack>
  );
};

/* Panneau « Filtres » : ce qui **retire** des runs de la vue. `hidden` seulement, jamais
   démonté — les contrôles gardent leur valeur et le test headless les retrouve. */
const RibbonFiltersPanel = ({
  visible,
  nameFilter,
  setNameFilter,
  tagFilter,
  setTagFilter,
  allTags,
  legendStates,
  stateSet,
  stateCounts,
  toggleState,
  hasActiveFilters,
  resetFilters,
}) => (
  <Flex
    data-gk-ui="panel-filters"
    role="tabpanel"
    data-visible={visible ? 'yes' : 'no'}
    hidden={!visible}
    wrap="wrap"
    gap={4}
    alignItems="flex-start"
    px={3}
    py={2}
    borderWidth="1px"
    borderColor="border.muted"
    borderBottomColor="border.default"
    borderRadius="md"
    bg="bg.subtle"
  >
    <Field label="Nom de DAG / run">
      <Input
        placeholder="Filtrer par nom de DAG ou run…"
        size="sm"
        maxW="240px"
        value={nameFilter}
        onChange={(e) => setNameFilter(e.target.value)}
      />
    </Field>
    <Field label="Tag">
      <Select value={tagFilter} onChange={setTagFilter} options={allTags} placeholder="Tous les tags" />
    </Field>
    <Field label="États (cumulables)" title="Les mêmes que la légende cliquable en bas du Gantt — les deux sont synchronisés.">
      <StateChecks states={legendStates} stateSet={stateSet} counts={stateCounts} onToggle={toggleState} />
    </Field>
    <Spacer />
    <Field>
      <Button
        size="sm"
        variant="ghost"
        disabled={!hasActiveFilters}
        onClick={resetFilters}
        title="Remettre à vide nom, tag, états et étapes (la date est conservée)"
      >
        ✕ Réinitialiser les filtres
      </Button>
    </Field>
  </Flex>
);

/* Panneau « Affichage » : ce qui change la **façon de dessiner**, jamais ce qui est dessiné.
   Les étapes y vivent parce qu'elles ne filtrent rien : elles disent **comment** les DAGs
   sont groupés (quel tag devient le groupe, et dans quel ordre) — ni dans les filtres, ni
   dans les puces retirables. */
const RibbonViewPanel = ({
  visible,
  sortKey,
  setSortKey,
  bin,
  setBin,
  binTitle,
  zoomAuto,
  setZoomAuto,
  grouped,
  setGrouped,
  showCollapseAll,
  allCollapsed,
  toggleCollapseAll,
  stagesText,
  setStagesText,
  onRefresh,
}) => (
  <Flex
    data-gk-ui="panel-view"
    role="tabpanel"
    data-visible={visible ? 'yes' : 'no'}
    hidden={!visible}
    wrap="wrap"
    gap={4}
    alignItems="flex-start"
    px={3}
    py={2}
    borderWidth="1px"
    borderColor="border.muted"
    borderBottomColor="border.default"
    borderRadius="md"
    bg="bg.subtle"
  >
    <Field label="Ordre des lignes">
      <Select value={sortKey} onChange={setSortKey} options={SORT_OPTIONS} />
    </Field>
    <Field label="Agrégation des runs">
      <Select value={bin} onChange={setBin} options={BIN_OPTIONS} title={binTitle} />
    </Field>
    <Field label="Fenêtre">
      <Button
        size="sm"
        variant={zoomAuto ? 'solid' : 'outline'}
        onClick={() => setZoomAuto((z) => !z)}
        title="Zoom sur les runs filtres (3 h mini) / journee complete"
      >
        {zoomAuto ? '🔍 Zoom auto' : '🕐 Journée complète'}
      </Button>
    </Field>
    <Field label="Regroupement">
      <HStack gap={1}>
        <Button
          size="sm"
          variant={grouped ? 'solid' : 'outline'}
          onClick={() => setGrouped((g) => !g)}
          title="Regrouper les DAGs par tag principal / liste plate"
        >
          {grouped ? '🗂 Groupes' : '📄 Liste'}
        </Button>
        {showCollapseAll && (
          <Button size="sm" variant="ghost" onClick={toggleCollapseAll}>
            {allCollapsed ? '▸ Tout déplier' : '▾ Tout replier'}
          </Button>
        )}
      </HStack>
    </Field>
    <Field label="Ordre des groupes (tags, par priorité)">
      <Input
        data-gk-ui="stages-input"
        placeholder="ex. collecte, normalisation, export"
        size="sm"
        maxW="220px"
        value={stagesText}
        onChange={(e) => setStagesText(e.target.value)}
        title="Ex. collecte, normalisation, raffinement, export — le tag principal (donc le groupe) est le premier de cette liste présent sur le DAG. Vide = détection automatique par fréquence. Ne filtre rien : ça ne change que l'ordre et l'appartenance des groupes."
      />
    </Field>
    <Spacer />
    <Field>
      {/* `data-gk-ui` : sélecteur stable pour les tests, sans rapport avec `data-gk` (les barres). */}
      <Button
        size="sm"
        variant="outline"
        data-gk-ui="refresh"
        onClick={onRefresh}
        title="Recharger les runs de la journée (sinon rafraîchissement auto toutes les 30 s)"
      >
        ⟳ Rafraîchir
      </Button>
    </Field>
  </Flex>
);

export const ControlRibbon = ({
  ribbon,
  date,
  setDate,
  loading,
  error,
  nameFilter,
  setNameFilter,
  tagFilter,
  setTagFilter,
  allTags,
  stagesText,
  setStagesText,
  legendStates,
  stateSet,
  stateCounts,
  toggleState,
  setStateFilter,
  resetFilters,
  hasActiveFilters,
  sortKey,
  setSortKey,
  bin,
  setBin,
  binTitle,
  zoomAuto,
  setZoomAuto,
  grouped,
  setGrouped,
  showCollapseAll,
  allCollapsed,
  toggleCollapseAll,
  onRefresh,
  summaryLabel,
  summaryTitle,
  windowChipLabel,
  windowChipTitle,
}) => {
  // Combien de puces sont visibles : 0 -> le conteneur lui-même se met en `hidden`
  // (il reste dans le DOM, comme les puces et les panneaux).
  const activeChips = (nameFilter.trim() ? 1 : 0) + (tagFilter ? 1 : 0) + (stateSet.size > 0 ? 1 : 0);
  return (
    <VStack alignItems="stretch" gap={2} data-gk-ui="ribbon">
      {/* Ligne permanente : titre, date, onglets, statut — visible même ruban replié. */}
      <HStack gap={3} flexWrap="wrap">
        <Text fontSize="xl" fontWeight="bold">📊 Global Dag Gantt</Text>
        <DateNav date={date} setDate={setDate} />
        {/* Onglets fabriqués avec les composants déjà sûrs de l'hôte (pas de Tabs
            Chakra dont la présence n'est pas garantie — même garde-fou que NativeSelect). */}
        <HStack gap={1} role="tablist" data-gk-ui="tabs" aria-label="Catégories de contrôles">
          {PANEL_TABS.map((t) => {
            const active = ribbon.open && ribbon.tab === t.key;
            return (
              <Button
                key={t.key}
                size="sm"
                role="tab"
                data-gk-ui={`tab-${t.key}`}
                variant={active ? 'solid' : 'outline'}
                aria-selected={active}
                aria-expanded={active}
                onClick={() => ribbon.toggle(t.key)}
                title={`${t.label} — cliquer pour ${active ? 'replier' : 'ouvrir'}`}
              >
                {t.icon} {t.label}
              </Button>
            );
          })}
        </HStack>
        {/* Puces des filtres actifs, **à droite des onglets** : c'est ce qui rappelle que
            la vue est filtrée quand le panneau est replié, et chacune se retire par son ✕.
            Jamais démontées, seulement masquées — DOM et sélecteurs restent stables. */}
        <HStack gap={2} flexWrap="wrap" data-gk-ui="chips" hidden={activeChips === 0}>
          <FilterChip name="q" shown={Boolean(nameFilter.trim())} label="nom" value={nameFilter.trim()} onClear={() => setNameFilter('')} />
          <FilterChip name="tag" shown={Boolean(tagFilter)} label="tag" value={tagFilter} onClear={() => setTagFilter('')} />
          <FilterChip
            name="state"
            shown={stateSet.size > 0}
            label="états"
            value={Array.from(stateSet).join(', ')}
            onClear={() => setStateFilter([])}
          />
        </HStack>
        <Spacer />
        {/* Puce d'état de la fenêtre : ce que l'axe montre (l'étendue) et le mode qui le
            produit, en deux caractères — et **cliquable**, puisqu'elle ne fait que renvoyer
            au même état `zoomAuto` que l'onglet Affichage : une seule source de vérité,
            deux façons d'agir dessus. */}
        <HStack
          as="button"
          type="button"
          gap={1}
          px={2}
          py="2px"
          borderWidth="1px"
          borderColor="border.default"
          borderRadius="full"
          bg="bg.subtle"
          fontSize="11px"
          cursor="pointer"
          whiteSpace="nowrap"
          data-gk-ui="window-chip"
          onClick={() => setZoomAuto((z) => !z)}
          title={windowChipTitle}
        >
          <Text as="span">{zoomAuto ? '🔍' : '🕐'}</Text>
          <Text as="span" fontWeight="semibold">{windowChipLabel}</Text>
        </HStack>
        {/* La ligne du haut ne garde que ce que l'axe du Gantt ne dit pas : combien de runs
            survivent aux filtres et combien l'agrégation en a fusionnés. Fenêtre, bornes et
            tranche passent en infobulle. */}
        <Text fontSize="sm" color="fg.muted" data-gk-ui="summary" title={summaryTitle}>
          {summaryLabel}
        </Text>
      </HStack>

      {/* Panneaux : fond `bg.subtle` (gray.50 / gray.950) pour le détacher de la page, bord
          `border.muted` et **arête basse** `border.default` (gray.200 / gray.800) — le liseré
          demandé, en tokens : un #ddd en dur ferait une tache en thème sombre. Pas d'ombre :
          `boxShadow` rend un dégradé bien plus lourd que le trait attendu (retour utilisateur).
          Tokens vérifiés dans le thème de l'hôte (bundle UI : border.{subtle,muted,DEFAULT,
          emphasized} = gray.50/100/200/… selon le mode). */}
      <RibbonFiltersPanel
        visible={ribbon.open && ribbon.tab === 'filters'}
        nameFilter={nameFilter}
        setNameFilter={setNameFilter}
        tagFilter={tagFilter}
        setTagFilter={setTagFilter}
        allTags={allTags}
        legendStates={legendStates}
        stateSet={stateSet}
        stateCounts={stateCounts}
        toggleState={toggleState}
        hasActiveFilters={hasActiveFilters}
        resetFilters={resetFilters}
      />

      <RibbonViewPanel
        visible={ribbon.open && ribbon.tab === 'view'}
        sortKey={sortKey}
        setSortKey={setSortKey}
        bin={bin}
        setBin={setBin}
        binTitle={binTitle}
        zoomAuto={zoomAuto}
        setZoomAuto={setZoomAuto}
        grouped={grouped}
        setGrouped={setGrouped}
        showCollapseAll={showCollapseAll}
        allCollapsed={allCollapsed}
        toggleCollapseAll={toggleCollapseAll}
        stagesText={stagesText}
        setStagesText={setStagesText}
        onRefresh={onRefresh}
      />

      {error && (
        <Box bg="failed.surface" p={3} borderRadius="md">
          <Text color="failed.solid">Erreur API : {error}</Text>
        </Box>
      )}
    </VStack>
  );
};
