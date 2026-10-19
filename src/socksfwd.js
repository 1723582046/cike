'use strict';
/**
 * SOCKS5 authenticated proxy forwarder.
 *
 * Chromium does not support SOCKS5 with username/password authentication
 * via --proxy-server. This module runs a local HTTP proxy on 127.0.0.1
 * that forwards CONNECT requests through an upstream SOCKS5 proxy
 * (with optional username/password auth).
 *
 * Usage:
 *   const fwd = await SocksForwarder.start({
 *     host: '1.2.3.4', port: 1080, username: 'u', password: 'p',
 *   });
 *   // fwd.port -> point Chromium's --proxy-server at http://127.0.0.1:<port>
 *   await fwd.stop();
 */
const net = require('net');

class SocksForwarder {
  constructor(opts) {
    this.upstream = {
      host: opts.host,
      port: opts.port,
      username: opts.username || '',
      password: opts.password || '',
    };
    this.server = null;
    this.port = 0;
  }

  static async start(opts) {
    const f = new SocksForwarder(opts);
    await f._listen();
    return f;
  }

  _listen() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((client) => this._handleClient(client));
      this.server.on('error', reject);
      this.server.listen(0, '127.0.0.1', () => {
        this.port = this.server.address().port;
        resolve();
      });
    });
  }

  async stop() {
    if (this.server) {
      await new Promise((r) => this.server.close(r));
      this.server = null;
    }
  }

  _handleClient(client) {
    let buf = Buffer.alloc(0);
    const onData = async (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      // Wait for full HTTP headers
      const idx = buf.indexOf('\r\n\r\n');
      if (idx < 0) return;
      client.removeListener('data', onData);
      const header = buf.slice(0, idx).toString('latin1');
      const line = header.split('\r\n')[0];
      const m = line.match(/^CONNECT\s+([^:\s]+):(\d+)\s+HTTP\//i);
      if (!m) {
        client.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        return;
      }
      const targetHost = m[1];
      const targetPort = parseInt(m[2], 10);
      try {
        const upstream = await this._socksConnect(targetHost, targetPort);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        // Relay any pipelined data, then pipe both ways
        const rest = buf.slice(idx + 4);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
        client.on('error', () => upstream.destroy());
        upstream.on('error', () => client.destroy());
      } catch (err) {
        client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      }
    };
    client.on('data', onData);
    client.on('error', () => {});
    // Timeout if client never sends a valid CONNECT
    client.setTimeout(15000, () => client.destroy());
  }

  /**
   * Open a TCP connection to targetHost:targetPort via the upstream SOCKS5.
   * Returns a connected net.Socket.
   */
  _socksConnect(targetHost, targetPort) {
    const { host, port, username, password } = this.upstream;
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ host, port });
      const fail = (msg) => {
        sock.destroy();
        reject(new Error(msg));
      };
      sock.setTimeout(15000, () => fail('socks5 connect timeout'));
      sock.on('error', (e) => fail('socks5: ' + e.message));

      let stage = 0;
      let buf = Buffer.alloc(0);

      const sendGreeting = () => {
        // VER=5, NMETHODS=1, METHOD=2 (username/password) or 0 (no auth)
        if (username) {
          sock.write(Buffer.from([0x05, 0x01, 0x02]));
        } else {
          sock.write(Buffer.from([0x05, 0x01, 0x00]));
        }
      };

      const sendAuth = () => {
        const u = Buffer.from(username, 'utf8');
        const p = Buffer.from(password, 'utf8');
        const b = Buffer.alloc(3 + u.length + p.length);
        b[0] = 0x01; // auth version
        b[1] = u.length;
        u.copy(b, 2);
        b[2 + u.length] = p.length;
        p.copy(b, 3 + u.length);
        sock.write(b);
      };

      const sendConnect = () => {
        // VER=5, CMD=1 (CONNECT), RSV=0
        const hostBuf = Buffer.from(targetHost, 'utf8');
        // Use ATYP=3 (domain name) — the proxy resolves DNS
        const b = Buffer.alloc(7 + hostBuf.length);
        b[0] = 0x05;
        b[1] = 0x01;
        b[2] = 0x00;
        b[3] = 0x03; // domain
        b[4] = hostBuf.length;
        hostBuf.copy(b, 5);
        b.writeUInt16BE(targetPort, 5 + hostBuf.length);
        sock.write(b);
      };

      sock.on('connect', sendGreeting);

      sock.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        try {
          if (stage === 0) {
            // Expect: VER=5, METHOD
            if (buf.length < 2) return;
            if (buf[0] !== 0x05) return fail('socks5: bad version in greeting');
            const method = buf[1];
            buf = buf.slice(2);
            if (method === 0x02) {
              if (!username) return fail('socks5: proxy requires auth');
              stage = 1;
              sendAuth();
            } else if (method === 0x00) {
              stage = 2;
              sendConnect();
            } else {
              return fail('socks5: no acceptable auth method');
            }
          } else if (stage === 1) {
            // Expect: auth VER=1, STATUS
            if (buf.length < 2) return;
            if (buf[0] !== 0x01 || buf[1] !== 0x00) {
              return fail('socks5: authentication failed');
            }
            buf = buf.slice(2);
            stage = 2;
            sendConnect();
          } else if (stage === 2) {
            // Expect: VER=5, REP=0, RSV, ATYP, BND.ADDR, BND.PORT
            if (buf.length < 4) return;
            if (buf[0] !== 0x05) return fail('socks5: bad version in reply');
            if (buf[1] !== 0x00) return fail('socks5: connect failed, rep=' + buf[1]);
            const atyp = buf[3];
            let headerLen;
            if (atyp === 0x01) headerLen = 10;
            else if (atyp === 0x03) {
              if (buf.length < 5) return;
              headerLen = 7 + buf[4];
            } else if (atyp === 0x04) headerLen = 22;
            else return fail('socks5: unknown atyp');
            if (buf.length < headerLen) return;
            // Connected! Remove our handlers, pass socket to caller.
            const rest = buf.slice(headerLen);
            sock.removeAllListeners('data');
            sock.removeAllListeners('error');
            sock.setTimeout(0);
            sock.on('error', () => {});
            if (rest.length) sock.unshift(rest);
            resolve(sock);
          }
        } catch (e) {
          fail('socks5: ' + e.message);
        }
      });
    });
  }
}

module.exports = { SocksForwarder };
