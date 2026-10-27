import net from 'node:net';

const [mode, pipe] = process.argv.slice(2);
if (!pipe?.startsWith('\\\\.\\pipe\\lume-ipc-probe-')) process.exit(2);

if (mode === 'server') {
  const server = net.createServer((socket) => {
    socket.setTimeout(3000, () => socket.destroy());
    socket.once('data', (data) => {
      socket.end(data.toString() === 'PING' ? 'PONG' : 'BAD');
    });
  });
  server.listen(pipe, () => process.stdout.write('READY\n'));
  server.on('error', () => process.exitCode = 3);
} else if (mode === 'client') {
  const socket = net.connect(pipe);
  let received = false;
  socket.setTimeout(3000, () => socket.destroy(new Error('timeout')));
  socket.on('connect', () => socket.write('PING'));
  socket.once('data', (data) => {
    received = data.toString() === 'PONG';
    if (!received) process.exitCode = 4;
    socket.end();
  });
  socket.on('close', () => { if (!received && !process.exitCode) process.exitCode = 5; });
  socket.on('error', () => process.exitCode = 5);
} else {
  process.exit(2);
}
