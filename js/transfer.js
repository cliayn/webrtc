// 传输功能模块 v2.3.0 — 多连接聊天 + 全量流式文件传输
//
//   ✔ ACK 应用层流控  ✔ 4路并发数据通道
//   ✔ Gzip 压缩        ✔ 断点续传
//   ✔ 进度同步         ✔ 全量流式落盘（File System Access API / StreamSaver）
//
// 依赖全局：connections, activePeerId, dc, pc
// 依赖全局函数：addLog, showModal, streamSaver（可选）

// ========== 常量 ==========
var CHUNK_SIZE           = 64 * 1024;        // 每个切片 64KB
var CHANNEL_COUNT        = 4;                // 并发数据通道数
var ACK_INTERVAL_MS      = 80;               // ACK 最小间隔（毫秒）
var ACK_CHUNK_STEP       = 32;               // 每收到 N 个块发一次 ACK
var INIT_WINDOW          = 8;                // 每通道初始飞行窗口（块数）= 512KB
var MAX_WINDOW           = 32;               // 每通道最大飞行窗口 = 2MB
var MIN_WINDOW           = 2;                // 每通道最小飞行窗口
var BUFFER_SOFT_CAP      = 4 * 1024 * 1024;  // 单通道缓冲区软上限 4MB
var MAX_PIPELINE         = 128;              // 全局管道上限（块）= 8MB 总在途数据
var STALL_TIMEOUT_MS     = 5000;             // 停顿检测超时
var MAX_CONCURRENT_WRITES = 32;              // 接收端最大并发落盘写入数

// 并发通道固定 ID（高段位，避免与主通道冲突）
var TF_CHANNEL_IDS = [1000, 1001, 1002, 1003];

// ========== 传输状态 ==========
var _tf = {};  // peerId -> TransferSession

// ========== 文件选择通知 & 消息缓冲 ==========
var _peerSelectingFile = {};  // peerId -> true  (对方正在选择文件)
var _msgBuffer = {};          // peerId -> [ { type, text, seq, ts } ]  (缓冲的消息)
var _cameraStream = null;     // 拍照用摄像头流
var _dragActivePeerId = null; // 当前拖放目标 peerId

// ========== 预选文件队列（连接建立后自动上传） ==========
// 背景：Android 点击 <input type=file> 会跳到系统文件选择器使页面切后台，
// 可能导致 WebRTC 连接被浏览器挂起/断开。因此把"选文件"这一动作提前到
// 建立连接之前（此时无连接可断），连接成功后无交互自动上传。
var _stagedFiles = [];        // File[] 待上传队列
var _stagedActiveFile = null; // 正在自动上传的暂存文件（中断时回队列重传）

// ========== 消息排序 ==========
var _chatSeq = {};            // peerId -> int (本地发送序列号)
var _peerLastSeq = {};        // peerId -> int (对方最后收到的序列号)
var _localDeviceType = null;  // 本机设备类型: 'android' | 'ios' | 'desktop'

// ========== 设备检测 ==========
function _detectDeviceType() {
    if (_localDeviceType) return _localDeviceType;
    var ua = navigator.userAgent;
    if (/Android/i.test(ua)) {
        _localDeviceType = 'android';
    } else if (/iPhone|iPad|iPod/i.test(ua)) {
        _localDeviceType = 'ios';
    } else {
        _localDeviceType = 'desktop';
    }
    addLog('[设备检测] 本机类型: ' + _localDeviceType);
    return _localDeviceType;
}

// ========== 创建主数据通道 ==========
function createDataChannel() {
    dc = pc.createDataChannel('fileTransfer');
    dc.binaryType = 'arraybuffer';
    dc.onopen  = function () { addLog('[数据通道] 已创建'); };
    dc.onclose = function () { addLog('[数据通道] 关闭'); };
}

// ========== DC就绪握手（双方DC都open后才打开聊天UI） ==========
function _announceDcReady(peerId) {
    var conn = connections[peerId];
    if (!conn) return;
    conn._localDcReady = true;
    // 发送chat-ready通知对方（附带设备类型，用于消息缓冲决策）
    if (conn.dc && conn.dc.readyState === 'open') {
        conn.dc.send(JSON.stringify({ type: 'chat-ready', device: _detectDeviceType() }));
        addLog('[聊天就绪] 本地DC已就绪，已通知 ' + peerId);
    }
    _tryOpenChat(peerId);
}

function _onChatReady(peerId, msg) {
    var conn = connections[peerId];
    if (!conn) return;
    conn._remoteDcReady = true;
    if (msg && msg.device) {
        conn._peerDeviceType = msg.device;
        addLog('[设备检测] ' + peerId + ' 设备类型: ' + msg.device);
        // 对面是 AI 对端（p2p-chat 技能），才露出「对话模式」入口
        conn._isAiPeer = (msg.device === 'ai-peer');
    }
    addLog('[聊天就绪] 对方 ' + peerId + ' DC已就绪');
    _tryOpenChat(peerId);
    _refreshAiButton(peerId);
}

function _tryOpenChat(peerId) {
    var conn = connections[peerId];
    if (!conn) return;
    if (conn._localDcReady && conn._remoteDcReady) {
        // 双方DC都已就绪，打开聊天界面
        if (window._openPeerChat) {
            window._openPeerChat(peerId);
        }
    }
}

// ========== AI 对端：对话模式（即时对话 / 续接历史） ==========
// 对面是跑 p2p-chat 技能的 AI 时，除了聊天还能查它的历史会话、把对话链切过去。
// 消息都走主通道：
//   网页 → AI   {type:'ai-sessions'}                       问有哪些历史会话
//   AI → 网页    {type:'ai-sessions-list', current, sessions, error?}
//   网页 → AI   {type:'ai-session-peek', sessionId}        只看某一条讲了什么
//   AI → 网页    {type:'ai-session-peek', sessionId, preview, error?}
//   网页 → AI   {type:'ai-mode', sessionId}                sessionId=null 就是开新对话
// 前两条 AI 一定会回，所以「切没切成」不用另设回执，回来那条里的 current 就是权威答案。
//
// 列表里**不带内容**，只有 id/时间/大小。对面一次请求换不回一屏对话摘要，
// 想知道某条讲了什么得单独点名，一次只出一条。

var _aiPanelPeerId = null;  // 面板正在给哪个对端选
var _aiSessions = [];       // 最近一次拿到的会话列表（只有元信息）
var _aiCurrent = null;      // AI 那边当前挂着哪条会话
var _aiTimer = null;        // 请求超时（对端不是 AI 或版本旧，不会有回应）
var _aiPreviews = {};       // sessionId -> 已经点名看过的内容
var _aiPeekPending = {};    // sessionId -> true，正在等对面回

/** 标题栏那个入口按钮：对面是 AI 才露出来，标签反映当前模式 */
function _refreshAiButton(peerId) {
    var btn = document.querySelector('#peerTabs .peer-chat-container[data-peerid="' + peerId + '"] .ai-mode-btn');
    if (!btn) return;
    var conn = connections[peerId];
    var isAi = !!(conn && conn._isAiPeer);
    btn.classList.toggle('hidden', !isAi);
    if (!isAi) return;
    var isHistory = conn._aiMode === 'history';
    var label = btn.querySelector('.ai-mode-label');
    if (label) label.textContent = isHistory ? '续接历史' : '即时对话';
    btn.classList.toggle('ai-mode-active', isHistory);
}

function _openAiPanel(peerId) {
    _aiPanelPeerId = peerId;
    var panel = document.getElementById('aiPanel');
    if (!panel) return;
    panel.classList.add('show');
    _aiShowTab('instant');
    _aiShowMsg('');
    _aiRequestSessions(peerId);
}

function _closeAiPanel() {
    var panel = document.getElementById('aiPanel');
    if (panel) panel.classList.remove('show');
    if (_aiTimer) { clearTimeout(_aiTimer); _aiTimer = null; }
    _aiPanelPeerId = null;
}

function _aiShowTab(which) {
    var instant = (which === 'instant');
    var t1 = document.getElementById('aiTabInstant');
    var t2 = document.getElementById('aiTabHistory');
    var p1 = document.getElementById('aiPaneInstant');
    var p2 = document.getElementById('aiPaneHistory');
    if (t1) t1.classList.toggle('active', instant);
    if (t2) t2.classList.toggle('active', !instant);
    if (p1) p1.classList.toggle('hidden', !instant);
    if (p2) p2.classList.toggle('hidden', instant);
}

function _aiShowMsg(text) {
    var el = document.getElementById('aiPanelMsg');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
}

function _aiSend(peerId, obj) {
    var conn = connections[peerId];
    if (!conn || !conn.dc || conn.dc.readyState !== 'open') return false;
    conn.dc.send(JSON.stringify(obj));
    return true;
}

function _aiRequestSessions(peerId) {
    if (!_aiSend(peerId, { type: 'ai-sessions' })) {
        _aiShowMsg('连接不在了，没法问对面。');
        return;
    }
    // 对面要是不是 AI（或者版本旧），这条没人接，面板会一直停在「正在获取…」
    if (_aiTimer) clearTimeout(_aiTimer);
    _aiTimer = setTimeout(function () {
        _aiTimer = null;
        _aiShowMsg('对面没回应。它可能不是 AI 对端，或者版本太旧。');
        var list = document.getElementById('aiSessionList');
        if (list) list.innerHTML = '<div class="ai-empty">没有拿到会话列表</div>';
    }, 8000);
}

