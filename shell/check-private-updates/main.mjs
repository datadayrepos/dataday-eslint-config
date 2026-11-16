import { execFile, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { constants } from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import semver from 'semver'

// Canonical copyable operator bundle: keep project-specific choices out of these files.
export const packageRoot = fileURLToPath(new URL('../../', import.meta.url))
const sections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']
const scopes = ['@ivstrand/', '@datadayrepos/']
const execute = promisify(execFile)
const managerEnvironment = { ...process.env, COREPACK_ENABLE_NETWORK: '0', COREPACK_ENABLE_AUTO_PIN: '0' }
const paint = (code, text, enabled) => enabled ? `\x1B[${code}m${text}\x1B[0m` : text
const cell = value => String(value ?? '-').replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ')

export function detectManager(root, manifest) {
  const lockfiles = {
    pnpm: ['pnpm-lock.yaml'],
    npm: ['package-lock.json', 'npm-shrinkwrap.json'],
    yarn: ['yarn.lock'],
    bun: ['bun.lock', 'bun.lockb'],
  }
  const present = Object.keys(lockfiles).filter(name => lockfiles[name].some(file => fs.existsSync(path.join(root, file))))
  const declared = typeof manifest.packageManager === 'string' && manifest.packageManager.match(/^(npm|pnpm)@(.+)$/)
  if (manifest.packageManager && (!declared || !semver.valid(declared[2])))
    throw new Error('Unsupported packageManager declaration; this bundle supports npm and pnpm with exact manager versions.')
  if (present.length > 1 || (declared && present.length && present[0] !== declared[1]))
    throw new Error('Conflicting package-manager declarations/lockfiles; choose the intended manager before updating.')
  const name = declared?.[1] ?? present[0]
  if (!['npm', 'pnpm'].includes(name))
    throw new Error('Cannot select npm or pnpm unambiguously from this package; no installer was run.')
  return { name, version: declared?.[2] ?? null }
}

export function proposeDeclaration(current, latest) {
  if (typeof current !== 'string' || !current.trim() || !semver.validRange(current))
    return { proposed: null, status: 'manual review', detail: 'Preserve non-SemVer declarations, including workspace/local references and tags.' }
  if (!semver.valid(latest || ''))
    return { proposed: null, status: 'lookup failed', detail: 'Registry latest is unavailable or invalid.' }
  const exact = semver.valid(current)
  if (exact) {
    return semver.gt(latest, exact)
      ? { proposed: latest, status: 'update', detail: 'Exact declaration remains exact.' }
      : { proposed: null, status: 'no newer release', detail: 'Keep the declaration; never downgrade to latest.' }
  }
  if (semver.satisfies(latest, current))
    return { proposed: null, status: 'already allowed', detail: 'Latest fits the existing range; no minimum or lock-only refresh is proposed.' }
  const simple = current.match(/^(\s*(?:\^|~|>=)\s*)(\S+)(\s*)$/)
  if (simple && semver.valid(simple[2]) && semver.gt(latest, simple[2]))
    return { proposed: `${simple[1]}${latest}${simple[3]}`, status: 'range review', detail: 'Latest is outside the range; preserve the operator and explicitly review compatibility.' }
  return { proposed: null, status: 'manual review', detail: 'Preserve this compound/comparator range; no automatic rewrite.' }
}

function dependencyGroups(manifest) {
  const groups = new Map()
  for (const section of sections) {
    for (const [name, current] of Object.entries(manifest[section] || {})) {
      if (!scopes.some(scope => name.startsWith(scope)))
        continue
      if (!groups.has(name))
        groups.set(name, { name, latest: null, fields: [] })
      groups.get(name).fields.push({ section, current, selected: false })
    }
  }
  return [...groups.values()]
}

export async function collectUpdates(manifest, lookup, progress = () => {}) {
  const groups = dependencyGroups(manifest)
  const targets = groups.filter(group => group.fields.some(field => typeof field.current === 'string' && field.current.trim() && semver.validRange(field.current)))
  let next = 0
  let completed = 0
  async function worker() {
    while (next < targets.length) {
      const group = targets[next++]
      try {
        group.latest = await lookup(group.name)
        if (!semver.valid(group.latest || ''))
          throw new Error('Registry returned an invalid latest version.')
      }
      catch (error) { group.error = error.message }
      progress(++completed, targets.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, targets.length) }, worker))
  for (const group of groups) {
    for (const field of group.fields) {
      Object.assign(field, proposeDeclaration(field.current, group.latest))
      if (group.error && field.status === 'lookup failed')
        field.detail = group.error
      field.result = field.proposed ? 'not selected' : field.status
    }
  }
  return groups
}

