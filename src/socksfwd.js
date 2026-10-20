'use strict';
const http = require('http');
const { connectSocks } = require('./proxyroute');

// Chromium connects to this loopback HTTP proxy. Both plain HTTP and HTTPS
// CONNECT use the destination SOCKS5, optionally reached via a system proxy.
class SocksForwarder {
  constructor(opts) {
    this.upstream = opts;
    this.sockets = new Set();
    this.port = 0;
  }
  track(socket) {
    this.sockets.add(socket);
    socket.once('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    return socket;
  }
  async connect(host, port) {
    const socket = this.track(await connectSocks(this.upstream, host, port, this.upstream.systemProxy));
    if (this.stopped) { socket.destroy(); throw new Error('代理已关闭'); }
    return socket;
  }
  static async start(opts) {
    const f = new SocksForwarder(opts);
    f.server = http.createServer((req, res) => f.request(req, res));
    f.server.on('connection', socket => f.track(socket));
    f.server.on('connect', (req, client, head) => f.tunnel(req, client, head));
    f.server.headersTimeout = 15000;
    await new Promise((resolve, reject) => {
      f.server.once('error', reject);
      f.server.listen(0, '127.0.0.1', resolve);
    });
    f.port = f.server.address().port;
    return f;
  }
  async tunnel(req, client, head) {
    try {
      const target = new URL(`http://${req.url}`);
      const upstream = await this.connect(target.hostname.replace(/^\[|\]$/g, ''), Number(target.port) || 80);
      if (client.destroyed) { upstream.destroy(); return; }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.on('data', chunk => upstream.write(chunk));
      upstream.on('data', chunk => client.write(chunk));
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
    } catch { client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); }
  }
  async request(req, res) {
    let socket;
    try {
      const target = new URL(req.url);
      if (target.protocol !== 'http:') throw new Error('unsupported protocol');
      socket = await this.connect(target.hostname.replace(/^\[|\]$/g, ''), Number(target.port) || 80);
      if (req.destroyed || res.destroyed) { socket.destroy(); return; }
      const headers = Object.entries({ ...req.headers, host: target.host, connection: 'close' })
        .filter(([name]) => !['proxy-authorization', 'proxy-connection'].includes(name));
      socket.write(`${req.method} ${target.pathname}${target.search} HTTP/1.1\r\n${headers.map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n\r\n`);
      req.on('data', chunk => socket.write(chunk));
      const chunks = [];
      let header = Buffer.alloc(0);
      const onData = chunk => {
        chunks.push(chunk);
        header = Buffer.concat(chunks);
        const split = header.indexOf('\r\n\r\n');
        if (split < 0) return;
        socket.off('data', onData);
        const head = header.subarray(0, split).toString('latin1');
        const status = Number(head.split('\r\n', 1)[0].split(' ')[1]);
        const fields = Object.fromEntries(head.split('\r\n').slice(1).map(line => {
          const index = line.indexOf(':');
          return [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()];
        }));
        res.writeHead(status, fields.location ? { Location: fields.location } : undefined);
        const body = header.subarray(split + 4);
        if (body.length) res.write(body);
        socket.pipe(res);
      };
      socket.on('data', onData);
      res.once('close', () => socket.destroy());
    } catch { socket?.destroy(); res.writeHead(502); res.end(); }
  }
  async stop() {
    this.stopped = true;
    for (const socket of this.sockets) socket.destroy();
    if (this.server) await new Promise(resolve => this.server.close(resolve));
    this.server = null;
  }
}
module.exports = { SocksForwarder };
