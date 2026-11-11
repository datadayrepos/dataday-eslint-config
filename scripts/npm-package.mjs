// Local packaging only by default. Publishing requires the explicit publish action.
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const buildDirectory = 'dist'
const fields = ['name', 'version', 'type', 'license', 'main', 'module', 'types', 'typings', 'typesVersions', 'exports', 'imports', 'browser', 'sideEffects', 'bin', 'dependencies', 'optionalDependencies', 'peerDependencies', 'peerDependenciesMeta', 'engines', 'os', 'cpu', 'libc', 'publishConfig', 'unpkg', 'jsdelivr']
const legal = name => /^(?:license|licence|notice|copying|copyright)(?:\.(?:md|txt))?$/i.test(name)
const forbidden = name => name.split('/').some(part => /^(?:docs(?:_agent|_web)?|plans?|research|tests?|testing|__tests__|fixtures|playground|node_modules|\.git|\.github|\.agents|\.claude|\.codex|\.vite)$/i.test(part)) || (/\.(?:md|markdown|mdx|map|tsbuildinfo)$/i.test(name) && !legal(path.posix.basename(name))) || /\.(?:test|spec)\.[^/]+$/i.test(name) || /(?:^|\/)(?:readme(?:\.[^/]*)?|agents\.md|claude\.md|gemini\.md|\.env(?:\.[^/]*)?|\.npmrc(?:\.[^/]*)?)$/i.test(name)
const artifact = name => /\.(?:[cm]?js|d\.[cm]?ts|css|json|wasm|svg|png|jpe?g|webp|gif|ico|woff2?|ttf|otf)$/i.test(name)
const digest = bytes => crypto.createHash('sha512').update(bytes).digest('hex')
function fail(message) {
  throw new Error(message)
}

function run(command, args, cwd = root, capture = false) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', maxBuffer: 64 * 1024 * 1024 })
  if (result.error || result.status !== 0)
    fail(`${command} failed (${result.status ?? result.error?.code}); no publication performed.`)
  return result.stdout
}

export function publicManifest(pkg) {
  assert(pkg.name && pkg.version && pkg.private !== true, 'Expected a publishable named/versioned package.')
  assert(!pkg.bundleDependencies && !pkg.bundledDependencies, 'Bundled dependencies require a separate reviewed profile.')
  const result = Object.fromEntries(fields.filter(key => pkg[key] !== undefined).map(key => [key, pkg[key]]))
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const spec of Object.values(result[section] || {})) assert(!/^(?:workspace|file|link|catalog):/.test(spec), 'Resolve local dependency protocols through the authoritative publisher first.')
  }
  return result
}

function sourcePackage() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
}

function outputRoots(pkg) {
  assert(Array.isArray(pkg.files) && pkg.files.length, 'An explicit files allowlist is required.')
  const roots = pkg.files.filter(name => name !== 'package.json' && !legal(name) && !forbidden(name)).map(name => name.replace(/^\.\//, '').replace(/\/(?:\*\*)?\/?$/, ''))
  for (const name of roots) assert(name && !path.isAbsolute(name) && !name.split('/').includes('..') && !/[?*[!]/.test(name) && /^(?:dist|lib|bin)(?:\/|$)|^tailwind\.preset\.(?:cjs|d\.ts)$/.test(name), `Unreviewed output root: ${name}`)
  return [...new Set(roots)]
}

function selected(pkg) {
  const files = new Set()
  function visit(name) {
    const absolute = path.join(root, name)
    const stat = fs.lstatSync(absolute)
    assert(!stat.isSymbolicLink(), `Symlink is not a publication input: ${name}`)
    assert(!name.split('/').includes('node_modules'), `Bundled node_modules cannot be silently omitted by npm: ${name}; review the owning build output.`)
    if (forbidden(name))
      return
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absolute).sort()) visit(`${name}/${child}`)
    }
    else {
      assert(stat.isFile() && (artifact(name) || legal(path.posix.basename(name))), `Unreviewed publication file type: ${name}`)
      files.add(name)
    }
  }
  for (const name of outputRoots(pkg)) {
    assert(fs.existsSync(path.join(root, name)), `Missing output root: ${name}`)
    visit(name)
  }
  for (const name of fs.readdirSync(root).filter(legal)) {
    assert(fs.lstatSync(path.join(root, name)).isFile(), `Legal notice must be a regular file: ${name}`)
    files.add(name)
  }
  assert(files.size, 'No runtime artifacts selected.')
  return [...files].sort()
}

