import { DBOperationsSet } from 'dexie-cloud-common';
import { BehaviorSubject, Observable, Subscriber, Subscription } from 'rxjs';
import { TokenExpiredError } from './authentication/TokenExpiredError';
import { DXCWebSocketStatus } from './DXCWebSocketStatus';
import { TSON } from './TSON';
import type { YClientMessage, YServerMessage } from 'dexie-cloud-common';
import { DexieCloudDB } from './db/DexieCloudDB';
import { createYClientUpdateObservable } from './yjs/createYClientUpdateObservable';
import { applyYServerMessages } from './yjs/applyYMessages';
import { DexieYProvider } from 'dexie';
import { getAwarenessLibrary, getDocAwareness } from './yjs/awareness';
import { encodeYMessage, decodeYMessage } from 'dexie-cloud-common';
import { UserLogin } from './dexie-cloud-client';
import { isEagerSyncDisabled } from './isEagerSyncDisabled';

const SERVER_PING_TIMEOUT = 20000;
const CLIENT_PING_INTERVAL = 30000;
const FAIL_RETRY_WAIT_TIME = 60000;

export type WSClientToServerMsg = ReadyForChangesMessage | YClientMessage;
export interface ReadyForChangesMessage {
  type: 'ready';
  realmSetHash: string;
  rev: string;
}

export type WSConnectionMsg =
  | RevisionChangedMessage
  | RealmAddedMessage
  | RealmAcceptedMessage
  | RealmRemovedMessage
  | RealmsChangedMessage
  | ChangesFromServerMessage
  | TokenExpiredMessage;
interface PingMessage {
  type: 'ping';
}

interface PongMessage {
  type: 'pong';
}

interface ErrorMessage {
  type: 'error';
  error: string;
}

export interface ChangesFromServerMessage {
  type: 'changes';
  baseRev: string;
  realmSetHash: string;
  newRev: string;
  changes: DBOperationsSet<string>;
}
export interface RevisionChangedMessage {
  type: 'rev';
  rev: string;
}

export interface RealmAddedMessage {
  type: 'realm-added';
  realm: string;
}

export interface RealmAcceptedMessage {
  type: 'realm-accepted';
  realm: string;
}

export interface RealmRemovedMessage {
  type: 'realm-removed';
  realm: string;
}

export interface RealmsChangedMessage {
  type: 'realms-changed';
  realmsHash: string;
}
export interface TokenExpiredMessage {
  type: 'token-expired';
}

export class WSObservable extends Observable<WSConnectionMsg> {
  constructor(
    db: DexieCloudDB,
    rev: string,
    realmSetHash: string,
    clientIdentity: string,
    messageProducer: Observable<WSClientToServerMsg>,
    webSocketStatus: BehaviorSubject<DXCWebSocketStatus>,
    user: UserLogin
  ) {
    super(
      (subscriber) =>
        new WSConnection(
          db,
          rev,
          realmSetHash,
          clientIdentity,
          user,
          subscriber,
          messageProducer,
          webSocketStatus
        )
    );
  }
}

let counter = 0;

export class WSConnection extends Subscription {
  db: DexieCloudDB;
  ws: WebSocket | null;
  lastServerActivity: Date;
  lastUserActivity: Date;
  lastPing: Date;
  databaseUrl: string;
  rev: string;
  realmSetHash: string;
  clientIdentity: string;
  user: UserLogin;
  subscriber: Subscriber<WSConnectionMsg>;
  pauseUntil?: Date;
  messageProducer: Observable<WSClientToServerMsg>;
  webSocketStatus: BehaviorSubject<DXCWebSocketStatus>;
  id = ++counter;

  private pinger: any;
  private subscriptions: Set<Subscription> = new Set();

  constructor(
    db: DexieCloudDB,
    rev: string,
    realmSetHash: string,
    clientIdentity: string,
    user: UserLogin,
    subscriber: Subscriber<WSConnectionMsg>,
    messageProducer: Observable<WSClientToServerMsg>,
    webSocketStatus: BehaviorSubject<DXCWebSocketStatus>
  ) {
    super(() => this.teardown());
    console.debug(
      'New WebSocket Connection',
      this.id,
      user.accessToken ? 'authorized' : 'unauthorized'
    );
    this.db = db;
    this.databaseUrl = db.cloud.options!.databaseUrl;
    this.rev = rev;
    this.realmSetHash = realmSetHash;
    this.clientIdentity = clientIdentity;
    this.user = user;
    this.subscriber = subscriber;
    this.lastUserActivity = new Date();
    this.messageProducer = messageProducer;
    this.webSocketStatus = webSocketStatus;
    this.connect();
  }

  private teardown() {
    console.debug('Teardown WebSocket Connection', this.id);
    this.disconnect();
  }

  private disconnect() {
    this.webSocketStatus.next('disconnected');
    if (this.pinger) {
      clearInterval(this.pinger);
      this.pinger = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
    }
    this.ws = null;
    for (const sub of this.subscriptions) {
      sub.unsubscribe();
    }
    this.subscriptions.clear();
  }

  reconnecting = false;
  reconnect() {
    if (this.reconnecting) return;
    this.reconnecting = true;
    try {
      this.disconnect();
    } catch {}
    this.connect()
      .catch(() => {})
      .then(() => (this.reconnecting = false)); // finally()
  }

