// Every string the Portrait pane and /portrait show, one table per language.
// The `lang` option picks the table; French is the default and the owner's.
// Dates stay ISO (2026-10-29) in both: they come from mtimes and file names.

export type Lang = 'fr' | 'en'

export const langOf = (setting: unknown): Lang => (setting === 'en' ? 'en' : 'fr')

const fr = {
  paneTitle: 'Portrait',
  commandDescription: 'Show the owner portrait key points, recent memories and the portrait check',
  // The replies to /portrait.
  replyKeyPoints: 'Points clés.',
  replyWhole: 'Portrait entier.',
  // The verbs /portrait takes; register.tsx also accepts the other table's.
  verbWhole: 'tout',
  verbApply: 'applique',
  verbDiscard: 'ecarte',
  usageApply: (typed: string) => `usage : /${typed} applique <AAAA-MM-JJ> <n> [<n>…]`,
  usageDiscard: (typed: string) => `usage : /${typed} ecarte <AAAA-MM-JJ>`,
  noProposal: (date: string) => `pas de proposition du ${date}`,
  alreadyTreated: (date: string) => `proposition du ${date} déjà traitée : retirer proposition-${date}.md à la main`,
  stuck: 'proposition non déplacée : à retirer à la main',
  discarded: (date: string) => `proposition du ${date} écartée`,
  unknownNumbers: (list: string) => `numéro absent de la proposition : ${list}`,
  noPortraitApplied: 'pas de portrait : rien appliqué',
  refusedMissing: (n: number) => `refusé : ligne ${n} introuvable dans le portrait`,
  refusedAmbiguous: (n: number) => `refusé : ligne ${n} ambiguë`,
  restoreFailedThreshold: 'restauration impossible : portrait au-dessus du seuil',
  restoreFailedCheck: 'restauration impossible : contrôle impossible',
  refusedThreshold: 'refusé : portrait au-dessus du seuil',
  refusedCheck: 'refusé : contrôle impossible, portrait restauré',
  applied: (list: string) => `appliquées : ${list}`,
  appliedStuck: (list: string, stuck: string) => `appliquées : ${list} ; ${stuck}`,
  // The pane.
  checkUnavailable: 'contrôle indisponible',
  noPortrait: 'Pas de portrait : plan A, tâche A2',
  recentHeading: 'Derniers souvenirs',
  proposalsHeading: 'Propositions',
  noProposals: 'aucune proposition',
  proposalHint: (date: string, typed: string) => `du ${date} : /${typed} applique ${date} <n…> ou ecarte ${date}`,
  // The heading an applied `+` line is filed under when the portrait has none.
  toFileHeading: '## À ranger',
  // The calligram and its gauge.
  sizeSummary: (n: number, limit: number, pct: number) => `${n} / ${limit} caractères · ${pct} %`,
  afterProposals: (size: number) => `${size} après propositions`,
  overflow: (over: number) => `+${over} car. au-delà du seuil`,
  gaugeLabel: 'Taille ',
  gaugeCount: (n: number, limit: number) => ` ${n} / ${limit} car.`,
  // Farben and the activity series.
  typeLabels: { feedback: 'feedback', project: 'projet', user: 'utilisateur', reference: 'référence', autre: 'autre' },
  farbenHeading: (count: number) => `Farben · ${count} ${count === 1 ? 'souvenir' : 'souvenirs'}`,
  pendingItems: (count: number) => `${count} ${count === 1 ? 'proposition' : 'propositions'} en attente`,
  filesChanged: (count: number) => `${count} ${count === 1 ? 'fichier modifié' : 'fichiers modifiés'}`,
  activityLong: 'Activité · 30 derniers jours',
  activityShort: 'Activité · 30 jours',
}

export type Strings = typeof fr

const en: Strings = {
  paneTitle: 'Portrait',
  commandDescription: fr.commandDescription,
  replyKeyPoints: 'Key points.',
  replyWhole: 'Whole portrait.',
  verbWhole: 'all',
  verbApply: 'apply',
  verbDiscard: 'discard',
  usageApply: typed => `usage: /${typed} apply <YYYY-MM-DD> <n> [<n>…]`,
  usageDiscard: typed => `usage: /${typed} discard <YYYY-MM-DD>`,
  noProposal: date => `no proposal from ${date}`,
  alreadyTreated: date => `proposal from ${date} already handled: remove proposition-${date}.md by hand`,
  stuck: 'proposal not moved: remove it by hand',
  discarded: date => `proposal from ${date} discarded`,
  unknownNumbers: list => `not in the proposal: ${list}`,
  noPortraitApplied: 'no portrait: nothing applied',
  refusedMissing: n => `refused: line ${n} not found in the portrait`,
  refusedAmbiguous: n => `refused: line ${n} is ambiguous`,
  restoreFailedThreshold: 'restore failed: portrait over the threshold',
  restoreFailedCheck: 'restore failed: check could not run',
  refusedThreshold: 'refused: portrait over the threshold',
  refusedCheck: 'refused: check could not run, portrait restored',
  applied: list => `applied: ${list}`,
  appliedStuck: (list, stuck) => `applied: ${list}; ${stuck}`,
  checkUnavailable: 'check unavailable',
  noPortrait: 'No portrait: plan A, task A2',
  recentHeading: 'Recent memories',
  proposalsHeading: 'Proposals',
  noProposals: 'no proposals',
  proposalHint: (date, typed) => `from ${date}: /${typed} apply ${date} <n…> or discard ${date}`,
  toFileHeading: '## To file',
  sizeSummary: (n, limit, pct) => `${n} / ${limit} characters · ${pct}%`,
  afterProposals: size => `${size} after proposals`,
  overflow: over => `+${over} chars over the threshold`,
  gaugeLabel: 'Size ',
  gaugeCount: (n, limit) => ` ${n} / ${limit} chars`,
  typeLabels: { feedback: 'feedback', project: 'project', user: 'user', reference: 'reference', autre: 'other' },
  farbenHeading: count => `Farben · ${count} ${count === 1 ? 'memory' : 'memories'}`,
  pendingItems: count => `${count} ${count === 1 ? 'proposal' : 'proposals'} pending`,
  filesChanged: count => `${count} ${count === 1 ? 'file changed' : 'files changed'}`,
  activityLong: 'Activity · last 30 days',
  activityShort: 'Activity · 30 days',
}

export const STRINGS: Readonly<Record<Lang, Strings>> = { fr, en }
