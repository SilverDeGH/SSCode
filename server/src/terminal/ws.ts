/**
 * 零依赖 RFC6455 最小 WebSocket 服务端实现（P5-07）。
 * 仅覆盖服务端所需子集：握手、masked 客户端帧解析（含分片/粘包）、
 * ping→pong、close 握手；服务端发送不 mask；不做扩展协商。
 */
import crypto from 'node:crypto';
import type http from 'node:http';
import type net from 'node:net';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 16 * 1024 * 1024;

export const WS_OPCODE = {
  CONTINUATION: 0x0,
  TEXT: 0x1,
  BINARY: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
} as const;

export type WsMessageCallback = (opcode: number, payload: Buffer) => void;

export interface WsConn {
  sendText(s: string): void;
  sendBinary(buf: Buffer): void;
  ping(): void;
  close(code?: number): void;
  onMessage(cb: WsMessageCallback): void;
  onClose(cb: () => void): void;
}

/**
 * 在已通过框架鉴权的 upgrade 回调中完成 RFC6455 握手并接管 socket。
 * head 为 upgrade 事件中可能随请求头一起到达的首批帧数据。
 */
export function acceptWebSocket(
  req: http.IncomingMessage,
  socket: net.Socket,
  head: Buffer,
): WsConn {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('missing Sec-WebSocket-Key header');
  }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      '\r\n',
  );

  let closed = false;
  let closeSent = false;
  let buf: Buffer = head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
  const messageCbs: WsMessageCallback[] = [];
  const closeCbs: (() => void)[] = [];
  let fragOpcode: number | null = null;
  const fragChunks: Buffer[] = [];

  const fireClose = (): void => {
    if (closed) return;
    closed = true;
    for (const cb of closeCbs) cb();
  };

  const sendFrame = (opcode: number, payload: Buffer): void => {
    if (closed) return;
    const len = payload.length;
    let header: Buffer;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len <= 0xffff) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      socket.write(Buffer.concat([header, payload]));
    } catch {
      // socket 已销毁
    }
  };

  const sendClose = (code?: number, echo?: Buffer): void => {
    if (closeSent) {
      socket.end();
      return;
    }
    closeSent = true;
    let payload: Buffer;
    if (echo !== undefined) {
      payload = Buffer.from(echo.subarray(0, 125));
    } else if (code !== undefined) {
      payload = Buffer.alloc(2);
      payload.writeUInt16BE(code, 0);
    } else {
      payload = Buffer.alloc(0);
    }
    sendFrame(WS_OPCODE.CLOSE, payload);
    socket.end();
  };

  const emitMessage = (opcode: number, payload: Buffer): void => {
    for (const cb of messageCbs) cb(opcode, payload);
  };

  const handleFrame = (fin: boolean, opcode: number, payload: Buffer): void => {
    if (opcode === WS_OPCODE.CLOSE) {
      sendClose(undefined, payload);
      return;
    }
    if (opcode === WS_OPCODE.PING) {
      sendFrame(WS_OPCODE.PONG, payload);
      return;
    }
    if (opcode === WS_OPCODE.PONG) return;
    if (opcode === WS_OPCODE.TEXT || opcode === WS_OPCODE.BINARY) {
      if (fragOpcode !== null) {
        sendClose(1002);
        return;
      }
      if (fin) {
        emitMessage(opcode, payload);
        return;
      }
      fragOpcode = opcode;
      fragChunks.length = 0;
      fragChunks.push(payload);
      return;
    }
    if (opcode === WS_OPCODE.CONTINUATION) {
      if (fragOpcode === null) {
        sendClose(1002);
        return;
      }
      fragChunks.push(payload);
      if (fin) {
        const op = fragOpcode;
        fragOpcode = null;
        const full = Buffer.concat(fragChunks);
        fragChunks.length = 0;
        emitMessage(op, full);
      }
      return;
    }
    sendClose(1002);
  };

  const parse = (): void => {
    for (;;) {
      if (closed) return;
      if (buf.length < 2) return;
      const b0 = buf[0]!;
      const b1 = buf[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < offset + 2) return;
        len = buf.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (buf.length < offset + 8) return;
        const big = buf.readBigUInt64BE(offset);
        if (big > BigInt(MAX_PAYLOAD)) {
          sendClose(1009);
          return;
        }
        len = Number(big);
        offset += 8;
      }
      if (len > MAX_PAYLOAD) {
        sendClose(1009);
        return;
      }
      let maskKey: Buffer | null = null;
      if (masked) {
        if (buf.length < offset + 4) return;
        maskKey = buf.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buf.length < offset + len) return;
      const payload = Buffer.from(buf.subarray(offset, offset + len));
      buf = buf.subarray(offset + len);
      if (maskKey !== null) {
        for (let i = 0; i < payload.length; i++) {
          payload[i] = payload[i]! ^ maskKey[i % 4]!;
        }
      }
      handleFrame(fin, opcode, payload);
    }
  };

  socket.on('data', (chunk: Buffer) => {
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    parse();
  });
  socket.on('error', () => fireClose());
  socket.on('close', () => fireClose());
  if (buf.length > 0) parse();

  return {
    sendText: (s) => sendFrame(WS_OPCODE.TEXT, Buffer.from(s, 'utf8')),
    sendBinary: (b) => sendFrame(WS_OPCODE.BINARY, b),
    ping: () => sendFrame(WS_OPCODE.PING, Buffer.alloc(0)),
    close: (code) => sendClose(code),
    onMessage: (cb) => {
      messageCbs.push(cb);
    },
    onClose: (cb) => {
      if (closed) cb();
      else closeCbs.push(cb);
    },
  };
}