function _onAiSessionsList(peerId, msg) {
    if (_aiTimer) { clearTimeout(_aiTimer); _aiTimer = null; }
    if (peerId !== _aiPanelPeerId) {
        addLog('[对话模式] 收到 ' + peerId + ' 的会话列表，但面板不是给它开的，忽略');
        return;
    }
    _aiSessions = (msg && msg.sessions) || [];
    _aiCurrent = (msg && msg.current) || null;
    // 换了一批列表，之前点开的内容就作废了（会话可能已经被删）
    _aiPreviews = {};
    _aiPeekPending = {};
    _aiShowMsg((msg && msg.error) || '');

    // 当前那条自动看一眼：列表里全是时间和大小，总得让人知道现在挂在哪段对话上
    if (_aiCurrent) _aiPeekSession(_aiCurrent);

    var conn = connections[peerId];
    if (conn) {
        // 挂着历史会话就是「续接历史」，否则是普通的即时对话
        conn._aiMode = _aiCurrent ? 'history' : 'instant';
    }
    _renderAiSessions();
    _refreshAiButton(peerId);
}

function _renderAiSessions() {
    var cur = document.getElementById('aiCurrent');
    if (cur) {
        cur.textContent = _aiCurrent
            ? '当前对话：' + String(_aiCurrent).slice(0, 8) + '… （续接中的历史会话）'
            : '当前对话：新对话（没有上下文）';
    }

    var box = document.getElementById('aiSessionList');
    if (!box) return;
    if (!_aiSessions.length) {
        box.innerHTML = '<div class="ai-empty">这台机器上没有可续接的历史会话</div>';
        return;
    }

    box.innerHTML = '';
    _aiSessions.forEach(function (s) {
        var isCur = (s.sessionId === _aiCurrent);
        var row = document.createElement('div');
        row.className = 'ai-session-row' + (isCur ? ' is-current' : '');

        var main = document.createElement('div');
        main.className = 'ai-session-main';

        var meta = document.createElement('div');
        meta.className = 'ai-session-meta';
        meta.textContent = _formatAiTime(s.mtime) + ' · ' + _formatAiSize(s.size);
        main.appendChild(meta);

        var prev = document.createElement('div');
        prev.className = 'ai-session-preview';
        var known = _aiPreviews[s.sessionId];
        if (known !== undefined) {
            prev.textContent = known || '（这条没有可显示的开头）';
            prev.title = known || '';
        } else {
            // 内容是要单独点名才拿的（见 _aiPeekSession），没拿过就先摆个按钮
            prev.className += ' ai-session-hidden';
            prev.textContent = '内容未展开';
        }
        main.appendChild(prev);

        var peek = document.createElement('button');
        peek.type = 'button';
        peek.className = 'ai-session-peek';
        if (known !== undefined) {
            peek.classList.add('hidden');
        } else if (_aiPeekPending[s.sessionId]) {
            peek.textContent = '读取中…';
            peek.disabled = true;
        } else {
            peek.textContent = '看内容';
            peek.onclick = function () { _aiPeekSession(s.sessionId); };
        }
        main.appendChild(peek);

        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ai-session-pick';
        btn.textContent = isCur ? '当前' : '续接';
        btn.disabled = isCur;
        btn.onclick = function () { _aiPickSession(s.sessionId); };

        row.appendChild(main);
        row.appendChild(btn);
        box.appendChild(row);
    });
}

/** 点名看某一条会话的开头（详情要多少给多少，不是整份记录） */
function _aiPeekSession(sessionId) {
    var peerId = _aiPanelPeerId;
    if (!peerId || !sessionId) return;
    if (_aiPreviews[sessionId] !== undefined || _aiPeekPending[sessionId]) return;

    _aiPeekPending[sessionId] = true;
    if (!_aiSend(peerId, { type: 'ai-session-peek', sessionId: sessionId })) {
        delete _aiPeekPending[sessionId];
        return;
    }
    _renderAiSessions();
    // 对面要是不认这条消息，就一直是「读取中…」——给个底，别让人干等
    var pid = peerId;
    setTimeout(function () {
        if (_aiPanelPeerId !== pid || !_aiPeekPending[sessionId]) return;
        delete _aiPeekPending[sessionId];
        _aiPreviews[sessionId] = '';
        _renderAiSessions();
    }, 8000);
}

function _onAiSessionPeek(peerId, msg) {
    if (peerId !== _aiPanelPeerId) return;
    var sid = msg && msg.sessionId;
    if (!sid) return;
    delete _aiPeekPending[sid];
    if (msg.error) {
        addLog('[对话模式] 读 ' + sid + ' 的内容失败: ' + msg.error);
        _aiPeekSessionFailed(sid);
        return;
    }
    _aiPreviews[sid] = String(msg.preview || '');
    _renderAiSessions();
}

function _aiPeekSessionFailed(sid) {
    delete _aiPeekPending[sid];
    _aiPreviews[sid] = '';
    _renderAiSessions();
}

function _formatAiTime(ms) {
    if (!ms) return '时间未知';
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function _formatAiSize(n) {
    if (typeof n !== 'number') return '';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return (i === 0 ? v : v.toFixed(1)) + u[i];
}

/** 把 AI 的对话链切到某条历史会话上 */
function _aiPickSession(sessionId) {
    var peerId = _aiPanelPeerId;
    if (!peerId) return;
    if (!_aiSend(peerId, { type: 'ai-mode', sessionId: sessionId })) {
        _aiShowMsg('连接不在了，没法切换。');
        return;
    }
    addLog('[对话模式] 请求续接会话 ' + sessionId);
    _aiShowMsg('');
}

/** 让 AI 丢掉上下文，从新对话开始 */
function _aiNewChat() {
    var peerId = _aiPanelPeerId;
    if (!peerId) return;
    if (!_aiSend(peerId, { type: 'ai-mode', sessionId: null })) {
        _aiShowMsg('连接不在了，没法切换。');
        return;
    }
    addLog('[对话模式] 请求开新对话');
    _aiShowMsg('');
}

// ========== 为主数据通道设置消息处理器 ==========
function setupDataChannelForPeer(peerId, channel) {
    // 防止重复设置（channel._setupDone标记）
    if (channel._setupDone) return;
    channel._setupDone = true;

    channel.binaryType = 'arraybuffer';

    channel.onopen = function () {
        addLog('[数据通道] ' + peerId + ' 已打开');
        addPeerMessage(peerId, 'system', '数据通道已建立');
        _announceDcReady(peerId);
        // DC恢复后立即发送缓冲消息（灰泡变蓝）
        _flushBufferedMsgs(peerId);
    };

    channel.onclose = function () {
        addLog('[数据通道] ' + peerId + ' 关闭');
        _abortTransfer(peerId);
    };

    // 如果通道已经打开，立即宣布就绪并刷新缓冲消息
    if (channel.readyState === 'open') {
        addLog('[数据通道] ' + peerId + ' 已处于打开状态');
        _announceDcReady(peerId);
        _flushBufferedMsgs(peerId);
    }

    channel.onmessage = function (e) {
        if (typeof e.data !== 'string') return;

        var msg;
        try { msg = JSON.parse(e.data); } catch (ex) { return; }

        if (msg.type === 'transfer-header') {
            _onTransferHeader(peerId, msg);
        } else if (msg.type === 'transfer-ready') {
            _onTransferReady(peerId);
        } else if (msg.type === 'transfer-ack') {
            _onTransferAck(peerId, msg);
        } else if (msg.type === 'transfer-resume') {
            _onTransferResume(peerId, msg);
        } else if (msg.type === 'transfer-complete') {
            _onTransferComplete(peerId);
        } else if (msg.type === 'transfer-cancel') {
            addPeerMessage(peerId, 'system', '对方取消了传输');
            _abortTransfer(peerId);
        } else if (msg.type === 'chat') {
            addPeerMessage(peerId, 'peer', msg.text, msg.ts, msg.seq);
            // 跟踪对端最后序列号（用于乱序检测）
            if (msg.seq !== undefined) {
                if (!_peerLastSeq[peerId]) _peerLastSeq[peerId] = 0;
                if (msg.seq > _peerLastSeq[peerId]) _peerLastSeq[peerId] = msg.seq;
            }
        } else if (msg.type === 'chat-ready') {
            _onChatReady(peerId, msg);
        } else if (msg.type === 'file-selecting') {
            _onPeerFileSelecting(peerId, msg);
        } else if (msg.type === 'messages-flush') {
            _onMessagesFlush(peerId, msg);
        } else if (msg.type === 'ai-sessions-list') {
            _onAiSessionsList(peerId, msg);
        } else if (msg.type === 'ai-session-peek') {
            _onAiSessionPeek(peerId, msg);
        } else if (msg.type === 'disconnect') {
            addLog('[同步断开] ' + peerId + ' 已断开连接');
            addPeerMessage(peerId, 'system', '对方已断开连接');
            setTimeout(function () {
                if (window.cleanupConnection) window.cleanupConnection(peerId);
            }, 100);
        }
    };
}

// ========== 文件选择通知处理 ==========
function _onPeerFileSelecting(peerId, msg) {
    var peerDevice = connections[peerId] && connections[peerId]._peerDeviceType;

    if (msg.action === 'start') {
        // 桌面和iOS不会断连，无需任何提示和缓冲
        if (peerDevice !== 'android') {
            addLog('[文件选择] ' + peerId + ' (' + (peerDevice || '未知') + ') 无需缓冲');
            return;
        }
        // Android：设置缓冲标志，仅弹toast提示
        _peerSelectingFile[peerId] = true;
        addLog('[文件选择] ' + peerId + ' (Android) 正在选择文件');
        _showToast('对方在选择文件，消息将缓存延迟发送', 2500);
        // 超时保护：30秒后自动清除（防止'end'通知丢失）
        var _pid = peerId;
        setTimeout(function () {
            if (_peerSelectingFile[_pid]) {
                _peerSelectingFile[_pid] = false;
                addLog('[文件选择] 超时自动清除选择状态 for ' + _pid);
                _flushBufferedMsgs(_pid);
            }
        }, 30000);
    } else if (msg.action === 'end') {
        _peerSelectingFile[peerId] = false;
        addLog('[文件选择] ' + peerId + ' 文件选择完成');
        _flushBufferedMsgs(peerId);
    }
}

function _onMessagesFlush(peerId, msg) {
    if (msg.messages && msg.messages.length > 0) {
        addLog('[消息刷新] 收到 ' + msg.messages.length + ' 条缓冲消息');
        for (var i = 0; i < msg.messages.length; i++) {
            if (msg.messages[i].type === 'chat') {
                // 使用原始时间戳和序列号，排序插入到正确位置
                addPeerMessage(peerId, 'peer', msg.messages[i].text, msg.messages[i].ts, msg.messages[i].seq);
            }
        }
    }
}

// 发送缓冲的消息给对端，并恢复灰色气泡为正常颜色
function _flushBufferedMsgs(peerId) {
    var conn = connections[peerId];
    if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
        addLog('[消息刷新] 数据通道未就绪，无法发送缓冲消息');
        return;
    }
    var buf = _msgBuffer[peerId];
    if (!buf || buf.length === 0) return;
    addLog('[消息刷新] 发送 ' + buf.length + ' 条缓冲消息到 ' + peerId);

    // 将缓冲消息按顺序发送
    conn.dc.send(JSON.stringify({
        type: 'messages-flush',
        messages: buf.map(function (m) { return { type: m.type, text: m.text, seq: m.seq, ts: m.ts }; })
    }));

    // 恢复灰色气泡为正常蓝色
    for (var i = 0; i < buf.length; i++) {
        if (buf[i].el) {
            buf[i].el.classList.remove('buffered-msg');
        }
    }
    _msgBuffer[peerId] = [];
}

