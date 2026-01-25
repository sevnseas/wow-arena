import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { ArenaServer } from '../src/index';
import {
  encodeClientMessage,
  decodeServerMessage,
  type Ping,
  type Welcome,
  type Pong,
} from '../../src/shared/protocol';

// Use a different port for each test to avoid conflicts
let testPort = 9000;
function getTestPort(): number {
  return testPort++;
}

describe('ArenaServer', () => {
  let server: ArenaServer;
  let port: number;

  beforeEach(() => {
    port = getTestPort();
    server = new ArenaServer({ port, tickRate: 20 });
  });

  afterEach(async () => {
    if (server.isRunning()) {
      await server.stop();
    }
  });

  describe('lifecycle', () => {
    it('starts and stops cleanly', async () => {
      expect(server.isRunning()).toBe(false);

      await server.start();
      expect(server.isRunning()).toBe(true);

      await server.stop();
      expect(server.isRunning()).toBe(false);
    });

    it('rejects starting twice', async () => {
      await server.start();

      await expect(server.start()).rejects.toThrow('Server already running');
    });

    it('initializes with zero clients', async () => {
      await server.start();
      expect(server.getClientCount()).toBe(0);
    });

    it('initializes tick counter at zero', async () => {
      await server.start();
      expect(server.getCurrentTick()).toBe(0);
    });
  });

  describe('client connections', () => {
    it('accepts a client connection', async () => {
      await server.start();

      const ws = new WebSocket(`ws://localhost:${port}`);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      // Wait for server to register connection
      await new Promise(r => setTimeout(r, 50));

      expect(server.getClientCount()).toBe(1);

      ws.close();
    });

    it('sends Welcome message on connect', async () => {
      await server.start();

      const ws = new WebSocket(`ws://localhost:${port}`);

      const welcome = await new Promise<Welcome>((resolve, reject) => {
        ws.on('message', (data) => {
          const msg = decodeServerMessage(data.toString());
          if (msg?.type === 'Welcome') {
            resolve(msg);
          }
        });
        ws.on('error', reject);
      });

      expect(welcome.type).toBe('Welcome');
      expect(welcome.playerId).toMatch(/^player_client_\d+$/);
      expect(typeof welcome.tick).toBe('number');
      expect(typeof welcome.serverTime).toBe('number');

      ws.close();
    });

    it('tracks multiple clients', async () => {
      await server.start();

      const ws1 = new WebSocket(`ws://localhost:${port}`);
      const ws2 = new WebSocket(`ws://localhost:${port}`);

      await Promise.all([
        new Promise<void>((resolve, reject) => {
          ws1.on('open', () => resolve());
          ws1.on('error', reject);
        }),
        new Promise<void>((resolve, reject) => {
          ws2.on('open', () => resolve());
          ws2.on('error', reject);
        }),
      ]);

      await new Promise(r => setTimeout(r, 50));
      expect(server.getClientCount()).toBe(2);

      ws1.close();
      await new Promise(r => setTimeout(r, 50));
      expect(server.getClientCount()).toBe(1);

      ws2.close();
      await new Promise(r => setTimeout(r, 50));
      expect(server.getClientCount()).toBe(0);
    });

    it('assigns unique player IDs', async () => {
      await server.start();

      const ws1 = new WebSocket(`ws://localhost:${port}`);
      const ws2 = new WebSocket(`ws://localhost:${port}`);

      const welcomes: Welcome[] = [];

      await Promise.all([
        new Promise<void>((resolve, reject) => {
          ws1.on('message', (data) => {
            const msg = decodeServerMessage(data.toString());
            if (msg?.type === 'Welcome') {
              welcomes.push(msg);
              resolve();
            }
          });
          ws1.on('error', reject);
        }),
        new Promise<void>((resolve, reject) => {
          ws2.on('message', (data) => {
            const msg = decodeServerMessage(data.toString());
            if (msg?.type === 'Welcome') {
              welcomes.push(msg);
              resolve();
            }
          });
          ws2.on('error', reject);
        }),
      ]);

      expect(welcomes[0].playerId).not.toBe(welcomes[1].playerId);

      ws1.close();
      ws2.close();
    });
  });

  describe('ping/pong', () => {
    it('responds to Ping with Pong', async () => {
      await server.start();

      const ws = new WebSocket(`ws://localhost:${port}`);
      const clientTime = Date.now();

      // Set up message collector before anything can arrive
      const messages: Array<Welcome | Pong> = [];
      let pongResolve: ((pong: Pong) => void) | null = null;

      ws.on('message', (data) => {
        const msg = decodeServerMessage(data.toString());
        if (msg?.type === 'Welcome' || msg?.type === 'Pong') {
          messages.push(msg as Welcome | Pong);
          if (msg.type === 'Pong' && pongResolve) {
            pongResolve(msg);
          }
        }
      });

      // Wait for connection
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      // Wait for welcome
      await new Promise<void>((resolve) => {
        const check = () => {
          if (messages.some(m => m.type === 'Welcome')) {
            resolve();
          } else {
            setTimeout(check, 10);
          }
        };
        check();
      });

      // Send ping
      const ping: Ping = { type: 'Ping', clientTime };
      ws.send(encodeClientMessage(ping));

      // Wait for pong
      const pong = await new Promise<Pong>((resolve) => {
        // Check if already received
        const existing = messages.find(m => m.type === 'Pong') as Pong | undefined;
        if (existing) {
          resolve(existing);
        } else {
          pongResolve = resolve;
        }
      });

      expect(pong.type).toBe('Pong');
      expect(pong.clientTime).toBe(clientTime);
      expect(pong.serverTime).toBeGreaterThanOrEqual(clientTime);

      ws.close();
    });
  });

  describe('tick loop', () => {
    it('increments tick counter', async () => {
      await server.start();

      const initialTick = server.getCurrentTick();

      // Wait for a few ticks (at 20Hz, 100ms = ~2 ticks)
      await new Promise(r => setTimeout(r, 150));

      const laterTick = server.getCurrentTick();
      expect(laterTick).toBeGreaterThan(initialTick);
    });

    it('stops ticking when server stops', async () => {
      await server.start();

      await new Promise(r => setTimeout(r, 100));
      const tickAtStop = server.getCurrentTick();

      await server.stop();

      await new Promise(r => setTimeout(r, 100));
      const tickAfterStop = server.getCurrentTick();

      // Tick should not have incremented after stop
      expect(tickAfterStop).toBe(tickAtStop);
    });
  });

  describe('cleanup', () => {
    it('closes all connections on stop', async () => {
      await server.start();

      const ws = new WebSocket(`ws://localhost:${port}`);

      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });

      const closePromise = new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
      });

      await server.stop();
      await closePromise;

      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });
  });
});
