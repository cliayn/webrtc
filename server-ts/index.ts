/**
 * WebRTC Signaling Server — PartyKit
 *
 * Protocol:
 *   Server → Client  { type: "ok",                  id: string }
 *   Client → Server  { type: "join_room",            payload: { room_id: string } }
 *   Server → Client  { type: "same_network_clients", clients: string[] }
 *   Server → Client  { type: "new_peer",             peer_id: string }
 *   Server → Client  { type: "peer_left",            peer_id: string }
 *   Client ↔ Client  { type: "offer"|"answer"|"ice"|"connect_request"|"connect_accept",
 *                       target: string, payload: unknown }  (relayed by server)
 */

import type * as Party from "partykit/server";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ClientState {
  shortId: string;
  roomId: string;
  connIp: string;
}

type ForwardableType =
  | "offer"
  | "answer"
  | "ice"
  | "connect_request"
  | "connect_accept";

const FORWARDABLE_TYPES = new Set<ForwardableType>([
  "offer",
  "answer",
  "ice",
  "connect_request",
  "connect_accept",
]);

// ── ID Generation ─────────────────────────────────────────────────────────────

const ID_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";
const ID_LEN = 4;
const MAX_ID_RETRIES = 64;

function generateShortId(existing: Set<string>): string {
  for (let attempt = 0; attempt < MAX_ID_RETRIES; attempt++) {
    let id = "";
    for (let i = 0; i < ID_LEN; i++) {
      id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
    }
    if (!existing.has(id)) return id;
  }
  // Extremely unlikely; lengthen and retry rather than crash
  const fallback = `${Date.now().toString(36).slice(-4)}${Math.random()
    .toString(36)
    .slice(2, 4)}`;
  return fallback;
}

// ── Room Key ──────────────────────────────────────────────────────────────────

function getRoomKey(roomId: string, connIp: string): string {
  return roomId ? `room:${roomId}` : `ip:${connIp}`;
}

// ── Server ────────────────────────────────────────────────────────────────────

export default class SignalingServer implements Party.Server {
  /** connId → client metadata */
  private readonly clientState = new Map<string, ClientState>();
  /** shortId → connId (reverse index) */
  private readonly shortIdToConnId = new Map<string, string>();

  constructor(readonly room: Party.Room) {}

  // ── Connection Open ─────────────────────────────────────────────────────────

  onConnect(conn: Party.Connection, ctx: Party.ConnectionContext): void {
    const connIp =
      ctx.request.headers.get("cf-connecting-ip") ??
      ctx.request.headers.get("x-forwarded-for") ??
      "unknown";

    const shortId = generateShortId(new Set(this.shortIdToConnId.keys()));

    this.clientState.set(conn.id, { shortId, roomId: "", connIp });
    this.shortIdToConnId.set(shortId, conn.id);

    console.log(`[connect] id=${shortId} ip=${connIp} conn=${conn.id}`);
    this.send(conn, { type: "ok", id: shortId });
  }

  // ── Message Dispatch ────────────────────────────────────────────────────────

  onMessage(raw: string, sender: Party.Connection): void {
    const state = this.clientState.get(sender.id);
    if (!state) return;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn(`[warn] invalid JSON from ${state.shortId}`);
      return;
    }

    const type = data.type as string | undefined;

    switch (type) {
      case "join_room":
        return this.handleJoinRoom(sender, state, data);

      case "offer":
      case "answer":
      case "ice":
      case "connect_request":
      case "connect_accept":
        return this.handleForward(sender, state, type, data);

      case "ping":
        this.send(sender, { type: "pong" });
        break;

      case "get_id":
        this.send(sender, { type: "id", id: state.shortId });
        break;

      default:
        console.warn(`[warn] unknown message type "${type}" from ${state.shortId}`);
    }
  }

  // ── Connection Close ────────────────────────────────────────────────────────

  onClose(conn: Party.Connection): void {
    const state = this.clientState.get(conn.id);
    if (!state) return;

    console.log(`[disconnect] id=${state.shortId}`);

    const roomKey = getRoomKey(state.roomId, state.connIp);

    // Notify peers in the same group
    for (const [cid, otherState] of this.clientState) {
      if (cid !== conn.id && getRoomKey(otherState.roomId, otherState.connIp) === roomKey) {
        this.room
          .getConnection(cid)
          ?.send(JSON.stringify({ type: "peer_left", peer_id: state.shortId }));
      }
    }

    // Clean up
    this.shortIdToConnId.delete(state.shortId);
    this.clientState.delete(conn.id);

    console.log(`[cleanup] id=${state.shortId} released`);
  }

  // ── Handlers ────────────────────────────────────────────────────────────────

  private handleJoinRoom(
    sender: Party.Connection,
    state: ClientState,
    data: Record<string, unknown>
  ): void {
    const payload = (data.payload ?? {}) as Record<string, unknown>;
    const roomId = String(payload.room_id ?? "").trim();
    state.roomId = roomId;

    const roomKey = getRoomKey(roomId, state.connIp);
    console.log(`[join] id=${state.shortId} key=${roomKey}`);

    // Collect existing peers in the same group (excluding sender)
    const peers: string[] = [];
    for (const [cid, otherState] of this.clientState) {
      if (
        cid !== sender.id &&
        getRoomKey(otherState.roomId, otherState.connIp) === roomKey
      ) {
        peers.push(otherState.shortId);
      }
    }

    // Tell sender who else is already here
    this.send(sender, { type: "same_network_clients", clients: peers });

    // Tell existing peers about the newcomer
    for (const peerId of peers) {
      const targetConnId = this.shortIdToConnId.get(peerId);
      if (targetConnId) {
        this.room
          .getConnection(targetConnId)
          ?.send(JSON.stringify({ type: "new_peer", peer_id: state.shortId }));
      }
    }
  }

  private handleForward(
    sender: Party.Connection,
    state: ClientState,
    type: ForwardableType,
    data: Record<string, unknown>
  ): void {
    const targetShortId = data.target as string | undefined;
    if (!targetShortId) {
      this.send(sender, { type: "error", msg: "Missing target field" });
      return;
    }

    const targetConnId = this.shortIdToConnId.get(targetShortId);
    const targetConn = targetConnId
      ? this.room.getConnection(targetConnId)
      : null;

    if (!targetConn) {
      console.warn(`[warn] target ${targetShortId} not found`);
      this.send(sender, { type: "error", msg: `Target ${targetShortId} not found` });
      return;
    }

    const fwd: Record<string, unknown> = { type, from: state.shortId };
    // connect_accept carries no payload (matches original behaviour)
    if (type !== "connect_accept") {
      fwd.payload = data.payload;
    }

    targetConn.send(JSON.stringify(fwd));
    console.log(`[relay] ${type} ${state.shortId} → ${targetShortId}`);
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private send(conn: Party.Connection, obj: Record<string, unknown>): void {
    conn.send(JSON.stringify(obj));
  }
}