// 通知对方：我正在选择文件 / 已完成选择
function _announceFileSelecting(peerId, action) {
    var conn = connections[peerId];
    if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
        addLog('[文件选择] 数据通道未就绪，无法通知对方');
        return;
    }
    conn.dc.send(JSON.stringify({ type: 'file-selecting', action: action }));
    addLog('[文件选择] 通知 ' + peerId + ': ' + action);
}

// ========== Toast 提示 ==========
var _toastTimer = null;
function _showToast(text, durationMs) {
    var container = document.getElementById('toastContainer');
    var message = document.getElementById('toastMessage');
    if (!container || !message) return;
    if (_toastTimer) clearTimeout(_toastTimer);

    message.textContent = text;
    container.classList.remove('hidden');
    // 重置动画
    container.style.animation = 'none';
    container.offsetHeight; // reflow
    container.style.animation = 'toastSlideIn 0.3s ease, toastSlideOut 0.3s ease ' + ((durationMs - 300) / 1000).toFixed(1) + 's forwards';

    _toastTimer = setTimeout(function () {
        container.classList.add('hidden');
        _toastTimer = null;
    }, durationMs);
}

// ========== 预选文件：暂存 / 清空 / 自动上传 ==========

// 加入暂存队列（支持多次点击、多选累积）
function stageFiles(files) {
    if (!files || !files.length) return;
    for (var i = 0; i < files.length; i++) _stagedFiles.push(files[i]);
    _updateStageBtnUI();

    var names = [];
    for (var j = 0; j < files.length; j++) names.push(files[j].name);
    addLog('[暂存] 已加入 ' + files.length + ' 个文件，队列共 ' + _stagedFiles.length + ' 个');
    _showToast('已暂存 ' + (files.length === 1 ? names[0] : files.length + ' 个文件') +
               '，连接成功后将自动上传', 2600);

    // 若已经存在可用连接，立即上传（不等到下次建连）
    var target = _pickFlushTarget();
    if (target) flushStagedFiles(target);
}

// 选择暂存文件的发送目标：
//  1. 优先当前正在查看的对话
//  2. 否则退回任一数据通道已打开的连接（例如已连上后切回首页再暂存的情况）
function _pickFlushTarget() {
    if (activePeerId && connections[activePeerId]) return activePeerId;
    for (var k in connections) {
        if (!connections.hasOwnProperty(k)) continue;
        var c = connections[k];
        if (c && c.dc && c.dc.readyState === 'open') return k;
    }
    return null;
}

// 清空暂存队列
function clearStagedFiles(silent) {
    var n = _stagedFiles.length;
    _stagedFiles = [];
    _updateStageBtnUI();
    if (n > 0 && !silent) {
        addLog('[暂存] 已清空 ' + n + ' 个暂存文件');
        _showToast('已清空暂存文件', 1800);
    }
}

// 连接就绪 / 上一次传输结束后调用：把队列头部的文件发出去
function flushStagedFiles(peerId) {
    if (!_stagedFiles.length) return false;

    var conn = connections[peerId];
    if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
        addLog('[暂存上传] 数据通道未就绪，暂存文件等待连接恢复后自动上传');
        return false;
    }
    // 已有传输在跑 → 等它结束后由 _drainStagedQueue 续传
    if (_tf[peerId]) {
        addLog('[暂存上传] 当前有传输进行中，暂存文件将在其结束后自动上传');
        return false;
    }

    var file = _stagedFiles.shift();
    _stagedActiveFile = file;
    _updateStageBtnUI();

    addLog('[暂存上传] 连接已就绪，开始自动上传: ' + file.name + ' (' + _fmtSize(file.size) + ')');

    if (!sendFileOverDC(conn.dc, file, peerId)) {
        // 极端情况被拒（已有传输）→ 放回队列，避免丢文件
        _stagedFiles.unshift(file);
        _stagedActiveFile = null;
        _updateStageBtnUI();
        return false;
    }
    return true;
}

// 一次传输正常结束后收尾：清掉在途标记，若队列还有文件则继续上传
function _drainStagedQueue(peerId) {
    _stagedActiveFile = null;
    if (!_stagedFiles.length) { _updateStageBtnUI(); return; }
    flushStagedFiles(peerId);
}

// 更新按钮高亮与角标
function _updateStageBtnUI() {
    var btn = document.getElementById('stageFileBtn');
    var badge = document.getElementById('stageFileBadge');
    if (!btn) return;
    var n = _stagedFiles.length;
    if (n > 0) {
        btn.classList.add('has-files');
        if (badge) badge.textContent = n > 99 ? '99+' : String(n);
    } else {
        btn.classList.remove('has-files');
        if (badge) badge.textContent = '0';
    }
}

// ========== 拍照功能 ==========
function _openCamera(peerId) {
    var overlay = document.getElementById('cameraOverlay');
    var video = document.getElementById('cameraVideo');
    if (!overlay || !video) return;

    overlay.classList.remove('hidden');
    overlay.setAttribute('data-peerid', peerId);

    var constraints = {
        video: {
            facingMode: 'environment',
            width: { ideal: 1920 },
            height: { ideal: 1080 }
        },
        audio: false
    };

    navigator.mediaDevices.getUserMedia(constraints)
        .then(function (stream) {
            _cameraStream = stream;
            video.srcObject = stream;
            video.play();
            addLog('[拍照] 摄像头已启动');
        })
        .catch(function (err) {
            addLog('[拍照] 摄像头启动失败: ' + err.message);
            _closeCamera();
            _showToast('无法访问摄像头', 2000);
        });
}

function _closeCamera() {
    if (_cameraStream) {
        _cameraStream.getTracks().forEach(function (t) { t.stop(); });
        _cameraStream = null;
    }
    var overlay = document.getElementById('cameraOverlay');
    if (overlay) overlay.classList.add('hidden');
    var video = document.getElementById('cameraVideo');
    if (video) video.srcObject = null;
}

function _capturePhoto() {
    var overlay = document.getElementById('cameraOverlay');
    var peerId = overlay ? overlay.getAttribute('data-peerid') : null;
    var video = document.getElementById('cameraVideo');
    var canvas = document.getElementById('cameraCanvas');
    if (!video || !canvas || !peerId) return;

    var vw = video.videoWidth;
    var vh = video.videoHeight;
    if (vw === 0 || vh === 0) {
        _showToast('摄像头未就绪', 1500);
        return;
    }

    canvas.width = vw;
    canvas.height = vh;
    var ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, vw, vh);

    canvas.toBlob(function (blob) {
        if (!blob) {
            addLog('[拍照] 截图失败');
            return;
        }
        var timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        var file = new File([blob], 'photo_' + timestamp + '.jpg', { type: 'image/jpeg' });

        var conn = connections[peerId];
        if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
            addLog('[拍照] 数据通道未就绪，无法发送');
            _showToast('连接未就绪，发送失败', 2000);
            return;
        }
        sendFileOverDC(conn.dc, file, peerId);
        addPeerMessage(peerId, 'system', '已发送照片: ' + file.name);
        _closeCamera();
    }, 'image/jpeg', 0.85);
}

// ========== 拖放上传 ==========
var _dragCounter = 0; // 全局拖放层级计数器

function _setupDragDrop(container, peerId) {
    if (!container) return;

    // 容器级 dragover/dragenter：直接显示覆盖层
    container.addEventListener('dragenter', function (e) {
        e.preventDefault();
        if (_tf[peerId]) return;
        _dragActivePeerId = peerId;
        var overlay = document.getElementById('dragOverlay');
        if (overlay) overlay.classList.remove('hidden');
    });

    container.addEventListener('dragover', function (e) {
        e.preventDefault();
    });
}

