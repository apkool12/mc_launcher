import { describe, it, expect } from 'vitest'
import {
  encodeVarInt,
  decodeVarInt,
  buildHandshakePacket,
  parseStatusResponse
} from '../src/main/serverPing.js'

describe('varint', () => {
  it('roundtrips small and multibyte values', () => {
    for (const n of [0, 1, 127, 128, 255, 25565, 2097151]) {
      const buf = encodeVarInt(n)
      expect(decodeVarInt(buf, 0)).toEqual({ value: n, size: buf.length })
    }
  })
})

describe('handshake packet', () => {
  it('is length-prefixed and contains host', () => {
    const pkt = buildHandshakePacket('example.com', 25565, 767)
    const { value: len, size } = decodeVarInt(pkt, 0)
    expect(len).toBe(pkt.length - size)
    expect(pkt.includes(Buffer.from('example.com'))).toBe(true)
  })
})

describe('parseStatusResponse', () => {
  it('extracts players and motd', () => {
    const r = parseStatusResponse({
      players: { online: 3, max: 20 },
      description: { text: 'Hello' }
    })
    expect(r).toEqual({ online: true, players: { online: 3, max: 20 }, motd: 'Hello' })
  })

  it('flattens description string form', () => {
    const r = parseStatusResponse({ players: { online: 0, max: 10 }, description: 'Plain' })
    expect(r.motd).toBe('Plain')
  })
})