function checkContent(name, bytes) {
  if (!/\.(?:[cm]?js|[cm]?ts|css|json)$/i.test(name))
    return
  const text = bytes.toString('utf8')
  assert(!/^\s*\/\/[#@]\s*sourceMappingURL=|\/\*[#@]\s*sourceMappingURL=/m.test(text), `Source map reference in ${name}`)
  // PEM serializers contain public header constants; reject complete key material, not labels.
  const normalized = text.replace(/\\+(?:r\\+n|[rn])/g, '\n')
  assert(!/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----\s*[A-Za-z0-9+/=\s]{64,}-----END (?:[A-Z ]+ )?PRIVATE KEY-----/.test(normalized) && !/\bnpm_[A-Za-z0-9]{30,}\b/.test(text), `Credential-shaped content in ${name}; content withheld.`)
}

function checkEntries(pkg, files) {
  function target(value) {
    if (Array.isArray(value))
      return value.forEach(target)
    if (value && typeof value === 'object')
      return Object.values(value).forEach(target)
    if (typeof value !== 'string' || !value.startsWith('./'))
      return
    const name = value.slice(2)
    if (name.endsWith('/')) {
      assert(files.some(file => file.startsWith(name)), `Missing package directory: ${name}`)
    }
    else if (name.includes('*')) {
      const pattern = new RegExp(`^${name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
      assert(files.some(file => pattern.test(file)), `Missing exported pattern: ${name}`)
    }
    else {
      assert(files.includes(name), `Missing package entry: ${name}`)
    }
  }
  for (const key of ['main', 'module', 'types', 'typings', 'unpkg', 'jsdelivr']) {
    if (pkg[key])
      target(`./${pkg[key].replace(/^\.\//, '')}`)
  }
  for (const key of ['exports', 'imports', 'browser', 'bin', 'typesVersions']) target(pkg[key])
  if (typeof pkg.browser === 'string')
    target(`./${pkg.browser.replace(/^\.\//, '')}`)
  if (typeof pkg.bin === 'string') {
    target(`./${pkg.bin.replace(/^\.\//, '')}`)
  }
  else {
    for (const name of Object.values(pkg.bin || {})) target(`./${name.replace(/^\.\//, '')}`)
  }
  const typeTargets = (value) => {
    if (Array.isArray(value))
      return value.forEach(typeTargets)
    if (value && typeof value === 'object')
      return Object.values(value).forEach(typeTargets)
    if (typeof value === 'string')
      target(`./${value.replace(/^\.\//, '')}`)
  }
  typeTargets(pkg.typesVersions)
}

function inputs(pkg) {
  const files = selected(pkg)
  const manifest = publicManifest(pkg)
  manifest.files = files
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const hashes = { 'package.json': digest(bytes) }
  for (const name of files) {
    const value = fs.readFileSync(path.join(root, name))
    checkContent(name, value)
    hashes[name] = digest(value)
  }
  checkEntries(manifest, Object.keys(hashes))
  return { files, manifest, bytes, hashes }
}

// Inspect bytes from the archive, not only npm's earlier dry-run listing.
function inspect(archive, hashes) {
  const entries = run('tar', ['-tzf', archive], root, true).trim().split('\n')
  const names = entries.filter(name => !name.endsWith('/'))
  const expected = Object.keys(hashes).map(name => `package/${name}`).sort()
  const directories = new Set(['package'])
  for (const name of expected) {
    for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent))
      directories.add(parent)
  }
  assert.deepEqual(names.slice().sort(), expected, 'Archive entries differ from the reviewed file set.')
  assert(entries.every(name => !name.includes('..') && !name.startsWith('/') && (expected.includes(name) || directories.has(name.replace(/\/+$/, '')))), 'Unsafe archive entry.')
  assert(run('tar', ['-tvzf', archive], root, true).split('\n').filter(Boolean).every(line => line[0] === '-' || line[0] === 'd'), 'Archive contains non-regular entries.')
  const extracted = fs.mkdtempSync(path.join(path.dirname(archive), 'inspect-'))
  try {
    run('tar', ['-xzf', archive, '-C', extracted], root, true)
    for (const entry of names) {
      const name = entry.slice(8)
      assert(!forbidden(name) || (!name.includes('/') && legal(name)), `Forbidden archive entry: ${name}`)
      const file = path.join(extracted, entry)
      assert(fs.lstatSync(file).isFile() && digest(fs.readFileSync(file)) === hashes[name], `Archive bytes differ: ${name}`)
    }
  }
  finally {
    fs.rmSync(extracted, { recursive: true, force: true })
  }
}
function location(args) {
  const index = args.indexOf('--out')
  const out = path.resolve(index < 0 ? path.join(root, '.npm-package') : args[index + 1] || fail('--out needs a directory'))
  assert(out !== path.parse(out).root && out !== root && !root.startsWith(out + path.sep), 'Output must not be a filesystem root, repository or its parent.')
  if (out.startsWith(root + path.sep))
    assert(out === path.join(root, '.npm-package'), 'In-checkout output is restricted to .npm-package.')
  fs.mkdirSync(out, { recursive: true, mode: 0o700 })
  assert(fs.realpathSync(out) === out, 'Output must use its canonical path, without symlinks.')
  return out
}

function build(pkg, out) {
  const roots = outputRoots(pkg)
  const buildScript = pkg.scripts?.['pack:build'] ? 'pack:build' : 'build'
  if (pkg.scripts?.build || pkg.scripts?.['pack:build']) {
    // Only generated dist output is cleaned; never remove tracked/source runtime files.
    assert(roots.some(name => name === buildDirectory), 'The reviewed build output root is required.')
    assert(!run('git', ['ls-files', '--', buildDirectory], root, true).trim(), 'Refusing to clean tracked dist files.')
    if (fs.existsSync(path.join(root, buildDirectory)))
      assert(!fs.lstatSync(path.join(root, buildDirectory)).isSymbolicLink(), 'Refusing to clean symlinked dist.')
    fs.rmSync(path.join(root, buildDirectory), { recursive: true, force: true })
    if (pkg.packageManager?.startsWith('pnpm@')) {
      // Nested pnpm calls must use Corepack too, not an unrelated global version.
      const executable = fs.realpathSync(run('which', ['corepack'], root, true).trim())
      const shims = path.resolve(path.dirname(executable), '../shims')
      assert(fs.existsSync(path.join(shims, 'pnpm')), 'Corepack pnpm shims are required for the declared toolchain.')
      const previous = process.env.PATH
      // Expose only pnpm shims; Corepack's npm shim rejects legacy npm substeps.
      const tools = fs.mkdtempSync(path.join(out, 'toolchain-'))
      const quote = value => `'${value.replaceAll("'", "'\\''")}'`
      for (const command of ['pnpm', 'pnpx'])
        fs.writeFileSync(path.join(tools, command), `#!/bin/sh\nexec ${quote(executable)} ${command} "$@"\n`, { mode: 0o700 })
      process.env.PATH = `${tools}${path.delimiter}${previous || ''}`
      try {
        run('corepack', ['pnpm', 'run', buildScript])
      }
      finally {
        if (previous === undefined)
          delete process.env.PATH
        else
          process.env.PATH = previous
        fs.rmSync(tools, { recursive: true, force: true })
      }
    }
    else {
      run('npm', ['run', buildScript])
    }
  }
  else {
    assert(roots.every(name => name === 'lib' || name === 'bin'), 'Source-only profile must declare lib/bin.')
    for (const name of ['check', 'test']) {
      assert(pkg.scripts?.[name], `Missing source-only ${name} check.`)
      run('npm', ['run', name])
    }
  }
  if (pkg.scripts?.['pack:verify'])
    run('npm', ['run', 'pack:verify'])
}

export function main(args) {
  const action = args[0] || 'pack'
  if (action === 'guard')
    fail('Source-root publication is blocked. Run npm run pack:release, then npm run pub for the verified archive.')
  assert(['pack', 'check', 'publish'].includes(action), 'Expected pack, check or publish.')
  const pkg = sourcePackage()
  if (action === 'check') {
    inputs(pkg)
    console.log('Package artifact inputs: PASS')
    return
  }
  const out = location(args)
  const receipt = path.join(out, 'verified.json')
  if (action === 'pack') {
    fs.rmSync(receipt, { force: true })
    build(pkg, out)
    const data = inputs(sourcePackage())
    const stage = fs.mkdtempSync(path.join(out, 'stage-'))
    try {
      for (const name of data.files) {
        const target = path.join(stage, name)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(path.join(root, name), target)
        fs.chmodSync(target, fs.statSync(path.join(root, name)).mode & 0o777)
      }
      fs.writeFileSync(path.join(stage, 'package.json'), data.bytes)
      const result = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--offline', '--pack-destination', out], stage, true))[0]
      assert(path.basename(result.filename) === result.filename, 'Invalid npm archive filename.')
      const archive = path.join(out, result.filename)
      inspect(archive, data.hashes)
      const revision = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
      const sourceRevision = revision.status === 0 ? revision.stdout.trim() : null
      const toolchain = { node: process.version, npm: run('npm', ['--version'], root, true).trim(), packageManager: pkg.packageManager || null }
      fs.writeFileSync(receipt, `${JSON.stringify({ name: pkg.name, version: pkg.version, sourceRevision, toolchain, archive: result.filename, sha512: digest(fs.readFileSync(archive)), hashes: data.hashes }, null, 2)}\n`, { mode: 0o600 })
      console.log(`Verified local npm archive: ${archive}\nNo publication performed.`)
    }
    finally {
      fs.rmSync(stage, { recursive: true, force: true })
    }
  }
  else {
    assert(run('git', ['branch', '--show-current'], root, true).trim() === 'main', 'Publication requires main; no automatic branch changes.')
    const verified = JSON.parse(fs.readFileSync(receipt, 'utf8'))
    assert(path.basename(verified.archive) === verified.archive, 'Invalid receipt archive path.')
    const archive = path.join(out, verified.archive)
    assert(verified.name === pkg.name && verified.version === pkg.version && digest(fs.readFileSync(archive)) === verified.sha512, 'Verified archive is missing or changed. Repack first.')
    assert.deepEqual(inputs(pkg).hashes, verified.hashes, 'Package inputs changed since verification. Repack first.')
    inspect(archive, verified.hashes)
    const flags = args.slice(1).filter((_, index, rest) => rest[index - 1] !== '--out' && rest[index] !== '--out')
    assert(flags.every(flag => /^--(?:access|tag|registry|auth-type)=/.test(flag)), 'Only explicit existing publication settings are accepted.')
    assert(flags.filter(flag => flag.startsWith('--access=')).every(flag => /^--access=(?:public|restricted)$/.test(flag)), 'npm access must be an explicitly reviewed public/restricted setting.')
    run('npm', ['publish', archive, ...flags])
  }
}

export { inputs as publicationInputs }

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2))
  }
  catch (error) {
    console.error(`npm package: ${error.message}`)
    process.exitCode = 1
  }
}