// 全局拖放事件（只绑定一次）
var _globalDragWired = false;
function _wireGlobalDragDrop() {
    if (_globalDragWired) return;
    _globalDragWired = true;

    var dragOverlay = document.getElementById('dragOverlay');

    document.addEventListener('dragenter', function (e) {
        e.preventDefault();
        _dragCounter++;
        // 有活跃的聊天窗口才显示拖放覆盖层
        if (_dragActivePeerId && dragOverlay) {
            dragOverlay.classList.remove('hidden');
        }
    });

    document.addEventListener('dragover', function (e) {
        e.preventDefault();
    });

    document.addEventListener('dragleave', function (e) {
        e.preventDefault();
        _dragCounter--;
        if (_dragCounter <= 0) {
            _dragCounter = 0;
            if (dragOverlay) dragOverlay.classList.add('hidden');
        }
    });

    document.addEventListener('drop', function (e) {
        e.preventDefault();
        _dragCounter = 0;
        if (dragOverlay) dragOverlay.classList.add('hidden');

        var files = e.dataTransfer.files;
        var peerId = _dragActivePeerId;
        // 验证目标对等端聊天窗口仍处于激活状态
        if (peerId) {
            var activeContainer = document.querySelector('#peerTabs .peer-chat-container.active[data-peerid="' + peerId + '"]');
            if (!activeContainer) peerId = null;
        }
        if (!files || files.length === 0 || !peerId) return;

        var conn = connections[peerId];
        if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
            addLog('[拖放] 数据通道未就绪，无法发送');
            _showToast('连接未就绪，请稍后重试', 2000);
            return;
        }

        for (var i = 0; i < files.length; i++) {
            sendFileOverDC(conn.dc, files[i], peerId);
        }
        addLog('[拖放] 已发送 ' + files.length + ' 个文件');
    });
}

// ========== 对外入口：发送文件 ==========
// 返回值：true=已开始传输，false=被忽略（已有传输进行中）
function sendFileOverDC(dcChannel, file, peerId) {
    if (_tf[peerId]) {
        addLog('[传输] 已有传输进行中，忽略');
        return false;
    }

    var totalChunks = Math.ceil(file.size / CHUNK_SIZE);

    _tf[peerId] = {
        direction: 'send',
        file: file,
        fileName: file.name,
        fileSize: file.size,
        totalChunks: totalChunks,
        chunkSize: CHUNK_SIZE,
        sentCount: 0,
        ackedCount: 0,
        channels: [],
        _startTime: Date.now(),
        _lastSendTime: Date.now(),
        _lastAckTime: 0,
        _stallTimer: 0
    };

    dcChannel.send(JSON.stringify({
        type: 'transfer-header',
        name: file.name,
        size: file.size,
        totalChunks: totalChunks,
        chunkSize: CHUNK_SIZE,
        channelCount: CHANNEL_COUNT,
        channelIds: TF_CHANNEL_IDS
    }));

    _showProgress(peerId, file.name, file.size);
    addPeerMessage(peerId, 'system', '准备发送: ' + file.name + ' (' + _fmtSize(file.size) + ', ' + totalChunks + ' 块)');
    return true;
}

// ========================================================================
//  发送端
// ========================================================================

// transfer-ready → 创建并发数据通道并开始发送
function _onTransferReady(peerId) {
    var s = _tf[peerId];
    if (!s || s.direction !== 'send') return;

    addLog('[传输] 对方已就绪，建立 ' + CHANNEL_COUNT + ' 路并发通道...');

    var file = s.file;
    var assignedChunks = _splitChunks(s.totalChunks, CHANNEL_COUNT);
    var sendPc = (connections[peerId] && connections[peerId].pc) ? connections[peerId].pc : pc;

    // 使用协商通道（negotiated:true），双方用相同 ID，无需信令
    for (var i = 0; i < CHANNEL_COUNT; i++) {
        var label = 'tf-ch-' + i;
        var chId = TF_CHANNEL_IDS[i];
        try {
            var ch = sendPc.createDataChannel(label, {
                negotiated: true,
                id: chId,
                ordered: true
            });
            ch.binaryType = 'arraybuffer';
            _setupSendChannel(peerId, ch, i, assignedChunks[i]);
            s.channels.push({
                dc: ch,
                label: label,
                window: INIT_WINDOW,
                inFlight: 0,
                nextChunk: assignedChunks[i][0],
                endChunk: assignedChunks[i][1]
            });
        } catch (err) {
            addLog('[传输] 创建通道 ' + label + ' 失败: ' + err);
        }
    }

    // 等待通道就绪后开始泵送
    _waitChannelsAndPump(peerId);
}

// 切分 chunk 范围到各通道（轮询分配）
function _splitChunks(total, ways) {
    var ranges = [];
    for (var w = 0; w < ways; w++) ranges.push([-1, -1]); // [start, end]

    for (var i = 0; i < total; i++) {
        var w = i % ways;
        if (ranges[w][0] === -1) ranges[w][0] = i;
        ranges[w][1] = i;
    }
    return ranges;  // 未分配到任务的通道为 [-1, -1]
}

// 建立单条发送通道的事件
function _setupSendChannel(peerId, ch, idx, range) {
    ch.onopen = function () {
        addLog('[传输] 发送通道 ' + idx + ' 已打开');
    };
    ch.onclose = function () {
        addLog('[传输] 发送通道 ' + idx + ' 关闭');
    };
    // bufferedamountlow — 缓冲区排空后自动恢复泵送
    try { ch.bufferedAmountLowThreshold = 256 * 1024; } catch (e) { }
    ch.onbufferedamountlow = function () {
        var s = _tf[peerId];
        if (!s) return;
        if (s.sentCount - s.ackedCount < MAX_PIPELINE) {
            _pumpChannel(peerId, idx);
        }
    };
}

// 等待所有协商通道打开后启动泵送
function _waitChannelsAndPump(peerId) {
    var s = _tf[peerId];
    if (!s) return;

    var checkAllOpen = function () {
        if (!_tf[peerId]) return;
        var s2 = _tf[peerId];
        var allOpen = true;
        for (var i = 0; i < s2.channels.length; i++) {
            if (!s2.channels[i].dc || s2.channels[i].dc.readyState !== 'open') {
                allOpen = false;
                break;
            }
        }
        if (allOpen) {
            addLog('[传输] ' + s2.channels.length + ' 路并发通道全部就绪');
            for (var j = 0; j < s2.channels.length; j++) {
                _pumpChannel(peerId, j);
            }
            _startStallDetector(peerId);
        } else {
            setTimeout(checkAllOpen, 100);
        }
    };
    setTimeout(checkAllOpen, 200);
}

// 单通道泵送（核心发送循环）
function _pumpChannel(peerId, chIdx) {
    var s = _tf[peerId];
    if (!s) return;
    var ci = s.channels[chIdx];
    if (!ci) return;

    var file = s.file;
    var isResume = !!ci._missingList;
    var step = isResume ? 1 : CHANNEL_COUNT;  // 恢复模式走缺失列表，初始模式走轮询步长

    while (ci.inFlight < ci.window && ci.nextChunk <= ci.endChunk) {
        // 全局管道保护
        if (s.sentCount - s.ackedCount >= MAX_PIPELINE) return;

        // 单通道缓冲区软控 — 满了就退避，不卡死
        if (ci.dc.bufferedAmount > BUFFER_SOFT_CAP) {
            ci.window = Math.max(MIN_WINDOW, ci.window - 1);
            return;
        }

        var realChunkIdx;
        if (isResume) {
            realChunkIdx = ci._missingList[ci.nextChunk];
            if (realChunkIdx === undefined) { ci.nextChunk++; continue; }
        } else {
            realChunkIdx = ci.nextChunk;
        }

        ci.inFlight++;
        ci.nextChunk += step;

        var offset = realChunkIdx * CHUNK_SIZE;
        var rawData = file.slice(offset, Math.min(offset + CHUNK_SIZE, file.size));

        var reader = new FileReader();
        (function (cIdx, rChunk, cData) {
            reader.onload = async function (re) {
                var payload = new Uint8Array(re.target.result);

                var flags = 0;
                if (payload.length >= 512) {
                    var compressed = await _compress(payload);
                    if (compressed && compressed.length < payload.length) {
                        payload = compressed;
                        flags = 1;
                    }
                }

                var header = new ArrayBuffer(5);
                new DataView(header).setUint32(0, rChunk, false);
                new DataView(header).setUint8(4, flags);
                var frame = new Uint8Array(5 + payload.length);
                frame.set(new Uint8Array(header), 0);
                frame.set(payload, 5);

                if (!_tf[peerId]) return;
                var sNow = _tf[peerId];
                var sci = sNow.channels[cIdx];
                if (!sci) return;

                try {
                    sci.dc.send(frame.buffer);
                } catch (e) {
                    addLog('[传输] 通道 ' + cIdx + ' 发送失败: ' + e);
                    return;
                }

                sNow.sentCount++;
                sNow._lastSendTime = Date.now();

                // 发送端进度 = 接收端确认数（双方进度一致）
                _updateProgress(peerId, sNow.ackedCount, sNow.totalChunks);

                // 管道有余量 → 继续泵送
                if (sNow.sentCount - sNow.ackedCount < MAX_PIPELINE) {
                    _pumpChannel(peerId, cIdx);
                }
            };
            reader.readAsArrayBuffer(cData);
        })(chIdx, realChunkIdx, rawData);
    }
}

