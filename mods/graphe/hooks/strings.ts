// Every string the Graphe pane and /graphe show, one table per language. The
// `lang` option picks the table; French is the default and the owner's. The
// graph's own data (node ids, relations, quotes) is shown as written, and the
// build date stays as the journal writes it (ISO, 2026-10-29) in both.

export type Lang = 'fr' | 'en'

export const langOf = (setting: unknown): Lang => (setting === 'en' ? 'en' : 'fr')

const plural = (count: number, word: string): string => `${count} ${word}${count > 1 ? 's' : ''}`

const fr = {
  paneTitle: 'Graphe',
  commandDescription: 'Draw the writings graph, or one node and its neighbours; --tout shows posts and fiction too',
  // The flag that shows every genre; register.tsx also accepts the other table's.
  flagAll: '--tout',
  reply: 'Graphe.',
  replyCentred: (id: string) => `Graphe autour de ${id}.`,
  // The graph file, when it cannot be drawn.
  absent: 'Pas de graphe construit : plan B, tâche B6',
  unreadable: 'graphe.json illisible',
  // On the disk but not readable: on iCloud, a file evicted to the cloud.
  evicted: 'graphe.json illisible (fichier évincé par iCloud ?)',
  noMatch: 'aucun nœud',
  more: (hidden: number) => `… et ${hidden} autre${hidden > 1 ? 's' : ''}`,
  // The build journal header.
  unknownDate: 'date inconnue',
  built: (date: string, nodes: number, links: number, share: number) => `Construit le ${date} · ${nodes} nœuds · ${links} liens · ${share} % isolés`,
  journalUnreadable: 'journal illisible',
  neverBuilt: 'jamais construit',
  lastRun: (code: string) => `dernier lancement : code ${code}`,
  neverBuiltClean: (lastRun: string) => `jamais construit proprement · ${lastRun}`,
  cleanCode: 'code 0',
  // The live centre's header.
  centredOn: (id: string, why: string) => `centré sur « ${id} » : le plus proche de cette conversation (${why})`,
  byHaiku: 'choisi par Haiku',
  // The stats strip under the header.
  stats: (spark: string, nodes: number, links: number) => `degrés ${spark} · ${plural(nodes, 'nœud')} · ${plural(links, 'lien')}`,
  searchPlaceholder: 'Chercher un nœud',
  quote: (text: string) => `« ${text} »`,
  // The legend's name for each node type, keyed as the extraction writes it.
  types: { idee: 'idée', gout: 'goût', reference: 'référence', vecu: 'vécu', personne: 'personne', geste: 'geste' } as Readonly<Record<string, string>>,
}

export type Strings = typeof fr

const en: Strings = {
  paneTitle: 'Graph',
  commandDescription: 'Draw the writings graph, or one node and its neighbours; --all shows posts and fiction too',
  flagAll: '--all',
  reply: 'Graph.',
  replyCentred: id => `Graph around ${id}.`,
  absent: 'No graph built: plan B, task B6',
  unreadable: 'graphe.json is unreadable',
  evicted: 'graphe.json is unreadable (evicted by iCloud?)',
  noMatch: 'no node found',
  more: hidden => `… and ${hidden} more`,
  unknownDate: 'unknown date',
  built: (date, nodes, links, share) => `Built ${date} · ${plural(nodes, 'node')} · ${plural(links, 'link')} · ${share}% isolated`,
  journalUnreadable: 'journal is unreadable',
  neverBuilt: 'never built',
  lastRun: code => `last run: exit ${code}`,
  neverBuiltClean: lastRun => `never built cleanly · ${lastRun}`,
  cleanCode: 'exit 0',
  centredOn: (id, why) => `centred on “${id}”: the closest to this conversation (${why})`,
  byHaiku: 'chosen by Haiku',
  stats: (spark, nodes, links) => `degrees ${spark} · ${plural(nodes, 'node')} · ${plural(links, 'link')}`,
  searchPlaceholder: 'Search a node',
  quote: text => `“${text}”`,
  types: { idee: 'idea', gout: 'taste', reference: 'reference', vecu: 'lived', personne: 'person', geste: 'gesture' },
}

export const STRINGS: Readonly<Record<Lang, Strings>> = { fr, en }