  async connect() {
    this.lastServerActivity = new Date();
    if (this.pauseUntil && this.pauseUntil > new Date()) {
      console.debug('WS not reconnecting just yet', {
        id: this.id,
        pauseUntil: this.pauseUntil,
      });
      return;
    }
    if (this.ws) {
      throw new Error(`Called connect() when a connection is already open`);
    }
    if (!this.databaseUrl)
      throw new Error(`Cannot connect without a database URL`);
    if (this.closed) {
      //console.debug('SyncStatus: DUBB: Ooops it was closed!');
      return;
    }
    const tokenExpiration = this.user.accessTokenExpiration;
    if (tokenExpiration && tokenExpiration < new Date()) {
      this.subscriber.error(new TokenExpiredError()); // Will be handled in connectWebSocket.ts.
      return;
    }
    this.webSocketStatus.next('connecting');
    this.pinger = setInterval(async () => {
      if (this.closed) {
        console.debug('pinger check', this.id, 'CLOSED.');
        this.teardown();
        return;
      }
      if (this.ws) {
        try {
          this.ws.send(JSON.stringify({ type: 'ping' } as PingMessage));
          setTimeout(() => {
            console.debug(
              'pinger setTimeout',
              this.id,
              this.pinger ? `alive` : 'dead'
            );
            if (!this.pinger) return;
            if (this.closed) {
              console.debug(
                'pinger setTimeout',
                this.id,
                'subscription is closed'
              );
              this.teardown();
              return;
            }
            if (
              this.lastServerActivity <
              new Date(Date.now() - SERVER_PING_TIMEOUT)
            ) {
              // Server inactive. Reconnect if user is active.
              console.debug('pinger: server is inactive');
              console.debug('pinger reconnecting');
              this.reconnect();
            } else {
              console.debug('pinger: server still active');
            }
          }, SERVER_PING_TIMEOUT);
        } catch {
          console.debug('pinger catch error', this.id, 'reconnecting');
          this.reconnect();
        }
      } else {
        console.debug('pinger', this.id, 'reconnecting');
        this.reconnect();
      }
    }, CLIENT_PING_INTERVAL);

    // The following vars are needed because we must know which callback to ack when server sends it's ack to us.
    const wsUrl = new URL(this.databaseUrl);
    wsUrl.protocol = wsUrl.protocol === 'http:' ? 'ws' : 'wss';
    const searchParams = new URLSearchParams();
    if (this.subscriber.closed) return;
    searchParams.set('v', '2');
    searchParams.set('rev', this.rev);
    searchParams.set('realmsHash', this.realmSetHash);
    searchParams.set('clientId', this.clientIdentity);
    if (this.user.accessToken) {
      searchParams.set('token', this.user.accessToken);
    }

    // Connect the WebSocket to given url:
    console.debug('dexie-cloud WebSocket create');
    const ws = (this.ws = new WebSocket(`${wsUrl}/changes?${searchParams}`));
    ws.binaryType = "arraybuffer";

    ws.onclose = (event: Event) => {
      if (!this.pinger) return;
      console.debug('dexie-cloud WebSocket onclosed', this.id);
      this.reconnect();
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!this.pinger) return;
      console.debug('dexie-cloud WebSocket onmessage', event.data);

      this.lastServerActivity = new Date();
      try {
        const msg = typeof event.data === 'string'
          ? TSON.parse(event.data) as
            | WSConnectionMsg
            | PongMessage
            | ErrorMessage
            | YServerMessage   
          : decodeYMessage(new Uint8Array(event.data)) as
            | YServerMessage;
        if (msg.type === 'error') {
          throw new Error(`Error message from dexie-cloud: ${msg.error}`);
        } else if (msg.type === 'rev') {
          this.rev = msg.rev; // No meaning but seems reasonable.
        } else if (msg.type === 'aware') {
          const docCache = DexieYProvider.getDocCache(this.db.dx);
          const doc = docCache.find(msg.table, msg.k, msg.prop);
          if (doc) {
            const awareness = getDocAwareness(doc);
            if (awareness) {
              const awap = getAwarenessLibrary(this.db);
              awap.applyAwarenessUpdate(
                awareness,
                msg.u,
                'server',
              );
            }
          }
        } else  if (msg.type === 'u-ack' || msg.type === 'u-reject' || msg.type === 'u-s' || msg.type === 'in-sync') {
          applyYServerMessages([msg], this.db);
        } else if (msg.type !== 'pong') {
          this.subscriber.next(msg);
        }
      } catch (e) {
        this.subscriber.error(e);
      }
    };

    try {
      let everConnected = false;
      await new Promise((resolve, reject) => {
        ws.onopen = (event) => {
          console.debug('dexie-cloud WebSocket onopen');
          everConnected = true;
          resolve(null);
        };
        ws.onerror = (event: ErrorEvent) => {
          if (!everConnected) {
            const error = event.error || new Error('WebSocket Error');
            this.subscriber.error(error);
            this.webSocketStatus.next('error');
            reject(error);
          } else {
            this.reconnect();
          }
        };
      });
      this.subscriptions.add(this.messageProducer.subscribe(
        (msg) => {
          if (!this.closed) {
            if (
              msg.type === 'ready' &&
              this.webSocketStatus.value !== 'connected'
            ) {
              this.webSocketStatus.next('connected');
            }
            if (msg.type === 'ready') {
              this.ws?.send(TSON.stringify(msg));
            } else {
              // If it's not a "ready" message, it's an YMessage.
              // YMessages can be sent binary encoded.
              this.ws?.send(encodeYMessage(msg));
            }
          }
        }
      ));
      if (this.user.isLoggedIn && !isEagerSyncDisabled(this.db)) {
        this.subscriptions.add(
          createYClientUpdateObservable(this.db).subscribe(
            this.db.messageProducer
          )
        );
      }
    } catch (error) {
      this.pauseUntil = new Date(Date.now() + FAIL_RETRY_WAIT_TIME);
    }
  }
}

