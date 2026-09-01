import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import test from 'node:test';
import { WebSocketConnection } from '../src/websocket.mjs';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.ended = false;
  }
  setNoDelay() {}
  write(value) { this.writes.push(Buffer.from(value)); return true; }
  end() { this.ended = true; }
}

function maskedText(text, { fin = true, opcode = 1 } = {}) {
  const payload = Buffer.isBuffer(text) ? text : Buffer.from(text);
  assert.ok(payload.length < 126);
  const mask = Buffer.from([0x12, 0x34, 0x56, 0x78]);
  const frame = Buffer.alloc(2 + 4 + payload.length);
  frame[0] = (fin ? 0x80 : 0) | opcode;
  frame[1] = 0x80 | payload.length;
  mask.copy(frame, 2);
  for (let index = 0; index < payload.length; index += 1) frame[6 + index] = payload[index] ^ mask[index % 4];
  return frame;
}

test('minimal WebSocket transport decodes masked browser text and emits unmasked server text', async () => {
  const socket = new FakeSocket();
  const connection = new WebSocketConnection(socket, Buffer.alloc(0), { maxMessageBytes: 1024 });
  const received = once(connection, 'message');
  socket.emit('data', maskedText('{"type":"hello"}'));
  assert.equal((await received)[0], '{"type":"hello"}');
  connection.sendJson({ type: 'ping', nonce: '1' });
  const outbound = socket.writes.at(-1);
  assert.equal(outbound[0], 0x81);
  assert.equal(Boolean(outbound[1] & 0x80), false);
  assert.match(outbound.subarray(2).toString('utf8'), /"ping"/);
});

test('minimal WebSocket transport rejects invalid UTF-8 text', async () => {
  const socket = new FakeSocket();
  const connection = new WebSocketConnection(socket, Buffer.alloc(0), { maxMessageBytes: 1024 });
  const error = once(connection, 'error');
  socket.emit('data', maskedText(Buffer.from([0xc3, 0x28])));
  assert.match((await error)[0].message, /UTF-8/);
  assert.equal(socket.ended, true);
});

test('minimal WebSocket transport rejects unmasked client frames', async () => {
  const socket = new FakeSocket();
  const connection = new WebSocketConnection(socket, Buffer.alloc(0), { maxMessageBytes: 1024 });
  const error = once(connection, 'error');
  socket.emit('data', Buffer.from([0x81, 0x02, 0x7b, 0x7d]));
  assert.match((await error)[0].message, /masked/);
  assert.equal(socket.ended, true);
});

test('malformed bytes received in the HTTP upgrade head close safely', async () => {
  const socket = new FakeSocket();
  const connection = new WebSocketConnection(
    socket,
    Buffer.from([0x81, 0x02, 0x7b, 0x7d]),
    { maxMessageBytes: 1024 },
  );
  const error = once(connection, 'error');
  assert.match((await error)[0].message, /masked/);
  assert.equal(socket.ended, true);
  assert.equal(connection.closed, true);
});
