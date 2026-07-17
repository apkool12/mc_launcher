import crypto from 'crypto'

export function sha512Hex(buffer) {
  return crypto.createHash('sha512').update(buffer).digest('hex')
}

export function needsDownload(localHashHex, file) {
  if (!file?.sha512) return !localHashHex
  if (!localHashHex) return true
  return localHashHex.toLowerCase() !== String(file.sha512).toLowerCase()
}

export function staleModPaths(previousPaths, nextPaths) {
  const next = new Set(nextPaths)
  return previousPaths.filter(
    (p) => p.startsWith('mods/') && p.toLowerCase().endsWith('.jar') && !next.has(p)
  )
}
