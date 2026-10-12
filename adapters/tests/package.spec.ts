import { expect, test } from 'bun:test'
import { readFile, readdir } from 'node:fs/promises'
import { DEFAULTS, SECTIONS } from '../../hooks/policy.ts'

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

/** Both settings screens list the settings in SECTIONS order, so the flat host dialogs read as sections too. */
test('every setting is in one section, and the plugin and omp schemas follow that order', async () => {
  const order: string[] = Object.values(SECTIONS).flat()
  expect([...order].sort()).toEqual(Object.keys(DEFAULTS).sort())
  expect(new Set(order).size).toBe(order.length)
  const plugin = JSON.parse(await readFile('.claude-plugin/plugin.json', 'utf8')) as { userConfig: Record<string, unknown> }
  const pkg = JSON.parse(await readFile('package.json', 'utf8')) as { omp: { settings: Record<string, unknown> } }
  expect(Object.keys(plugin.userConfig)).toEqual(order)
  expect(Object.keys(pkg.omp.settings)).toEqual(order)
})

test('package.json, the Claude Code plugin and the Codex plugin carry the same version', async () => {
  const v = async (p: string) => (JSON.parse(await readFile(p, 'utf8')) as { version: string }).version
  const pkg = await v('package.json')
  expect(await v('.claude-plugin/plugin.json')).toBe(pkg)
  expect(await v('.codex-plugin/plugin.json')).toBe(pkg)
})