// 收到 ACK → 更新进度、减小 inFlight、调整窗口、继续泵送
function _onTransferAck(peerId, msg) {
    var s = _tf[peerId];
    if (!s || s.direction !== 'send') return;

    var oldAcked = s.ackedCount;
    s.ackedCount = msg.receivedCount;
    var delta = s.ackedCount - oldAcked;
    if (delta <= 0) return;

    s._lastAckTime = Date.now();

    // 发送端进度 = 接收端确认数
    _updateProgress(peerId, s.ackedCount, s.totalChunks);

    var pipeline = s.sentCount - s.ackedCount;

    // 更精准的 inFlight 分配：按各通道窗口占比
    var totalWindow = 0;
    for (var i = 0; i < s.channels.length; i++) {
        if (s.channels[i]) totalWindow += s.channels[i].window;
    }
    for (var i = 0; i < s.channels.length; i++) {
        var ci = s.channels[i];
        if (!ci) continue;
        var share = totalWindow > 0 ? ci.window / totalWindow : 1 / s.channels.length;
        ci.inFlight = Math.max(0, Math.ceil(pipeline * share));

        // 窗口自适应
        if (pipeline < MAX_PIPELINE / 3) {
            ci.window = Math.min(MAX_WINDOW, ci.window + 1);  // 通畅 → 逐步扩窗
        } else if (pipeline > MAX_PIPELINE * 0.7) {
            ci.window = Math.max(MIN_WINDOW, ci.window - 1);  // 拥堵 → 逐步缩窗
        }
    }

    // 管道未满 → 继续泵送所有通道
    if (pipeline < MAX_PIPELINE) {
        for (var j = 0; j < s.channels.length; j++) {
            _pumpChannel(peerId, j);
        }
    }
}

// receiver 确认收到全部 chunk
function _onTransferComplete(peerId) {
    var s = _tf[peerId];
    if (!s) return;

    var elapsed = (Date.now() - s._startTime) / 1000;
    var speed = s.fileSize / elapsed;
    addPeerMessage(peerId, 'system', '发送完成: ' + s.fileName + ' (' + _fmtSpeed(speed) + ')');
    _updateProgress(peerId, s.totalChunks, s.totalChunks);
    _hideProgress(peerId, 2000);
    _cleanupTransfer(peerId);
    // 暂存队列：本次传完，继续发下一个
    _drainStagedQueue(peerId);
}

// ========================================================================
//  接收端
// ========================================================================

// 收到 transfer-header → modal → save dialog → ready
async function _onTransferHeader(peerId, msg) {
    var conn = connections[peerId];

    // 弹出确认框（提供用户手势，showSaveFilePicker 必需）
    if (window.showModal) {
        var ok = await window.showModal(
            '文件传输请求',
            peerId + ' 想要发送: ' + msg.name + ' (' + _fmtSize(msg.size) + ')',
            '📁'
        );
        if (!ok) {
            addPeerMessage(peerId, 'system', '拒绝接收');
            if (conn && conn.dc) {
                conn.dc.send(JSON.stringify({ type: 'transfer-cancel' }));
            }
            return;
        }
    }

    // 优先 File System Access API（随机写入），否则 StreamSaver（顺序流）
    var writable = null;
    var fileHandle = null;
    var streamWriter = null;

    if (window.showSaveFilePicker) {
        try {
            fileHandle = await window.showSaveFilePicker({ suggestedName: msg.name });
            writable = await fileHandle.createWritable();
        } catch (e) {
            addLog('[传输] 用户取消保存: ' + e);
            addPeerMessage(peerId, 'system', '接收已取消');
            if (conn && conn.dc) {
                conn.dc.send(JSON.stringify({ type: 'transfer-cancel' }));
            }
            return;
        }
    } else if (window.streamSaver) {
        try {
            var ws = window.streamSaver.createWriteStream(msg.name, { size: msg.size });
            streamWriter = ws.getWriter();
            addLog('[传输] StreamSaver 流式落盘（' + _fmtSize(msg.size) + '）');
        } catch (e) {
            addLog('[传输] StreamSaver 初始化失败: ' + e);
        }
    }

    // 无流式写入能力 → 拒绝传输
    if (!writable && !streamWriter) {
        addPeerMessage(peerId, 'system', '接收失败: 浏览器不支持流式写入，请使用 Chrome 或 Firefox');
        if (conn && conn.dc) {
            conn.dc.send(JSON.stringify({ type: 'transfer-cancel' }));
        }
        return;
    }

    var totalChunks = msg.totalChunks;

    _tf[peerId] = {
        direction: 'receive',
        fileName: msg.name,
        fileSize: msg.size,
        totalChunks: totalChunks,
        chunkSize: msg.chunkSize || CHUNK_SIZE,
        receivedMask: new Array(totalChunks),
        receivedCount: 0,
        writable: writable,
        fileHandle: fileHandle,
        _writesInFlight: 0,
        _writeQueue: [],                       // [{ idx, data }] — writable 路径
        _streamWriter: streamWriter,           // StreamSaver writer
        _streamBuffer: streamWriter ? {} : null,  // { chunkIdx: data } 重排缓冲
        _streamNextIdx: 0,
        _streamWriteChain: Promise.resolve(),
        _startTime: Date.now(),
        _lastAckTime: 0,
        _lastAckCount: 0
    };

    _showProgress(peerId, msg.name, msg.size);
    var modeLabel = streamWriter ? ' (StreamSaver)' : '';
    addPeerMessage(peerId, 'system', '开始接收: ' + msg.name + ' (' + _fmtSize(msg.size) + ', ' + totalChunks + ' 块' + modeLabel + ')');

    // 创建协商数据通道（与发送端使用相同 ID）
    var chCount = msg.channelCount || CHANNEL_COUNT;
    var chIds = msg.channelIds || TF_CHANNEL_IDS;
    var recvPc = conn && conn.pc ? conn.pc : pc;
    for (var i = 0; i < chCount; i++) {
        try {
            var ch = recvPc.createDataChannel('tf-ch-' + i, {
                negotiated: true,
                id: chIds[i],
                ordered: true
            });
            ch.binaryType = 'arraybuffer';
            _setupRecvChannel(peerId, ch, i);
        } catch (e) {
            addLog('[传输] 创建接收通道 ' + i + ' 失败: ' + e);
        }
    }

    // 通知发送端就绪
    if (conn && conn.dc) {
        conn.dc.send(JSON.stringify({ type: 'transfer-ready' }));
    }
}

// 建立接收端数据通道监听
function _setupRecvChannel(peerId, channel, idx) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = function () {
        addLog('[传输] 接收通道 ' + idx + ' 已打开');
    };
    channel.onclose = function () {
        addLog('[传输] 接收通道 ' + idx + ' 关闭');
    };
    channel.onmessage = function (e) {
        if (!(e.data instanceof ArrayBuffer)) return;
        if (!_tf[peerId]) return;

        var data = new Uint8Array(e.data);
        if (data.length < 5) return;

        // 解析帧头：[4B chunkIdx BE] [1B flags] [payload...]
        var headerView = new DataView(data.buffer, data.byteOffset, 5);
        var chunkIdx = headerView.getUint32(0, false);
        var flags = headerView.getUint8(4);
        var payload = data.slice(5);

        var s = _tf[peerId];
        if (!s) return;

        // 去重
        if (s.receivedMask[chunkIdx]) return;
        s.receivedMask[chunkIdx] = true;

        // 解压
        if (flags & 1) {
            _decompress(payload).then(function (decompressed) {
                _writeChunk(peerId, chunkIdx, decompressed);
            }).catch(function () {
                _writeChunk(peerId, chunkIdx, payload);
            });
        } else {
            _writeChunk(peerId, chunkIdx, payload);
        }
    };
}

// ====== 接收端写入（流式 + 边界并发 + 背压） ======

// 写入一个 chunk → File System Access API / StreamSaver
function _writeChunk(peerId, chunkIdx, data) {
    var s = _tf[peerId];
    if (!s) return;

    if (s.writable) {
        // 边界并发随机写入（带背压）
        if (s._writesInFlight >= MAX_CONCURRENT_WRITES) {
            s._writeQueue.push({ idx: chunkIdx, data: data });
            return;
        }
        _executeWrite(peerId, chunkIdx, data);
    } else if (s._streamWriter) {
        // 顺序流式写入（带重排缓冲）
        _streamWrite(peerId, chunkIdx, data);
    }
}

// File System Access API：执行单次随机位置写入
function _executeWrite(peerId, chunkIdx, data) {
    var s = _tf[peerId];
    if (!s) return;
    s._writesInFlight++;
    var offset = chunkIdx * s.chunkSize;
    s.writable.write({ type: 'write', position: offset, data: data })
        .then(function () {
            s._writesInFlight--;
            _onChunkWritten(peerId, chunkIdx);
            _drainWrites(peerId);
        })
        .catch(function (e) {
            s._writesInFlight--;
            addLog('[传输] 写入失败: ' + e);
            _drainWrites(peerId);
        });
}

// 排空写入等待队列
function _drainWrites(peerId) {
    var s = _tf[peerId];
    if (!s) return;
    while (s._writesInFlight < MAX_CONCURRENT_WRITES && s._writeQueue.length > 0) {
        var item = s._writeQueue.shift();
        _executeWrite(peerId, item.idx, item.data);
    }
}

// StreamSaver 顺序流式写入（自动重排乱序 chunk）
function _streamWrite(peerId, chunkIdx, data) {
    var s = _tf[peerId];
    if (!s) return;

    if (chunkIdx === s._streamNextIdx) {
        s._streamWriteChain = s._streamWriteChain.then(function () {
            return s._streamWriter.write(data);
        }).then(function () {
            _onChunkWritten(peerId, chunkIdx);
            s._streamNextIdx++;
            return _streamDrain(peerId);
        }).catch(function (e) {
            addLog('[传输] 流写入失败: ' + e);
        });
    } else if (chunkIdx > s._streamNextIdx) {
        s._streamBuffer[chunkIdx] = data;
    }
    // chunkIdx < _streamNextIdx → 已写过，忽略（去重已处理）
}

