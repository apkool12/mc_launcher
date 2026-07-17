import { describe, it, expect } from 'vitest'
import { parseMrpackIndex } from '../src/main/mrpack.js'

const sample = {
  formatVersion: 1,
  dependencies: { minecraft: '1.21.1', 'fabric-loader': '0.16.9' },
  files: [
    {
      path: 'mods/cobblemon.jar',
      hashes: { sha512: 'aaa', sha1: 'bbb' },
      downloads: ['https://cdn.modrinth.com/x.jar'],
      fileSize: 10,
      env: { client: 'required', server: 'required' }
    },
    {
      path: 'mods/iris.jar',
      hashes: { sha512: 'ccc', sha1: 'ddd' },
      downloads: ['https://cdn.modrinth.com/iris.jar'],
      fileSize: 20,
      env: { client: 'required', server: 'unsupported' }
    }
  ]
}

describe('parseMrpackIndex', () => {
  it('reads loader and minecraft version', () => {
    const r = parseMrpackIndex(sample, 'client')
    expect(r.minecraft).toBe('1.21.1')
    expect(r.loader).toBe('fabric')
    expect(r.loaderVersion).toBe('0.16.9')
  })

  it('includes client files', () => {
    const r = parseMrpackIndex(sample, 'client')
    expect(r.files.map((f) => f.path)).toEqual(['mods/cobblemon.jar', 'mods/iris.jar'])
    expect(r.files[0].sha512).toBe('aaa')
    expect(r.files[0].downloads[0]).toBe('https://cdn.modrinth.com/x.jar')
  })

  it('excludes server-unsupported files on server side', () => {
    const r = parseMrpackIndex(sample, 'server')
    expect(r.files.map((f) => f.path)).toEqual(['mods/cobblemon.jar'])
  })
})