export function renderGroup(group, fields = group.fields, colors = false) {
  return [
    paint(36, group.name, colors),
    ...fields.map(field => `  ${field.section.padEnd(21)} ${paint(2, field.current, colors)} -> ${paint(field.proposed ? 36 : 2, field.proposed ?? field.current, colors)}  [${field.status}]`),
    ...new Set(fields.filter(field => ['range review', 'manual review', 'already allowed', 'lookup failed'].includes(field.status)).map(field => `  ${paint(33, field.detail, colors)}`)),
    ...(group.error ? [paint(31, `  LOOKUP FAILED: ${group.error}`, colors)] : []),
    '',
  ].join('\n')
}

function renderReport(groups, outcome) {
  return [
    '# Dependency Update Report',
    '',
    `Outcome: ${cell(outcome)}`,
    '',
    '| Package | Field | Current declaration | Registry latest | Proposed declaration | Result | Detail |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...groups.flatMap(group => group.fields.map(field => `| ${[group.name, field.section, field.current, group.latest, field.proposed ?? 'unchanged', field.result, field.detail].map(cell).join(' | ')} |`)),
    '',
  ].join('\n')
}

async function queryLatest(root, name) {
  try {
    const result = await execute('npm', ['view', name, 'dist-tags.latest', '--json'], { cwd: root, timeout: 30000 })
    return JSON.parse(result.stdout)
  }
  catch (error) {
    // Preserve useful failure categories without echoing registry URLs or credentials.
    const code = String(error.stderr || '').match(/\b(E401|E403|E404|ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED)\b/)?.[1]
    throw new Error(`npm lookup failed (${error.killed ? 'timeout' : code || error.code || 'invalid response'}); check registry access/authentication.`)
  }
}

function authenticate(root) {
  const loggedIn = () => spawnSync('npm', ['whoami'], { cwd: root, stdio: 'ignore', timeout: 30000 }).status === 0
  if (loggedIn())
    return
  process.stdout.write('npm login is required. Starting browser-based login...\n')
  const result = spawnSync('npm', ['login', '--auth-type=web'], { cwd: root, stdio: 'inherit' })
  if (result.error || result.status !== 0 || !loggedIn())
    throw new Error('npm login is not active; no updates applied.')
}

function checkInstaller(root, manager) {
  const result = spawnSync(manager.name, ['--version'], { cwd: root, encoding: 'utf8', env: managerEnvironment, timeout: 30000 })
  const version = result.stdout?.trim()
  if (result.error || result.status !== 0 || !semver.valid(version || ''))
    throw new Error(`${manager.name} is unavailable. Set up the package manager normally; this updater does not install it.`)
  if (manager.version && !semver.eq(version, manager.version))
    throw new Error(`packageManager requires ${manager.name}@${manager.version}, but PATH provides ${version}. Use the declared toolchain before updating.`)
}

function installDependencies(root, manager) {
  const result = spawnSync(manager.name, ['install'], { cwd: root, stdio: 'inherit', env: managerEnvironment })
  if (result.error || result.status !== 0)
    throw new Error(`${manager.name} install failed. Review the accepted manifest edits and package-manager output before retrying; no automatic rollback.`)
}