// 排空 StreamSaver 重排缓冲中的连续 chunk
function _streamDrain(peerId) {
    var s = _tf[peerId];
    if (!s) return Promise.resolve();

    function drainNext() {
        var chunkData = s._streamBuffer[s._streamNextIdx];
        if (chunkData !== undefined) {
            var idx = s._streamNextIdx;
            delete s._streamBuffer[idx];
            return s._streamWriter.write(chunkData).then(function () {
                _onChunkWritten(peerId, idx);
                s._streamNextIdx++;
                return drainNext();
            });
        }
        return Promise.resolve();
    }
    return drainNext();
}

// 单个 chunk 写入完成 → 更新进度 + 可能发 ACK
function _onChunkWritten(peerId, chunkIdx) {
    var s = _tf[peerId];
    if (!s) return;

    s.receivedCount++;
    _updateProgress(peerId, s.receivedCount, s.totalChunks);

    // ACK 节流
    var now = Date.now();
    var sinceLastAck = s.receivedCount - s._lastAckCount;
    if (sinceLastAck >= ACK_CHUNK_STEP || (now - s._lastAckTime > ACK_INTERVAL_MS && sinceLastAck > 0)) {
        s._lastAckTime = now;
        s._lastAckCount = s.receivedCount;

        var conn = connections[peerId];
        if (conn && conn.dc && conn.dc.readyState === 'open') {
            conn.dc.send(JSON.stringify({
                type: 'transfer-ack',
                receivedCount: s.receivedCount
            }));
        }
    }

    // 全部收齐 → 完成
    if (s.receivedCount >= s.totalChunks) {
        _finishReceive(peerId);
    }
}

// 接收完成
async function _finishReceive(peerId) {
    var s = _tf[peerId];
    if (!s) return;

    if (s.writable) {
        if (s._writesInFlight > 0) {
            await new Promise(function (r) { setTimeout(r, 100); });
        }
        try { await s.writable.close(); } catch (e) { }
    } else if (s._streamWriter) {
        s._streamWriteChain = s._streamWriteChain.then(function () {
            return s._streamWriter.close();
        }).catch(function () {});
        try { await s._streamWriteChain; } catch (e) { }
    }

    var elapsed = (Date.now() - s._startTime) / 1000;
    var speed = s.fileSize / elapsed;
    _updateProgress(peerId, s.totalChunks, s.totalChunks);
    addPeerMessage(peerId, 'system', '接收完成: ' + s.fileName + ' (' + _fmtSpeed(speed) + ')');

    // 通知发送端
    var conn = connections[peerId];
    if (conn && conn.dc && conn.dc.readyState === 'open') {
        conn.dc.send(JSON.stringify({ type: 'transfer-complete' }));
    }

    _hideProgress(peerId, 2500);
    _cleanupTransfer(peerId);
    // 接收结束后，若本端也有暂存文件则接着上传
    _drainStagedQueue(peerId);
}

// ========================================================================
//  断点续传
// ========================================================================

// 连接恢复时调用（外部可触发）
function tryResumeTransfer(peerId, channel) {
    var s = _tf[peerId];
    if (!s || s.direction !== 'receive' || s.receivedCount >= s.totalChunks) return false;

    // 收集缺失的 chunk 索引
    var missing = [];
    for (var i = 0; i < s.totalChunks; i++) {
        if (!s.receivedMask[i]) missing.push(i);
    }

    if (missing.length === 0) {
        // 理论上不该到这里（receivedCount < totalChunks 但有 mask 全满）
        _finishReceive(peerId);
        return true;
    }

    addLog('[传输] 断点续传: 已收 ' + s.receivedCount + '/' + s.totalChunks + '，缺 ' + missing.length + ' 块');
    // 发送续传请求（发送端收到 transfer-resume 后重新发送缺失块）
    channel.send(JSON.stringify({
        type: 'transfer-resume',
        receivedCount: s.receivedCount,
        totalChunks: s.totalChunks,
        missingChunks: missing  // 直接列出缺失的块
    }));
    return true;
}

// 发送端收到断点续传请求
function _onTransferResume(peerId, msg) {
    var s = _tf[peerId];
    if (!s || s.direction !== 'send') return;

    var missing = msg.missingChunks;
    if (!missing || missing.length === 0) {
        _onTransferComplete(peerId);
        return;
    }

    addLog('[传输] 断点续传: 缺失 ' + missing.length + ' 块');

    s.ackedCount = msg.receivedCount;
    s.sentCount = msg.receivedCount;
    s.channels = [];

    // 将缺失块切片分配到各通道
    var assigned = _splitChunks(missing.length, CHANNEL_COUNT);
    var resumePc = (connections[peerId] && connections[peerId].pc) ? connections[peerId].pc : pc;

    for (var i = 0; i < CHANNEL_COUNT; i++) {
        var range = assigned[i];
        var startIdx = (range[0] >= 0 && range[0] < missing.length) ? range[0] : -1;
        var endIdx   = (range[1] >= 0 && range[1] < missing.length) ? range[1] : -1;

        try {
            var ch = resumePc.createDataChannel('tf-ch-' + i, {
                negotiated: true, id: TF_CHANNEL_IDS[i], ordered: true
            });
            ch.binaryType = 'arraybuffer';
            _setupSendChannel(peerId, ch, i, [startIdx >= 0 ? missing[startIdx] : -1, endIdx >= 0 ? missing[endIdx] : -1]);

            s.channels.push({
                dc: ch, label: 'tf-ch-' + i, window: INIT_WINDOW,
                inFlight: 0,
                nextChunk: startIdx,
                endChunk: endIdx,
                _missingList: missing
            });
        } catch (e) {
            addLog('[传输] 续传通道 ' + i + ' 创建失败: ' + e);
        }
    }

    _waitChannelsAndPumpResume(peerId);
}

// 续传版本：等待通道就绪后泵送
function _waitChannelsAndPumpResume(peerId) {
    var s = _tf[peerId];
    if (!s) return;
    var check = function () {
        if (!_tf[peerId]) return;
        var s2 = _tf[peerId];
        var allOpen = true;
        for (var i = 0; i < s2.channels.length; i++) {
            if (!s2.channels[i].dc || s2.channels[i].dc.readyState !== 'open') { allOpen = false; break; }
        }
        if (allOpen) {
            for (var j = 0; j < s2.channels.length; j++) _pumpChannel(peerId, j);
            _startStallDetector(peerId);
        } else {
            setTimeout(check, 100);
        }
    };
    setTimeout(check, 200);
}

// ========================================================================
//  压缩
// ========================================================================

async function _compress(data) {
    try {
        var cs = new CompressionStream('gzip');
        var writer = cs.writable.getWriter();
        var reader = cs.readable.getReader();
        writer.write(data);
        writer.close();
        var chunks = [];
        while (true) {
            var r = await reader.read();
            if (r.done) break;
            chunks.push(r.value);
        }
        if (chunks.length === 1) return new Uint8Array(chunks[0]);
        var total = 0;
        for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
        var out = new Uint8Array(total);
        var off = 0;
        for (var j = 0; j < chunks.length; j++) {
            out.set(new Uint8Array(chunks[j]), off);
            off += chunks[j].byteLength;
        }
        return out;
    } catch (e) {
        return null;  // 压缩失败则返回原数据
    }
}

async function _decompress(data) {
    var ds = new DecompressionStream('gzip');
    var writer = ds.writable.getWriter();
    var reader = ds.readable.getReader();
    writer.write(data);
    writer.close();
    var chunks = [];
    while (true) {
        var r = await reader.read();
        if (r.done) break;
        chunks.push(r.value);
    }
    if (chunks.length === 1) return new Uint8Array(chunks[0]);
    var total = 0;
    for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
    var out = new Uint8Array(total);
    var off = 0;
    for (var j = 0; j < chunks.length; j++) {
        out.set(new Uint8Array(chunks[j]), off);
        off += chunks[j].byteLength;
    }
    return out;
}

// ========================================================================
//  辅助
// ========================================================================

function _startStallDetector(peerId) {
    var s = _tf[peerId];
    if (!s || s.direction !== 'send') return;
    if (s._stallTimer) clearTimeout(s._stallTimer);

    s._stallTimer = setTimeout(function () {
        if (!_tf[peerId]) return;
        var s2 = _tf[peerId];
        if (s2.direction !== 'send') return;

        var now = Date.now();
        var sinceSend = now - (s2._lastSendTime || now);
        var sinceAck  = s2._lastAckTime ? now - s2._lastAckTime : Infinity;

        // 超过停顿阈值且管道未满 → 强制重试泵送
        if (sinceSend > STALL_TIMEOUT_MS && s2.sentCount - s2.ackedCount < MAX_PIPELINE) {
            addLog('[传输] 检测到停顿，强制恢复泵送...');
            for (var j = 0; j < s2.channels.length; j++) {
                var ci = s2.channels[j];
                if (ci) {
                    ci.window = Math.max(MIN_WINDOW, ci.window);
                    _pumpChannel(peerId, j);
                }
            }
        }

        // 继续下一次检测
        if (s2.sentCount < s2.totalChunks || s2.ackedCount < s2.totalChunks) {
            _startStallDetector(peerId);
        }
    }, STALL_TIMEOUT_MS);
}

function _abortTransfer(peerId) {
    // 暂存文件传输被中断（多为移动端切后台导致 DC 断开）→ 放回队列头部，
    // 待连接恢复、聊天界面重新打开时自动重传，不丢文件。
    if (_stagedActiveFile) {
        addLog('[暂存上传] 上传中断，已重新加入队列: ' + _stagedActiveFile.name);
        _stagedFiles.unshift(_stagedActiveFile);
        _stagedActiveFile = null;
        _updateStageBtnUI();
        _showToast('上传中断，文件已保留，重连后自动重传', 2600);
    }
    _cleanupTransfer(peerId);
    _hideProgress(peerId, 0);
}

