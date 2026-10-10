import { expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'

/** 0.3.1 shipped without hooks/dashboard.ts and pi failed to start: every hooks file the adapters reach must be in `files`. */
test('the npm package ships every hooks file the adapters import', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { files: string[] }
  const needed = new Set<string>()
  const scan = async (p: string): Promise<void> => {
    for (const m of (await readFile(p, 'utf8')).matchAll(/from '(\.\.\/hooks|\.)\/([a-z]+)\.ts'/g)) {
      const dep = m[1] === '../hooks' || p.startsWith('hooks/') ? `hooks/${m[2]}.ts` : `adapters/${m[2]}.ts`
      if (dep.startsWith('hooks/') && !needed.has(dep)) {
        needed.add(dep)
        await scan(dep)
      }
    }
  }
  for (const n of await readdir('adapters')) if (n.endsWith('.ts')) await scan(`adapters/${n}`)
  expect(needed.size).toBeGreaterThan(0)
  for (const f of needed) expect(pkg.files, `${f} is missing from package.json files`).toContain(f)
})