export async function runUpdates(root, options = {}) {
  const output = options.output ?? process.stdout
  const colors = Boolean(output.isTTY && !Object.hasOwn(process.env, 'NO_COLOR') && process.env.TERM !== 'dumb')
  const print = text => output.write(`${text}\n`)
  const manifestPath = path.join(root, 'package.json')
  const original = fs.readFileSync(manifestPath, 'utf8')
  const manifest = JSON.parse(original)
  if (!dependencyGroups(manifest).length) {
    print('No matching private dependencies; nothing to update.')
    return 0
  }
  const manager = detectManager(root, manifest)
  print(`Package: ${manifestPath}\nInstaller: ${manager.name}${manager.version ? `@${manager.version}` : ''}`)
  if (!options.ask && !process.stdin.isTTY)
    throw new Error('An interactive terminal is required; no updates applied.')
  const verifyInstaller = options.checkInstaller ?? checkInstaller
  verifyInstaller(root, manager)
  const hasRegistryTargets = dependencyGroups(manifest).some(group => group.fields.some(field => typeof field.current === 'string' && field.current.trim() && semver.validRange(field.current)))
  if (hasRegistryTargets)
    await (options.authenticate ?? authenticate)(root)
  print('Scanning private packages; no dependency approvals until collection finishes...')
  const groups = await collectUpdates(manifest, name => (options.lookup ?? queryLatest)(root, name), (done, total) => {
    if (output.isTTY)
      output.write(`\rScanning: ${done}/${total}`)
  })
  if (output.isTTY && hasRegistryTargets)
    print('')
  const proposed = groups.filter(group => group.fields.some(field => field.proposed))
  let incomplete = groups.some(group => group.error)
  const report = outcome => fs.writeFileSync(path.join(root, 'dependency-update-report.md'), renderReport(groups, outcome))
  print(`\n${paint(36, 'SCAN COMPLETE - REVIEW SUMMARY', colors)}\n${proposed.length} package(s) with proposed changes; ${groups.filter(group => group.error).length} failed lookup(s).`)
  for (const group of groups)
    print(renderGroup(group, group.fields, colors))
  report('Review pending; no manifest or installation changes applied.')
  let reader
  let phase = 'review'
  try {
    const controller = new AbortController()
    const ask = options.ask ?? (async (question) => {
      if (!reader) {
        reader = createInterface({ input: process.stdin, output })
        reader.once('close', () => controller.abort())
      }
      return reader.question(question, { signal: controller.signal })
    })
    for (const [index, group] of proposed.entries()) {
      print(`\n${paint(36, `[${index + 1}/${proposed.length}] REVIEW`, colors)}`)
      for (const peer of [false, true]) {
        const fields = group.fields.filter(field => field.proposed && (field.section === 'peerDependencies') === peer)
        if (!fields.length)
          continue
        if (peer)
          print(paint(33, 'Peer declarations are consumer compatibility promises; review separately. No development dependency will be added.', colors))
        print(renderGroup(group, peer ? fields : group.fields, colors))
        const answer = await ask(`${peer ? 'Apply these peer compatibility declarations' : 'Apply these dependency declarations'}? [y/N] `)
        if (answer === null || answer === undefined)
          throw new Error('Input closed before application.')
        for (const field of fields) {
          field.selected = /^y$/i.test(answer.trim())
          field.result = field.selected ? 'accepted; not applied yet' : 'declined'
        }
        print(fields.some(field => field.selected) ? 'Accepted for application after review.' : 'Declined; these declarations stay unchanged.')
      }
      if (group.fields.some(field => field.selected) && group.fields.some(field => !semver.validRange(field.selected ? field.proposed : field.current) || !semver.satisfies(group.latest, field.selected ? field.proposed : field.current))) {
        incomplete = true
        print(paint(31, `${group.name}: conflicting declarations; this package will NOT be changed. Select compatible peer/dev declarations together.`, colors))
        for (const field of group.fields.filter(field => field.selected)) {
          field.selected = false
          field.result = 'not applied: declaration conflict'
        }
      }
    }
    const selected = groups.flatMap(group => group.fields.filter(field => field.selected).map(field => ({ ...field, name: group.name })))
    if (!selected.length) {
      report('No updates applied; installation skipped.')
      print('No updates accepted for application; installation skipped.')
      if (incomplete)
        print(paint(33, 'Scan incomplete or declarations conflicted; review the failures in dependency-update-report.md.', colors))
      return incomplete ? 1 : 0
    }
    if (fs.readFileSync(manifestPath, 'utf8') !== original)
      throw new Error('package.json changed during review; rerun without overwriting those edits.')
    for (const field of selected)
      manifest[field.section][field.name] = field.proposed
    phase = 'application'
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    phase = 'installation'
    report('Accepted declarations applied; installation pending.')
    print(`Running ${manager.name} install (normal lifecycle hooks and peer checks)...`)
    await (options.install ?? installDependencies)(root, manager)
    for (const group of groups) {
      for (const field of group.fields.filter(field => field.selected))
        field.result = 'applied; installation completed'
    }
    report(incomplete ? 'Selected updates installed; scan incomplete or some selections conflicted. Review failures.' : 'Selected updates applied; installation completed.')
    print(paint(32, 'Accepted declarations applied; installation completed.', colors))
    if (incomplete)
      print(paint(33, 'Scan incomplete or declarations conflicted; review the failures in dependency-update-report.md.', colors))
    return incomplete ? 1 : 0
  }
  catch (error) {
    for (const group of groups) {
      for (const field of group.fields.filter(field => field.selected))
        field.result = phase === 'review' ? 'not applied: review aborted' : phase === 'application' ? 'application failed; review manifest' : 'applied; installation incomplete'
    }
    const outcome = `${phase === 'review' ? 'ABORTED; no manifest edits applied' : `FAILED during ${phase}; review files before retrying, no automatic rollback`}: ${error.message}`
    report(outcome)
    print(paint(31, outcome, colors))
    return 1
  }
  finally { reader?.close() }
}