function _cleanupTransfer(peerId) {
    var s = _tf[peerId];
    if (!s) return;
    if (s._stallTimer) { clearTimeout(s._stallTimer); s._stallTimer = 0; }
    if (s.channels) {
        for (var i = 0; i < s.channels.length; i++) {
            try { if (s.channels[i].dc) s.channels[i].dc.close(); } catch (e) { }
        }
    }
    if (s.writable) {
        try { s.writable.abort(); } catch (e) { }
    }
    if (s._streamWriter) {
        try { s._streamWriter.abort(); } catch (e) { }
    }
    // 释放缓冲
    s._writeQueue = null;
    s._streamBuffer = null;
    s._streamWriteChain = null;
    delete _tf[peerId];
}

// ========================================================================
//  进度条 UI
// ========================================================================

var _lastProgTime = {};
var _progHideTimer = {};

function _showProgress(peerId, name, size) {
    var bar = _getBar(peerId);
    if (!bar) return;
    bar.classList.remove('hidden');
    var ne = bar.querySelector('.transfer-progress-name');
    var fi = bar.querySelector('.transfer-progress-fill');
    var pe = bar.querySelector('.transfer-progress-percent');
    var se = bar.querySelector('.transfer-progress-speed');
    if (ne) ne.textContent = name + ' (' + _fmtSize(size) + ')';
    if (fi) fi.style.width = '0%';
    if (pe) pe.textContent = '0%';
    if (se) se.textContent = '';
    _lastProgTime[peerId] = 0;
}

function _updateProgress(peerId, chunks, total) {
    var now = Date.now();
    var pct = (chunks / total) * 100;
    // 节流：每 100ms 更新一次（100% 立刻更新）
    if (now - (_lastProgTime[peerId] || 0) < 100 && chunks < total) return;
    _lastProgTime[peerId] = now;

    var bar = _getBar(peerId);
    if (!bar) return;

    var fi = bar.querySelector('.transfer-progress-fill');
    var pe = bar.querySelector('.transfer-progress-percent');
    var se = bar.querySelector('.transfer-progress-speed');

    if (fi) fi.style.width = pct.toFixed(1) + '%';
    if (pe) pe.textContent = pct.toFixed(1) + '%';

    var s = _tf[peerId];
    if (s && se && chunks < total) {
        var elapsed = (now - (s._startTime || now)) / 1000;
        if (elapsed > 0.5) {
            var bytesDone = chunks * s.chunkSize;
            var speed = bytesDone / elapsed;
            var remaining = (total - chunks) * s.chunkSize;
            var eta = speed > 0 ? remaining / speed : 0;
            se.textContent = _fmtSize(speed) + '/s  剩余 ' + _fmtTime(eta);
        }
    }
    if (chunks >= total && se) {
        var e = s ? (now - (s._startTime || now)) / 1000 : 0;
        var avg = e > 0 ? (s ? s.fileSize / e : 0) : 0;
        se.textContent = '完成  ' + _fmtSize(avg) + '/s  耗时 ' + _fmtTime(e);
    }
}

function _hideProgress(peerId, delayMs) {
    if (_progHideTimer[peerId]) clearTimeout(_progHideTimer[peerId]);
    var fn = function () {
        var bar = _getBar(peerId);
        if (bar) bar.classList.add('hidden');
        delete _lastProgTime[peerId];
    };
    _progHideTimer[peerId] = delayMs > 0 ? setTimeout(fn, delayMs) : null;
    if (delayMs <= 0) fn();
}

function _getBar(peerId) {
    return document.querySelector('#peerTabs .peer-chat-container[data-peerid="' + peerId + '"] .transfer-progress');
}

function _fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1073741824) return (bytes / 1048576).toFixed(1) + ' MB';
    return (bytes / 1073741824).toFixed(2) + ' GB';
}

function _fmtSpeed(bytesPerSec) {
    return _fmtSize(bytesPerSec) + '/s';
}

function _fmtTime(sec) {
    if (sec < 1) return '不足1秒';
    if (sec < 60) return Math.ceil(sec) + '秒';
    if (sec < 3600) return Math.floor(sec / 60) + '分' + Math.ceil(sec % 60) + '秒';
    return Math.floor(sec / 3600) + '小时' + Math.floor((sec % 3600) / 60) + '分';
}

// ========================================================================
//  聊天 UI（保持原有逻辑）
// ========================================================================

function createPeerChatContainer(peerId) {
    var template = document.getElementById('transferTemplate');
    if (!template) return null;
    var tabs = document.getElementById('peerTabs');
    if (!tabs) return null;

    var existing = tabs.querySelector('.peer-chat-container[data-peerid="' + peerId + '"]');
    if (existing) return existing;

    var container = template.querySelector('.peer-chat-container').cloneNode(true);
    container.setAttribute('data-peerid', peerId);
    container.querySelector('.transfer-peer-id').textContent = peerId;

    container.querySelector('.chat-menu-toggle').onclick = function () {
        if (window.toggleSidebar) window.toggleSidebar();
    };

    // 对话模式入口（对端是 AI 时才显示）
    var aiBtn = container.querySelector('.ai-mode-btn');
    if (aiBtn) {
        aiBtn.onclick = function () { _openAiPanel(peerId); };
    }

    var msgInput = container.querySelector('.message-input');
    var sendBtn  = container.querySelector('.send-msg-btn');
    var fileInput  = container.querySelector('.file-input');
    var fileLabel  = container.querySelector('.file-label-btn');
    var cameraBtn  = container.querySelector('.camera-btn');
    var cameraInput = container.querySelector('.camera-input');

    // 发送消息（DC未断开直接发；DC断开+Android选择中→灰泡缓存→重连后自动发送并变蓝）
    sendBtn.onclick = function () {
        var text = msgInput.value.trim();
        if (!text) return;
        var conn = connections[peerId];
        if (!conn || !conn.dc) {
            addLog('[发送失败] 数据通道未就绪');
            return;
        }

        // 分配本地序列号和时间戳
        if (!_chatSeq[peerId]) _chatSeq[peerId] = 0;
        _chatSeq[peerId]++;
        var seq = _chatSeq[peerId];
        var ts = Date.now();

        // 只要DC还开着，直接发送（不管对方是否在选择文件）
        if (conn.dc.readyState === 'open') {
            conn.dc.send(JSON.stringify({ type: 'chat', text: text, seq: seq, ts: ts }));
            addPeerMessage(peerId, 'self', text, ts, seq);
            msgInput.value = '';
            return;
        }

        // DC已断开 → 需要缓冲
        if (!_msgBuffer[peerId]) _msgBuffer[peerId] = [];
        // 灰色气泡（sendAndTrack会返回DOM引用用于后续恢复颜色）
        var el = addPeerMessage(peerId, 'self', text, ts, seq, true);
        _msgBuffer[peerId].push({ type: 'chat', text: text, seq: seq, ts: ts, el: el });
        addLog('[消息缓冲] DC断开，消息已缓存 #' + seq);
        msgInput.value = '';

        // 仅当是Android选择文件导致的断开才提示
        if (_peerSelectingFile[peerId]) {
            _showToast('对方在选择文件，消息将缓存延迟发送', 2500);
        }
    };
    msgInput.onkeypress = function (e) {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendBtn.onclick(); }
    };

    // 文件选择：先通知对方，再打开文件对话框
    fileLabel.onmousedown = function () {
        _announceFileSelecting(peerId, 'start');
    };
    fileLabel.ontouchstart = function () {
        _announceFileSelecting(peerId, 'start');
    };
    fileLabel.onclick = function () { fileInput.click(); };
    fileInput.onchange = function () {
        // 文件选择完成，通知对方
        _announceFileSelecting(peerId, 'end');

        if (fileInput.files.length) {
            var conn = connections[peerId];
            if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
                // DC已断开（如Android切后台导致），尝试ICE重启
                addLog('[发送] 数据通道未就绪，尝试ICE重启...');
                if (window.iceRestart) {
                    window.iceRestart(peerId).then(function (ok) {
                        if (ok) {
                            addLog('[ICE重启] 成功，继续发送文件');
                            var c2 = connections[peerId];
                            if (c2 && c2.dc && c2.dc.readyState === 'open') {
                                sendFileOverDC(c2.dc, fileInput.files[0], peerId);
                            } else {
                                addLog('[发送失败] ICE重启后DC仍未就绪');
                                _showToast('连接已断开，发送失败，请重试', 2500);
                            }
                        } else {
                            addLog('[ICE重启] 失败');
                            _showToast('连接断开，发送失败，请重试', 2500);
                        }
                        fileInput.value = '';
                    });
                    return;
                }
                addLog('[发送失败] 数据通道未就绪且ICE重启不可用');
                _showToast('连接未就绪，发送失败', 2000);
                fileInput.value = '';
                return;
            }
            sendFileOverDC(conn.dc, fileInput.files[0], peerId);
            fileInput.value = '';
        }
    };

    // 拍照按钮
    if (cameraBtn) {
        cameraBtn.onmousedown = function () {
            _announceFileSelecting(peerId, 'start');
        };
        cameraBtn.ontouchstart = function () {
            _announceFileSelecting(peerId, 'start');
        };
        cameraBtn.onclick = function () {
            // Android: 优先使用系统相机（capture属性），避免页面切后台断连
            // 桌面端: 使用页面内全屏拍照
            var isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
            if (isMobile && cameraInput) {
                cameraInput.click();
            } else {
                _openCamera(peerId);
            }
        };
    }
    if (cameraInput) {
        cameraInput.onchange = function () {
            _announceFileSelecting(peerId, 'end');
            if (cameraInput.files.length) {
                var conn = connections[peerId];
                if (!conn || !conn.dc || conn.dc.readyState !== 'open') {
                    if (window.iceRestart) {
                        window.iceRestart(peerId).then(function (ok) {
                            if (ok) {
                                var c2 = connections[peerId];
                                if (c2 && c2.dc && c2.dc.readyState === 'open') {
                                    sendFileOverDC(c2.dc, cameraInput.files[0], peerId);
                                }
                            }
                            cameraInput.value = '';
                        });
                        return;
                    }
                    _showToast('连接未就绪，发送失败', 2000);
                    cameraInput.value = '';
                    return;
                }
                sendFileOverDC(conn.dc, cameraInput.files[0], peerId);
                cameraInput.value = '';
            }
        };
    }

    tabs.appendChild(container);

    // 挂进文档之后再刷 —— _refreshAiButton 是按 data-peerid 在 #peerTabs 里查的，
    // 放在 appendChild 之前会查不到，按钮就永远不露出来。
    // （正常顺序下 _onChatReady 那边也会刷一次，这里管的是时序反过来的时候。）
    _refreshAiButton(peerId);

    // 启用拖放上传
    _setupDragDrop(container, peerId);

    if (connections[peerId] && connections[peerId].messages) {
        var msgs = connections[peerId].messages;
        connections[peerId].messages = [];
        for (var m = 0; m < msgs.length; m++) {
            addPeerMessage(peerId, msgs[m].sender, msgs[m].text, msgs[m].ts, msgs[m].seq);
        }
    }
    return container;
}

