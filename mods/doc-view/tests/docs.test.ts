import { expect, test } from 'claude-code/testing'

import { EMPTY, MAX_CHARS, MAX_FILES, clip, find, isMarkdown, label, mdPaths, remember, remind, select, shortPath } from '../hooks/docs'

test('isMarkdown matches md, markdown and mdx only', async () => {
  expect(isMarkdown('/a/README.md')).toBe(true)
  expect(isMarkdown('/a/notes.MARKDOWN')).toBe(true)
  expect(isMarkdown('/a/page.mdx')).toBe(true)
  expect(isMarkdown('/a/register.tsx')).toBe(false)
  expect(isMarkdown('/a/md')).toBe(false)
})

test('remember puts the file first, selects it, dedupes and caps', async () => {
  let d = remember(EMPTY, '/a.md')
  d = remember(d, '/b.md')
  d = remember(d, '/a.md')
  expect(d.files).toEqual(['/a.md', '/b.md'])
  expect(d.selected).toBe('/a.md')
  expect(d.revision).toBe(3)
  for (let i = 0; i < MAX_FILES + 5; i++) d = remember(d, `/f${i}.md`)
  expect(d.files).toHaveLength(MAX_FILES)
})

test('select ignores a file never written', async () => {
  const d = remember(EMPTY, '/a.md')
  expect(select(d, '/zzz.md')).toBe(d)
})

test('shortPath folds home, clip truncates past the cap', async () => {
  expect(shortPath('/home/{username}/Dev/x.md', '/home/{username}/Dev/x.md')
  expect(shortPath('/home/{username}/x.md', '/home/{username}/home/wx/x.md')
  expect(clip('short')).toBe('short')
  expect(clip('a'.repeat(MAX_CHARS + 10))).toContain('truncated: 10 more')
})


test('clip strips control characters but keeps tabs and lines', async () => {
  expect(clip('a\u001b[31mb\fc\u0000d\te\r\nf')).toBe('a[31mbcd\te\nf')
})

test('clip closes a code fence it cuts through', async () => {
  const out = clip('```\n' + 'x'.repeat(MAX_CHARS + 5))
  expect(out).toContain('\n```\n\n*… truncated')
  expect(clip('```\nx\n```\n' + 'y'.repeat(MAX_CHARS)).includes('\n```\n\n*')).toBe(false)
})

test('label disambiguates shared base names, find accepts every shown form', async () => {
  const files = ['/h/Dev/b/README.md', '/h/Dev/a/README.md', '/h/plan.md']
  expect(label('/h/Dev/a/README.md', files)).toBe('a/README.md')
  expect(label('/h/plan.md', files)).toBe('plan.md')
  expect(find(files, 'a/README.md', '/h')).toBe('/h/Dev/a/README.md')
  expect(find(files, '~/Dev/a/README.md', '/h')).toBe('/h/Dev/a/README.md')
  expect(find(files, 'README.md', '/h')).toBe('/h/Dev/b/README.md')
  expect(find(files, 'nope.md', '/h')).toBeUndefined()
})

test('remind adds without taking the selection', async () => {
  const d = remind(remember(EMPTY, '/a.md'), '/b.md')
  expect(d.files).toEqual(['/b.md', '/a.md'])
  expect(d.selected).toBe('/a.md')
})

test('mdPaths finds bare, quoted, ~ and relative markdown paths', async () => {
  expect(mdPaths(`cat > ~/x/notes.md <<'EOF'`, '/h')).toEqual(['/h/x/notes.md'])
  expect(mdPaths(`sed -i '' 's/a/b/' "/abs/c.md" docs/r.markdown; echo x.mdx`, '/h')).toEqual(['/abs/c.md', 'docs/r.markdown', 'x.mdx'])
  expect(mdPaths('ls src/x.mdown file.md.bak', '/h')).toEqual([])
})
