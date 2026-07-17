import net from 'net'

export function encodeVarInt(value) {
  const bytes = []
  let v = value >>> 0
  do {
    let temp = v & 0x7f
    v >>>= 7
    if (v !== 0) temp |= 0x80
    bytes.push(temp)
  } while (v !== 0)
  return Buffer.from(bytes)
}

export function decodeVarInt(buf, offset = 0) {
  let value = 0
  let size = 0
  let byte
  do {
    if (offset + size >= buf.length) throw new Error('VarInt out of range')
    byte = buf[offset + size]
    value |= (byte & 0x7f) << (7 * size)
    size += 1
    if (size > 5) throw new Error('VarInt too long')
  } while ((byte & 0x80) !== 0)
  return { value: value >>> 0, size }
}

function withLength(payload) {
  return Buffer.concat([encodeVarInt(payload.length), payload])
}

function encodeString(str) {
  const buf = Buffer.from(str, 'utf-8')
  return Buffer.concat([encodeVarInt(buf.length), buf])
}

export function buildHandshakePacket(host, port, protocol = 767) {
  const payload = Buffer.concat([
    encodeVarInt(0x00),
    encodeVarInt(protocol),
    encodeString(host),
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    encodeVarInt(1)
  ])
  return withLength(payload)
}

export function buildStatusRequestPacket() {
  return withLength(encodeVarInt(0x00))
}

function flattenDescription(description) {
  if (typeof description === 'string') return description
  if (!description || typeof description !== 'object') return ''
  let text = String(description.text || '')
  if (Array.isArray(description.extra)) {
    text += description.extra.map(flattenDescription).join('')
  }
  return text
}

export function parseStatusResponse(json) {
  return {
    online: true,
    players: {
      online: Number(json?.players?.online || 0),
      max: Number(json?.players?.max || 0)
    },
    motd: flattenDescription(json?.description).trim()
  }
}

export function pingServer(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    let buffer = Buffer.alloc(0)
    let settled = false
    const done = (result) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.on('timeout', () => done({ online: false }))
    socket.on('error', () => done({ online: false }))
    socket.on('close', () => done({ online: false }))

    socket.connect(port, host, () => {
      socket.write(buildHandshakePacket(host, port))
      socket.write(buildStatusRequestPacket())
    })

    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      try {
        const { value: pktLen, size: lenSize } = decodeVarInt(buffer, 0)
        if (buffer.length < lenSize + pktLen) return
        let cursor = lenSize
        const idRead = decodeVarInt(buffer, cursor)
        cursor += idRead.size
        const strLen = decodeVarInt(buffer, cursor)
        cursor += strLen.size
        if (buffer.length < cursor + strLen.value) return
        const jsonStr = buffer.slice(cursor, cursor + strLen.value).toString('utf-8')
        done(parseStatusResponse(JSON.parse(jsonStr)))
      } catch {
        // Wait for more data; if the stream is malformed, timeout/error path resolves.
      }
    })
  })
}
