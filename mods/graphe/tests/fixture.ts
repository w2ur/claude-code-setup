import type { Graphe } from '../hooks/layout'

// An invented graph: no node, slug or citation here comes from a real text,
// because this folder is published. "borges" has three neighbours, each with
// one or two more; "la promenade" sits at distance 3 from it.
//
// Degrees: borges, la bibliothèque, écrire court, le labyrinthe 3; le carnet,
// le silence, le miroir 2; la nuit, la promenade 1. Two more nodes hang off "la
// promenade", hidden by default: "le brouillon" (genre post) and "la tempête"
// (genre fiction); the degrees above are those of the default view.

const mention = (slug: string, citation: string) => [
  { source_id: `article:${slug}`, slug, date: '2026-01-02', resume: 'Résumé inventé.', citation },
]

const node = (id: string, type: string, citation = `Une phrase inventée sur ${id}.`, genre = 'article') => ({
  id,
  type,
  genre,
  premiere_date: '2026-01-02',
  mentions: mention('texte-de-test-un', citation),
})

const edge = (from: string, to: string, relation: string, genre = 'article') => ({
  from,
  to,
  relation,
  citation: `Un lien inventé entre ${from} et ${to}.`,
  source_id: 'article:texte-de-test-un',
  genre,
})

export const GRAPHE: Graphe = {
  nodes: [
    node('borges', 'personne', 'Une citation inventée pour le centre du test.'),
    node('la bibliothèque', 'reference'),
    node('écrire court', 'geste'),
    node('le labyrinthe', 'idee'),
    node('le silence', 'idee'),
    node('la nuit', 'vecu'),
    node('le miroir', 'idee'),
    node('le carnet', 'gout'),
    node('la promenade', 'vecu'),
    node('le brouillon', 'idee', 'Une phrase inventée dans un post.', 'post'),
    node('la tempête', 'vecu', 'Une phrase inventée dans une nouvelle.', 'fiction'),
  ],
  edges: [
    edge('borges', 'la bibliothèque', 'habite'),
    edge('borges', 'écrire court', 'pratique'),
    edge('le labyrinthe', 'borges', 'obsède'),
    edge('la bibliothèque', 'le silence', 'abrite'),
    edge('la bibliothèque', 'la nuit', 'veille'),
    edge('le labyrinthe', 'le miroir', 'redouble'),
    edge('le labyrinthe', 'le silence', 'mène à'),
    edge('écrire court', 'le carnet', 'remplit'),
    edge('écrire court', 'le miroir', 'retourne'),
    edge('le carnet', 'la promenade', 'accompagne'),
    edge('la promenade', 'le brouillon', 'annonce', 'post'),
    edge('la tempête', 'la promenade', 'traverse', 'fiction'),
  ],
}

export const JOURNAL =
  '{"date":"2026-01-01","sources":4,"extraits_neufs":4,"differes":0,"noeuds":7,"liens":6,"isoles":1,"exit":0}\n' +
  '{"date":"2026-01-02","sources":5,"extraits_neufs":1,"differes":0,"noeuds":9,"liens":10,"isoles":1,"exit":0}\n'