export async function runUpdater(root, options = {}) {
  let installed = false
  const status = await runUpdates(root, {
    ...options,
    install: async (directory, manager) => {
      await (options.install ?? installDependencies)(directory, manager)
      installed = true
    },
  })
  const output = options.output ?? process.stdout
  if (status !== 0 || !installed || !(options.interactive ?? (process.stdin.isTTY && output.isTTY)))
    return status

  const script = path.join(root, 'shell/deploy.sh')
  try {
    if (!fs.readFileSync(script, 'utf8').split(/\r?\n/).includes('# check-private-updates-deploy: npm-patch-v1'))
      return status
  }
  catch { return status }

  output.write('\nDependency updates installed. Review the package-manager output above.\nNext: patch bump, existing release checks, git add -A, commit/push and npm publish.\nIncludes all checkout changes. Commit message and npm authentication stay interactive.\n')
  let reader
  let accepted = false
  try {
    const controller = new AbortController()
    const ask = options.askDeploy ?? (async (question) => {
      if (!reader) {
        reader = createInterface({ input: process.stdin, output })
        reader.once('close', () => controller.abort())
      }
      return reader.question(question, { signal: controller.signal })
    })
    while (true) {
      const answer = await ask('Run ./shell/deploy.sh in this mode? [Y/n] ')
      if (answer === null || answer === undefined)
        throw new Error('Input closed.')
      if (/^(?:y|yes)?$/i.test(answer.trim())) {
        accepted = true
        break
      }
      if (/^(?:n|no)$/i.test(answer.trim()))
        break
      output.write('Please answer y or n.\n')
    }
  }
  catch {
    output.write('Deployment handoff canceled; dependency updates remain installed.\n')
    return 1
  }
  finally {
    reader?.close()
    // Give the child exclusive terminal input, especially for the commit message.
    if (reader)
      process.stdin.pause()
  }
  if (!accepted) {
    output.write('Deployment skipped; dependency updates remain installed.\n')
    return 0
  }

  const result = (options.spawn ?? spawnSync)('bash', [script], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, JS_DEPLOY_MODE: 'dependency-patch' },
  })
  const exit = result.status ?? (result.signal ? 128 + (constants.signals[result.signal] ?? 0) : 1)
  if (result.error || exit !== 0) {
    output.write(`deploy.sh did not complete successfully (${result.error?.code ?? result.signal ?? exit}); some release actions may have completed. Review before retrying.\n`)
    return exit || 1
  }
  return 0
}

async function main() {
  try {
    if (process.argv.length === 3 && process.argv[2] === '--help')
      process.stdout.write('Usage: ./shell/check-private-updates.sh\nScan private dependencies, review current -> proposed declarations, then install accepted edits.\nThe adjacent package root is always used. After successful installation, an explicitly opted-in npm deployer may be offered [Y/n].\nThat optional action patches, checks, stages all changes, commits/pushes and publishes; commit-message and npm-auth prompts stay interactive.\nSPA/server deployment is never offered.\n')
    else if (process.argv.length !== 2)
      throw new Error('Unknown arguments; use --help. No updates applied.')
    else
      process.exitCode = await runUpdater(packageRoot)
  }
  catch (error) {
    console.error(`ERROR: ${error.message}`)
    process.exitCode = 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
