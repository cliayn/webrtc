import type * as Party from "partykit/server";

export default class SignalingServer implements Party.Server {
  // 对应 Python 的 self.clients (ConnID -> Connection)
  // PartyKit 自动维护 room.getConnections()，我们额外维护映射关系

  // 对应 Python 的 self.client_info (ConnID -> {room_id, conn_ip, short_id})
  clientState = new Map<string, { shortId: string; roomId: string; connIp: string }>();

  // 对应 Python 的 ID 池映射 (ShortID -> ConnID)
  shortIdToConnId = new Map<string, string>();

  constructor(readonly room: Party.Room) {}

  // --- 1:1 复刻 Python 的 ID 生成逻辑 ---
  _generate_new_id(): string {
    const chars = "abcdefghjkmnpqrstuvwxyz23456789";
    let id = "";
    for (let i = 0; i < 4; i++) {
      id += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    // 检查冲突 (对应 Python 的 available_ids 逻辑简化版)
    if (this.shortIdToConnId.has(id)) return this._generate_new_id();
    return id;
  }

  // --- 1:1 复刻 Python 的 Room Key 逻辑 ---
  _get_room_key(roomId: string, connIp: string): string {
    return roomId ? `room:${roomId}` : `ip:${connIp}`;
  }

  // --- 当 WebSocket 连接建立时 (对应 Python handler 的开始部分) ---
  async onConnect(conn: Party.Connection, ctx: Party.ConnectionContext) {
    const client_id = this._generate_new_id();
    const conn_ip = ctx.request.headers.get("cf-connecting-ip") || "unknown";

    // 存储状态
    this.clientState.set(conn.id, { shortId: client_id, roomId: "", connIp: conn_ip });
    this.shortIdToConnId.set(client_id, conn.id);

    // 发送初始化成功消息 (对应 Python: {"type": "ok", "id": client_id})
    conn.send(JSON.stringify({ type: "ok", id: client_id }));
  }

  // --- 处理接收到的消息 (对应 Python 的 async for message in websocket) ---
  onMessage(message: string, sender: Party.Connection) {
    let data;
    try {
      data = JSON.parse(message);
    } catch {
      return;
    }

    const senderState = this.clientState.get(sender.id);
    if (!senderState) return;

    const client_id = senderState.shortId;
    const msg_type = data.type;
    const target_id = data.target; // 注意：这是前端传来的短 ID
    const payload = data.payload;

    // ---- 1. join_room 逻辑 (完全匹配 Python) ----
    if (msg_type === "join_room") {
      const room_id = (payload?.room_id || "").toString().trim();
      senderState.roomId = room_id;

      const room_key = this._get_room_key(room_id, senderState.connIp);

      // 获取同组其他短 ID 列表
      const same_group_clients: string[] = [];
      for (const [cid, state] of this.clientState.entries()) {
        if (cid !== sender.id && this._get_room_key(state.roomId, state.connIp) === room_key) {
          same_group_clients.push(state.shortId);
        }
      }

      // 返回 same_network_clients
      sender.send(JSON.stringify({
        type: "same_network_clients",
        clients: same_group_clients
      }));

      // 通知同组其他人 new_peer
      for (const short_id of same_group_clients) {
        const targetConnId = this.shortIdToConnId.get(short_id);
        if (targetConnId) {
          this.room.getConnection(targetConnId)?.send(JSON.stringify({
            type: "new_peer",
            peer_id: client_id
          }));
        }
      }
    }

    // ---- 2. 标准信令转发 (offer, answer, ice, connect_request, connect_accept) ----
    else if (["offer", "answer", "ice", "connect_request", "connect_accept"].includes(msg_type)) {
      const targetConnId = target_id ? this.shortIdToConnId.get(target_id) : null;
      const targetConn = targetConnId ? this.room.getConnection(targetConnId) : null;

      if (targetConn) {
        const forward_msg: any = {
          type: msg_type,
          from: client_id
        };
        // Python 逻辑中，除了 connect_accept 都有 payload
        if (msg_type !== "connect_accept") {
          forward_msg.payload = payload;
        }

        targetConn.send(JSON.stringify(forward_msg));
      } else {
        sender.send(JSON.stringify({ type: "error", msg: `目标 ${target_id} 不存在` }));
      }
    }

    // ---- 3. 其他辅助消息 (ping, get_id) ----
    else if (msg_type === "ping") {
      sender.send(JSON.stringify({ type: "pong" }));
    }
    else if (msg_type === "get_id") {
      sender.send(JSON.stringify({ type: "id", id: client_id }));
    }
  }

  // --- 断开连接处理 (对应 Python 的 finally 块) ---
  onClose(conn: Party.Connection) {
    const state = this.clientState.get(conn.id);
    if (state) {
      const client_id = state.shortId;
      const room_key = this._get_room_key(state.roomId, state.connIp);

      // 通知同组其他人 peer_left (对应 Python 的 _remove_from_group 逻辑)
      for (const [cid, otherState] of this.clientState.entries()) {
        if (cid !== conn.id && this._get_room_key(otherState.roomId, otherState.connIp) === room_key) {
          this.room.getConnection(cid)?.send(JSON.stringify({
            type: "peer_left",
            peer_id: client_id
          }));
        }
      }

      // 清理内存映射 (释放 ID)
      this.shortIdToConnId.delete(client_id);
      this.clientState.delete(conn.id);
    }
  }
}