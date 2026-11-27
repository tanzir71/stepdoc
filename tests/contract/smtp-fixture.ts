import { createServer, type Socket } from 'node:net'

// An in-memory loopback SMTP boundary. No mailbox, external server, or code log.
export async function smtpFixture() {
  const messages: { to: string; body: string }[] = []
  const sockets = new Set<Socket>()
  let fail = false
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.setEncoding('utf8')
    let input = '',
      body: string[] | null = null,
      recipient = ''
    socket.write('220 fixture ESMTP\r\n')
    socket.on('data', (data: string) => {
      input += data
      while (input.includes('\r\n')) {
        const end = input.indexOf('\r\n'),
          line = input.slice(0, end)
        input = input.slice(end + 2)
        if (body !== null) {
          if (line === '.') {
            if (fail) {
              fail = false
              socket.write('451 delivery unavailable\r\n')
            } else {
              messages.push({ to: recipient, body: body.join('\n') })
              socket.write('250 accepted\r\n')
            }
            body = null
          } else body.push(line.startsWith('..') ? line.slice(1) : line)
        } else if (/^(?:EHLO|HELO) /i.test(line))
          socket.write('250-fixture\r\n250 8BITMIME\r\n')
        else if (/^MAIL FROM:/i.test(line))
          socket.write('250 sender accepted\r\n')
        else if (/^RCPT TO:/i.test(line)) {
          recipient = line.match(/<([^>]+)>/)?.[1] ?? ''
          socket.write('250 recipient accepted\r\n')
        } else if (line === 'DATA') {
          body = []
          socket.write('354 send message\r\n')
        } else if (line === 'QUIT') {
          socket.end('221 closing\r\n')
        } else if (line === 'RSET' || line === 'NOOP')
          socket.write('250 ok\r\n')
        else socket.write('502 unsupported command\r\n')
      }
    })
    socket.on('error', () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('Missing SMTP fixture address')
  return {
    port: address.port,
    count: () => messages.length,
    code: (email: string) => {
      const code = messages
        .slice()
        .reverse()
        .find((message) => message.to === email)
        ?.body.match(/code is: ([0-9]{6})/)?.[1]
      if (!code)
        throw new Error('No sign-in code delivered to the SMTP boundary')
      return code
    },
    failNext: () => {
      fail = true
    },
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    },
  }
}