// ts / seq 为可选排序参数，buffered 为可选灰泡标记
// 返回 wrapper DOM 元素（用于后续恢复颜色）
function addPeerMessage(peerId, sender, text, ts, seq, buffered) {
    var container = document.querySelector('#peerTabs .peer-chat-container[data-peerid="' + peerId + '"]');
    if (!container) return null;
    var msgList = container.querySelector('.transfer-messages');
    if (!msgList) return null;

    var wrapper = document.createElement('div');
    if (sender === 'self') {
        wrapper.className = 'message-wrapper self-msg';
        if (buffered) wrapper.classList.add('buffered-msg');
    } else if (sender === 'system') {
        wrapper.className = 'message-wrapper system-msg';
    } else {
        wrapper.className = 'message-wrapper peer-msg';
    }

    // 设置排序属性（仅对用户消息）
    if (ts !== undefined) wrapper.setAttribute('data-ts', ts);
    if (seq !== undefined) wrapper.setAttribute('data-seq', seq);

    var bubble = document.createElement('div');
    bubble.className = 'message';
    // 富文本渲染（Markdown / ```chart / ```mermaid）。
    // 系统提示不走：那些是程序生成的一行人话（“对方已断开连接”之类），
    // 过一遍 Markdown 只会平白多套一层 <p>。
    //
    // 渲染范围是「对端 + 自己」，不按 device 字段区分 AI —— 那个字段是对端自己填的，
    // 拿它当开关等于没有开关。所以这里的安全性完全由 render.js 保证：
    // 那条路径上没有任何一处把字符串当 HTML 解析。
    if (sender !== 'system' && window.P2PRender) {
        window.P2PRender.renderInto(bubble, text);
    } else {
        bubble.textContent = text;
    }
    wrapper.appendChild(bubble);

    // 插入策略：
    // - 自建消息 / 系统消息 / 无ts的对方消息：直接追加
    // - 有ts的对方消息（缓冲刷新）：按ts插入到正确位置
    if (sender === 'peer' && ts !== undefined) {
        var children = msgList.children;
        var inserted = false;
        // 从后向前查找插入点（ts更小的消息应排在前面）
        for (var i = children.length - 1; i >= 0; i--) {
            var childTs = children[i].getAttribute('data-ts');
            if (childTs !== null && childTs !== undefined) {
                var childTsNum = parseInt(childTs, 10);
                if (ts >= childTsNum) {
                    // 插入到该消息之后
                    if (i + 1 < children.length) {
                        msgList.insertBefore(wrapper, children[i + 1]);
                    } else {
                        msgList.appendChild(wrapper);
                    }
                    inserted = true;
                    break;
                }
            }
        }
        if (!inserted) {
            // ts比所有现有消息都小，插入到最前面
            if (children.length > 0) {
                msgList.insertBefore(wrapper, children[0]);
            } else {
                msgList.appendChild(wrapper);
            }
        }
    } else {
        msgList.appendChild(wrapper);
    }

    var cc = container.querySelector('.chat-container');
    if (cc) cc.scrollTop = cc.scrollHeight;

    // 存储到连接消息历史（用于重放）
    if (connections[peerId]) {
        if (!connections[peerId].messages) connections[peerId].messages = [];
        connections[peerId].messages.push({ sender: sender, text: text, ts: ts, seq: seq });
    }

    return wrapper;
}

// ========== 全局初始化：对话模式面板 ==========
(function () {
    var closeBtn = document.getElementById('aiPanelCloseBtn');
    var tabInstant = document.getElementById('aiTabInstant');
    var tabHistory = document.getElementById('aiTabHistory');
    var newChatBtn = document.getElementById('aiNewChatBtn');

    if (closeBtn) closeBtn.onclick = _closeAiPanel;
    if (tabInstant) tabInstant.onclick = function () { _aiShowTab('instant'); };
    if (tabHistory) {
        tabHistory.onclick = function () {
            _aiShowTab('history');
            // 每次切过去都重新拉一遍 —— 期间可能又聊出了新会话
            if (_aiPanelPeerId) _aiRequestSessions(_aiPanelPeerId);
        };
    }
    if (newChatBtn) newChatBtn.onclick = _aiNewChat;

    // 点面板外面关掉（和高级设置面板一致的手感）
    document.addEventListener('click', function (e) {
        var panel = document.getElementById('aiPanel');
        if (!panel || !panel.classList.contains('show')) return;
        if (panel.contains(e.target)) return;
        if (e.target.closest && e.target.closest('.ai-mode-btn')) return;
        _closeAiPanel();
    });
})();

// ========== 全局初始化：拍照覆盖层事件 ==========
(function () {
    var cameraCloseBtn = document.getElementById('cameraCloseBtn');
    var cameraCaptureBtn = document.getElementById('cameraCaptureBtn');
    var overlay = document.getElementById('cameraOverlay');

    if (cameraCloseBtn) {
        cameraCloseBtn.onclick = function () {
            // 关闭拍照时通知对方结束文件选择
            var peerId = overlay ? overlay.getAttribute('data-peerid') : null;
            if (peerId) _announceFileSelecting(peerId, 'end');
            _closeCamera();
        };
    }
    if (cameraCaptureBtn) {
        cameraCaptureBtn.onclick = function () {
            var peerId = overlay ? overlay.getAttribute('data-peerid') : null;
            _capturePhoto();
            if (peerId) _announceFileSelecting(peerId, 'end');
        };
    }

    // ===== 预选文件按钮（房间号输入框左侧的文件夹图标） =====
    var stageBtn = document.getElementById('stageFileBtn');
    var stageInput = document.getElementById('stageFileInput');
    var stageBadge = document.getElementById('stageFileBadge');

    if (stageBtn && stageInput) {
        // 点击文件夹图标 → 打开文件选择器（支持多选，多次点击累积）
        stageBtn.onclick = function () {
            stageInput.click();
        };
        stageInput.onchange = function () {
            if (stageInput.files && stageInput.files.length) {
                stageFiles(stageInput.files);
            }
            // 立即清空，允许下次重复选择同一个文件
            stageInput.value = '';
        };
    }
    // 点击角标数字 → 清空暂存队列（阻止冒泡，避免同时触发选择文件）
    if (stageBadge) {
        stageBadge.onclick = function (e) {
            e.stopPropagation();
            clearStagedFiles();
        };
    }
    _updateStageBtnUI();

    // 全局拖放事件（只绑定一次）
    _wireGlobalDragDrop();
})();

// ========== 兼容旧版 ==========
function sendChatMessage() {
    if (!activePeerId) return;
    var c = document.querySelector('#peerTabs .peer-chat-container[data-peerid="' + activePeerId + '"]');
    if (c) { var b = c.querySelector('.send-msg-btn'); if (b) b.onclick(); }
}
function sendFile(file) {
    if (!activePeerId) return;
    var conn = connections[activePeerId];
    if (conn && conn.dc) sendFileOverDC(conn.dc, file, activePeerId);
}
function showTransferAssistant() { }
function addMessage(sender, text) { if (activePeerId) addPeerMessage(activePeerId, sender, text); }

// ========== 导出 ==========
window.createDataChannel            = createDataChannel;
window.setupDataChannelForPeer      = setupDataChannelForPeer;
window.sendFileOverDC               = sendFileOverDC;
window.createPeerChatContainer      = createPeerChatContainer;
window.addPeerMessage               = addPeerMessage;
window.sendChatMessage              = sendChatMessage;
window.sendFile                     = sendFile;
window.showTransferAssistant        = showTransferAssistant;
window.addMessage                   = addMessage;
window.tryResumeTransfer            = tryResumeTransfer;
window._showToast                   = _showToast;
window._closeCamera                 = _closeCamera;
window._announceFileSelecting       = _announceFileSelecting;
// 对话模式（对端是 AI 时）
window._closeAiPanel                = _closeAiPanel;
window._refreshAiButton             = _refreshAiButton;
// 预选文件（暂存上传）
window.stageFiles                   = stageFiles;
window.clearStagedFiles             = clearStagedFiles;
window.flushStagedFiles             = flushStagedFiles;
window._drainStagedQueue            = _drainStagedQueue;
