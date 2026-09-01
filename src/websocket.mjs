import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function protocolError(message) {
  const error = new Error(message);
  error.code = 'WEBSOCKET_PROTOCOL_ERROR';
  return error;
}

function decodeUtf8(payload) {
  try {
    return UTF8_DECODER.decode(payload);
  } catch {
    throw protocolError('Text frame contains invalid UTF-8');
  }
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.from([0x80 | opcode, body.length]);
  } else if (body.length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  return Buffer.concat([header, body]);
}

export class WebSocketConnection extends EventEmitter {
  constructor(socket, head = Buffer.alloc(0), options = {}) {
    super();
    this.socket = socket;
    this.maxMessageBytes = options.maxMessageBytes ?? 1024 * 1024;
    this.buffer = Buffer.from(head);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
    this.closed = false;

    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.parseSafely();
    });
    socket.on('error', (error) => this.emit('error', error));
    socket.on('close', () => {
      if (this.closed) return;
      this.closed = true;
      this.emit('close', 1006, 'socket closed');
    });
    socket.setNoDelay(true);
    if (this.buffer.length) queueMicrotask(() => this.parseSafely());
  }

  parseSafely() {
    if (this.closed) return;
    try {
      this.parse();
    } catch (error) {
      this.emit('error', error);
      this.close(1002, 'protocol error');
    }
  }

  parse() {
    while (this.buffer.length >= 2 && !this.closed) {
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = Boolean(first & 0x80);
      const rsv = first & 0x70;
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;
      if (rsv !== 0) throw protocolError('RSV bits are not supported');
      if (!masked) throw protocolError('Client frames must be masked');
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const large = this.buffer.readBigUInt64BE(2);
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) throw protocolError('Frame is too large');
        length = Number(large);
        offset = 10;
      }
      if (opcode >= 0x8 && (!fin || length > 125)) throw protocolError('Invalid control frame');
      if (length > this.maxMessageBytes) throw protocolError('Frame exceeds configured limit');
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      this.buffer = this.buffer.subarray(offset + 4 + length);
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      this.handleFrame(opcode, fin, payload);
    }
  }

  handleFrame(opcode, fin, payload) {
    if (opcode === 0x8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
      const reason = payload.length > 2 ? decodeUtf8(payload.subarray(2)) : '';
      if (!this.closed) this.socket.write(encodeFrame(0x8, payload.subarray(0, 125)));
      this.closed = true;
      this.socket.end();
      this.emit('close', code, reason);
      return;
    }
    if (opcode === 0x9) {
      this.socket.write(encodeFrame(0xA, payload));
      this.emit('ping', payload);
      return;
    }
    if (opcode === 0xA) {
      this.emit('pong', payload);
      return;
    }
    if (![0x0, 0x1].includes(opcode)) throw protocolError('Only text messages are supported');
    if (opcode === 0x0 && this.fragmentOpcode === null) throw protocolError('Unexpected continuation frame');
    if (opcode === 0x1 && this.fragmentOpcode !== null) throw protocolError('Previous fragmented message is incomplete');
    if (opcode === 0x1) this.fragmentOpcode = opcode;
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxMessageBytes) throw protocolError('Message exceeds configured limit');
    if (!fin) return;
    const message = decodeUtf8(Buffer.concat(this.fragments, this.fragmentBytes));
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
    this.emit('message', message);
  }

  sendText(text) {
    if (this.closed) throw new Error('WebSocket is closed');
    const payload = Buffer.from(String(text));
    if (payload.length > this.maxMessageBytes) throw new Error('Outbound message exceeds configured limit');
    this.socket.write(encodeFrame(0x1, payload));
  }

  sendJson(value) {
    this.sendText(JSON.stringify(value));
  }

  ping(value = '') {
    if (!this.closed) this.socket.write(encodeFrame(0x9, Buffer.from(String(value)).subarray(0, 125)));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.closed = true;
    const reasonBuffer = Buffer.from(String(reason)).subarray(0, 123);
    const payload = Buffer.allocUnsafe(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    this.socket.write(encodeFrame(0x8, payload));
    this.socket.end();
    this.emit('close', code, String(reason));
  }
}

export function acceptWebSocket(request, socket, head, options = {}) {
  const key = request.headers['sec-websocket-key'];
  const version = request.headers['sec-websocket-version'];
  const upgrade = String(request.headers.upgrade ?? '').toLowerCase();
  const keyBytes = typeof key === 'string' ? Buffer.from(key, 'base64') : Buffer.alloc(0);
  if (upgrade !== 'websocket' || version !== '13' || keyBytes.length !== 16) {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return null;
  }
  const accept = crypto.createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));
  return new WebSocketConnection(socket, head, options);
}
