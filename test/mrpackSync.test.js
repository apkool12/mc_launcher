import { describe, it, expect } from 'vitest'
import { sha512Hex, needsDownload, staleModPaths } from '../src/main/mrpackSync.js'

describe('sha512Hex', () => {
  it('hashes buffer', () => {
    expect(sha512Hex(Buffer.from('abc'))).toMatch(/^ddaf35a1/)
  })
})

describe('needsDownload', () => {
  it('true when sha512 mismatches', () => {
    expect(needsDownload('deadbeef', { sha512: 'cafef00d' })).toBe(true)
  })
  it('false when sha512 matches (case-insensitive)', () => {
    expect(needsDownload('CAFEF00D', { sha512: 'cafef00d' })).toBe(false)
  })
  it('true when no local hash', () => {
    expect(needsDownload(null, { sha512: 'cafef00d' })).toBe(true)
  })
})

describe('staleModPaths', () => {
  it('returns removed mod jars only', () => {
    const prev = ['mods/a.jar', 'mods/b.jar', 'config/x.toml']
    const next = ['mods/a.jar']
    expect(staleModPaths(prev, next)).toEqual(['mods/b.jar'])
  })
})
