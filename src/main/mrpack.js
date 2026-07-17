const LOADER_KEYS = {
  'fabric-loader': 'fabric',
  'quilt-loader': 'quilt',
  forge: 'forge',
  neoforge: 'neoforge'
}

export function parseMrpackIndex(index, side = 'client') {
  const deps = index?.dependencies || {}
  let loader = null
  let loaderVersion = null
  for (const [key, name] of Object.entries(LOADER_KEYS)) {
    if (deps[key]) {
      loader = name
      loaderVersion = String(deps[key])
      break
    }
  }

  const files = (Array.isArray(index?.files) ? index.files : [])
    .filter((file) => file?.path && Array.isArray(file.downloads) && file.downloads.length > 0)
    .filter((file) => (file.env?.[side] || 'required') !== 'unsupported')
    .map((file) => ({
      path: String(file.path),
      downloads: file.downloads.map(String),
      sha512: file.hashes?.sha512 ? String(file.hashes.sha512) : null,
      sha1: file.hashes?.sha1 ? String(file.hashes.sha1) : null,
      size: Number(file.fileSize || 0)
    }))

  return {
    minecraft: String(deps.minecraft || ''),
    loader,
    loaderVersion,
    files
  }
}
