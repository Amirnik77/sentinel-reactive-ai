// Local unauthenticated forwarding proxy -> hatch egress proxy (adds auth preemptively).
// Chrome cannot complete CONNECT against the egress proxy directly; curl-style
// preemptive Proxy-Authorization works, so this shim translates between the two.
import http from 'node:http';
import net from 'node:net';

const upstream = new URL(process.env.https_proxy || process.env.HTTPS_PROXY);
const UP_HOST = '198.19.0.1';
const UP_PORT = Number(upstream.port || 3128);
const AUTH =
  'Basic ' +
  Buffer.from(`${decodeURIComponent(upstream.username)}:${decodeURIComponent(upstream.password)}`).toString('base64');
const LISTEN = Number(process.argv[2] || 18080);

const server = http.createServer((req, res) => {
  // Plain HTTP forwarding (absolute-URI form).
  const target = new URL(req.url);
  const headers = { ...req.headers, 'proxy-authorization': AUTH };
  delete headers['proxy-connection'];
  const preq = http.request(
    { host: UP_HOST, port: UP_PORT, path: req.url, method: req.method, headers },
    (pres) => {
      res.writeHead(pres.statusCode, pres.headers);
      pres.pipe(res);
    }
  );
  preq.on('error', () => { try { res.writeHead(502); res.end(); } catch {} });
  req.pipe(preq);
});

server.on('connect', (req, clientSocket, head) => {
  const upstreamSocket = net.connect(UP_PORT, UP_HOST, () => {
    upstreamSocket.write(
      `CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${AUTH}\r\nProxy-Connection: Keep-Alive\r\n\r\n`
    );
  });
  let buf = Buffer.alloc(0);
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString();
    upstreamSocket.removeListener('data', onData);
    if (statusLine.includes(' 200')) {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      const rest = buf.slice(idx + 4);
      if (rest.length) clientSocket.write(rest);
      if (head && head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(clientSocket);
      clientSocket.pipe(upstreamSocket);
    } else {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
      upstreamSocket.destroy();
    }
  };
  upstreamSocket.on('data', onData);
  upstreamSocket.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstreamSocket.destroy());
});

server.listen(LISTEN, '127.0.0.1', () => {
  console.log(`local proxy listening on 127.0.0.1:${LISTEN}`);
});
