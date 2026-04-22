import fs from 'fs/promises'
import { createReadStream } from 'fs'
import path from 'path'
import crypto from 'crypto'

const projectRoot = process.cwd()
const sourceDir = process.env.MOD_SOURCE_DIR
  ? path.resolve(projectRoot, process.env.MOD_SOURCE_DIR)
  : path.resolve(projectRoot, 'resources', 'modpack')
const outputPath = process.env.MOD_MANIFEST_OUT
  ? path.resolve(projectRoot, process.env.MOD_MANIFEST_OUT)
  : path.resolve(projectRoot, 'resources', 'modpack-manifest.json')
const baseUrl = process.env.MOD_BASE_URL
const ghOwner = process.env.MOD_GH_OWNER
const ghRepo = process.env.MOD_GH_REPO
const ghTag = process.env.MOD_GH_TAG
const ghFlatten = String(process.env.MOD_GH_FLATTEN || '').toLowerCase() === 'true'
const zipMode = String(process.env.MOD_ZIP_MODE || '').toLowerCase() === 'true'
const zipUrl = process.env.MOD_ZIP_URL
const zipFile = process.env.MOD_ZIP_FILE
const version = process.env.MODPACK_VERSION || new Date().toISOString()

if (!baseUrl && !(ghOwner && ghRepo && ghTag)) {
  console.error('다음 중 하나를 설정해야 합니다:')
  console.error('1) MOD_BASE_URL=https://cdn.example.com/modpack')
  console.error('2) MOD_GH_OWNER, MOD_GH_REPO, MOD_GH_TAG')
  process.exit(1)
}

function toGitHubAssetName(relativePath) {
  return relativePath.replaceAll('/', '__')
}

function buildFileUrl(relativePath, assetName) {
  if (ghOwner && ghRepo && ghTag) {
    return `https://github.com/${ghOwner}/${ghRepo}/releases/download/${ghTag}/${encodeURIComponent(assetName)}`
  }
  return `${baseUrl.replace(/\/$/, '')}/${relativePath}`
}

async function walkFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const files = []

  for (const entry of entries) {
    if (entry.name === '.gitkeep' || entry.name.startsWith('.')) continue
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath)))
    } else if (entry.isFile()) {
      files.push(fullPath)
    }
  }

  return files
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256')
    const stream = createReadStream(filePath)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function main() {
  if (zipMode) {
    if (!zipUrl || !zipFile) {
      throw new Error('zip 모드에서는 MOD_ZIP_URL, MOD_ZIP_FILE 이 필요합니다.')
    }

    const zipPath = path.resolve(projectRoot, zipFile)
    const stats = await fs.stat(zipPath)
    const sha256 = await sha256File(zipPath)
    const manifest = {
      version,
      generatedAt: new Date().toISOString(),
      package: {
        url: zipUrl,
        sha256,
        size: stats.size,
        extractTo: '.'
      }
    }

    await fs.mkdir(path.dirname(outputPath), { recursive: true })
    await fs.writeFile(outputPath, JSON.stringify(manifest, null, 2), 'utf-8')
    console.log(`zip manifest 생성 완료: ${outputPath}`)
    return
  }

  const allFiles = await walkFiles(sourceDir)
  const files = []

  for (const filePath of allFiles) {
    const relative = path.relative(sourceDir, filePath).replace(/\\/g, '/')
    const assetName = ghFlatten || (ghOwner && ghRepo && ghTag) ? toGitHubAssetName(relative) : relative
    const stats = await fs.stat(filePath)
    const sha256 = await sha256File(filePath)
    files.push({
      path: relative,
      assetName,
      url: buildFileUrl(relative, assetName),
      size: stats.size,
      sha256
    })
  }

  const manifest = {
    version,
    generatedAt: new Date().toISOString(),
    files: files.sort((a, b) => a.path.localeCompare(b.path))
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true })
  await fs.writeFile(outputPath, JSON.stringify(manifest, null, 2), 'utf-8')
  console.log(`manifest 생성 완료: ${outputPath}`)
  console.log(`파일 수: ${manifest.files.length}`)
}

main().catch((error) => {
  console.error('manifest 생성 실패:', error)
  process.exit(1)
})
