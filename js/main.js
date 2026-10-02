(function(){
"use strict";

// ---------- 全局变量 ----------
// 所有全局变量已在 config.js 中声明，此处不再重复声明

// DOM元素初始化（变量已在config.js中声明）
advancedBtn = document.getElementById('advancedBtn');
advancedPanel = document.getElementById('advancedPanel');
serverUrlInput = document.getElementById('serverUrl');
applyServerBtn = document.getElementById('applyServerBtn');
stunServerInput = document.getElementById('stunServer');
applyStunBtn = document.getElementById('applyStunBtn');
roomIdInput = document.getElementById('roomIdInput');
applyRoomIdBtn = document.getElementById('applyRoomIdBtn');
if (!roomIdInput) console.error('roomIdInput not found');
burstRangeInput = document.getElementById('burstRangeInput');
applyBurstRangeBtn = document.getElementById('applyBurstRangeBtn');
regexPatternContainer = document.getElementById('regexPatternList');
addRegexPatternBtn = document.getElementById('addRegexPatternBtn');
logBox = document.getElementById('logBox');
var centerDisplay = document.getElementById('centerDisplay');
myIdDisplay = document.getElementById('myIdDisplay');
peersGroup = document.getElementById('peersGroup');
radarStatus = document.getElementById('radarStatus');
scanSection = document.getElementById('scanSection');
qrcodeDiv = document.getElementById('qrcode');
sidebarItems = document.getElementById('sidebarItems');
modalOverlay = document.getElementById('modalOverlay');
modalTitle = document.getElementById('modalTitle');
modalMessage = document.getElementById('modalMessage');
modalCancelBtn = document.getElementById('modalCancelBtn');
modalConfirmBtn = document.getElementById('modalConfirmBtn');

// modalResolve 已在 config.js 中声明

// 从config.js初始化高级设置输入框
serverUrlInput.value = serverUrl;
stunServerInput.value = stunServer;
burstRangeInput.value = gatewayBurstRange;

// ====== 立即启动快速STUN探测 + HTTP API探测（并行） ======
_startFastStunProbe();
_startHttpProbe();

// ====== 多连接管理 ======

function createConnectionEntry(peerId, roleType) {
    if (connections[peerId]) {
        if (connections[peerId].pc) connections[peerId].pc.close();
        delete connections[peerId];
    }
    var entry = { pc: null, dc: null, role: roleType, targetId: peerId, connected: false, messages: [] };
    connections[peerId] = entry;
    return entry;
}

function getActiveConnection() {
    if (activePeerId && connections[activePeerId]) return connections[activePeerId];
    return null;
}

function syncGlobalsToActive() {
    var conn = getActiveConnection();
    if (conn) {
        pc = conn.pc;
        dc = conn.dc;
        targetId = conn.targetId;
        role = conn.role;
    } else {
        pc = null;
        dc = null;
        targetId = null;
        role = null;
    }
}

function switchToHome() {
    // 隐藏所有对等聊天界面
    var tabs = document.getElementById('peerTabs');
    if (tabs) {
        var activeTabs = tabs.querySelectorAll('.peer-chat-container.active');
        for (var i = 0; i < activeTabs.length; i++) activeTabs[i].classList.remove('active');
    }
    // 显示雷达视图
    var viewRadar = document.getElementById('view-radar');
    if (viewRadar) viewRadar.classList.add('active-view');

    // 更新侧边栏激活状态
    var items = document.querySelectorAll('#sidebarItems .nav-item');
    for (var i = 0; i < items.length; i++) items[i].classList.remove('active-nav');
    var homeItem = document.getElementById('homeSidebarItem');
    if (homeItem) homeItem.classList.add('active-nav');

    activePeerId = null;
    pc = null; dc = null; targetId = null; role = null;

    addLog('[导航] 切换到首页');
    // 重新连接信令
    if (!ws || ws.readyState !== WebSocket.OPEN) {
        startRadarMode().catch(function(e) {
            addLog('[错误] 首页重连失败: ' + e);
        });
    }
    // 重启Shadow PC预热（如果还没有激活连接）
    var activeCount = 0;
    for (var ck in connections) {
        if (connections.hasOwnProperty(ck) && connections[ck].connected) activeCount++;
    }
    if (activeCount === 0 && window.shadowPcStart) {
        window.shadowPcStart();
    }
}

function switchToPeer(peerId) {
    var conn = connections[peerId];
    if (!conn) { addLog('[错误] 切换失败: 连接 ' + peerId + ' 不存在'); return; }

    // 面板是给某一个对端开的，换对端就别让它留在屏幕上误导人
    if (window._closeAiPanel) window._closeAiPanel();

    // 隐藏雷达视图
    var viewRadar = document.getElementById('view-radar');
    if (viewRadar) viewRadar.classList.remove('active-view');

    // 隐藏所有选项卡，显示目标选项卡
    var tabs = document.getElementById('peerTabs');
    var allContainers = tabs.querySelectorAll('.peer-chat-container');
    for (var i = 0; i < allContainers.length; i++) allContainers[i].classList.remove('active');
    var targetContainer = tabs.querySelector('.peer-chat-container[data-peerid="' + peerId + '"]');
    if (targetContainer) targetContainer.classList.add('active');

    // 更新侧边栏激活状态
    var items = document.querySelectorAll('#sidebarItems .nav-item');
    for (var i = 0; i < items.length; i++) items[i].classList.remove('active-nav');
    var sideItem = document.querySelector('#sidebarItems .nav-item[data-peerid="' + peerId + '"]');
    if (sideItem) sideItem.classList.add('active-nav');

    activePeerId = peerId;
    syncGlobalsToActive();
    addLog('[导航] 切换到 ' + peerId);
}

// 双方DC就绪后打开聊天界面（chat-ready握手完成后调用）
function _openPeerChat(peerId) {
    if (!connections[peerId]) return;
    if (connections[peerId]._chatOpened) return;
    connections[peerId]._chatOpened = true;

    addLog('[聊天] 双方数据通道就绪，打开聊天界面');
    createPeerChatContainer(peerId);
    addPeerSidebarItem(peerId);
    switchToPeer(peerId);
    openSidebar();

    // 预选文件：连接就绪后立即自动上传（无需用户再操作，规避安卓切后台断连）
    if (window.flushStagedFiles) window.flushStagedFiles(peerId);
}

function cleanupConnection(peerId) {
    var conn = connections[peerId];
    if (!conn) return;

    // 通过数据通道通知对方断开（同步断开）
    if (conn.dc && conn.dc.readyState === 'open') {
        try {
            conn.dc.send(JSON.stringify({ type: 'disconnect' }));
            addLog('[同步断开] 已通知 ' + peerId + ' 断开连接');
        } catch(e) {
            addLog('[同步断开] 通知失败: ' + e);
        }
    }

    if (conn.pc) {
        try { conn.pc.close(); } catch(e) {}
    }
    // 面板正给这个对端开着的话，连接没了就收起来（否则会停在「正在获取…」）
    if (window._closeAiPanel) window._closeAiPanel();
    // 移除侧边栏
    removePeerSidebarItem(peerId);
    // 移除聊天界面
    var container = document.querySelector('#peerTabs .peer-chat-container[data-peerid="' + peerId + '"]');
    if (container) {
        container.classList.remove('active');
        container.remove();
    }
    // 从连接池移除
    delete connections[peerId];
    addLog('[连接] 已清理 ' + peerId + ' 的连接');

    // 如果当前显示的是这个对等端，切到最近的其他对等端或首页
    if (activePeerId === peerId) {
        var remainingPeers = [];
        for (var k in connections) {
            if (connections.hasOwnProperty(k)) remainingPeers.push(k);
        }
        if (remainingPeers.length > 0) {
            switchToPeer(remainingPeers[remainingPeers.length - 1]);
        } else {
            switchToHome();
        }
    }

    // 更新分隔符和空状态
    updatePeerSeparator();
}

// ====== 侧边栏管理 ======

var sidebarOpen = false;

function toggleSidebar() {
    sidebarOpen = !sidebarOpen;
    var sidebar = document.getElementById('sidebar');
    if (sidebar) sidebar.classList.toggle('open', sidebarOpen);
}

function openSidebar() {
    if (!sidebarOpen) toggleSidebar();
}

function closeSidebar() {
    if (sidebarOpen) toggleSidebar();
}

function updatePeerSeparator() {
    var separator = document.getElementById('peerSeparator');
    if (!separator) return;
    var count = 0;
    for (var k in connections) { if (connections.hasOwnProperty(k)) count++; }
    separator.style.display = count > 0 ? 'block' : 'none';

    var emptyEl = document.getElementById('sidebarEmpty');
    if (emptyEl) emptyEl.style.display = count === 0 ? 'block' : 'none';
}

function addPeerSidebarItem(peerId) {
    var itemsContainer = document.getElementById('sidebarItems');
    if (!itemsContainer) return;
    // 检查是否已存在
    var existing = itemsContainer.querySelector('.nav-item[data-peerid="' + peerId + '"]');
    if (existing) return;

    var item = document.createElement('div');
    item.className = 'nav-item';
    item.setAttribute('data-peerid', peerId);
    item.innerHTML = '<span class="nav-item-icon">🟢</span>' +
        '<span class="nav-item-name">' + escHtml(peerId) + '</span>' +
        '<button class="nav-item-close" title="关闭连接">✕</button>';

    // 点击切换到对等端
    item.onclick = function(e) {
        if (e.target.classList.contains('nav-item-close')) return;
        if (activePeerId === peerId) return;
        openSidebar();
        switchToPeer(peerId);
    };

    // 关闭按钮
    var closeBtn = item.querySelector('.nav-item-close');
    closeBtn.onclick = function(e) {
        e.stopPropagation();
        cleanupConnection(peerId);
    };

    itemsContainer.appendChild(item);

    // 更新分隔符
    updatePeerSeparator();
}

function removePeerSidebarItem(peerId) {
    var item = document.querySelector('#sidebarItems .nav-item[data-peerid="' + peerId + '"]');
    if (item) item.remove();
    updatePeerSeparator();
}

// 聊天UI和传输函数已移至 transfer.js

// ====== 侧边栏事件绑定 ======

document.getElementById('sidebarToggle').onclick = function() {
    toggleSidebar();
};

// 首页按钮
document.getElementById('homeSidebarItem').onclick = function() {
    closeSidebar();
    switchToHome();
};

function showModal(title, message, icon) {
    modalTitle.textContent = title;
    modalMessage.textContent = message;
    var iconEl = document.getElementById('modalIcon');
    if (iconEl) iconEl.textContent = icon || '';
    modalOverlay.classList.remove('hidden');
    return new Promise((resolve) => {
        modalResolve = resolve;
    });
}
function hideModal(result) {
    modalOverlay.classList.add('hidden');
    if (modalResolve) {
        modalResolve(result);
        modalResolve = null;
    }
}

modalConfirmBtn.onclick = () => hideModal(true);
modalCancelBtn.onclick = () => hideModal(false);

var loadingOverlay = document.getElementById('loadingOverlay');
var loadingText = document.getElementById('loadingText');

function showLoadingOverlay(msg) {
    if (loadingText) loadingText.textContent = msg || '正在建立连接...';
    if (loadingOverlay) loadingOverlay.classList.remove('hidden');
}
function hideLoadingOverlay() {
    if (loadingOverlay) loadingOverlay.classList.add('hidden');
}
window.showLoadingOverlay = showLoadingOverlay;
window.hideLoadingOverlay = hideLoadingOverlay;

function addLog(msg) {
    if (logBox) {
        logBox.textContent += msg + '\n';
        logBox.scrollTop = logBox.scrollHeight;
    } else {
        console.log('LOG:', msg);
    }
}
function clearLog() { logBox.textContent = ''; }

// ---------- 信令连接 ----------
function connectSignaling() {
    if (!serverUrl) {
        addLog('[错误] 未设置服务器地址');
        return Promise.reject('no server');
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
    }
    return new Promise((resolve, reject) => {
        ws = new WebSocket(`wss://${serverUrl}`);
        ws.onopen = () => {
            serverConnected = true;
            addLog('[信令] 连接成功');
            resolve();
        };
        ws.onmessage = (e) => handleSignalingMessage(JSON.parse(e.data));
        ws.onclose = () => {
            serverConnected = false;
            addLog('[信令] 断开');
        };
        ws.onerror = (err) => {
            addLog('[信令] 连接错误');
            reject(err);
        };
    });
}

function handleSignalingMessage(msg) {
    addLog(`[信令收] ${msg.type} ${msg.from ? 'from '+msg.from : ''}`);
    if (msg.type === 'ok') {
        myId = msg.id;
        if (myIdDisplay) myIdDisplay.textContent = myId;
        addLog(`[信令] 我的ID: ${myId}`);
        ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId } }));
    } else if (msg.type === 'same_network_clients') {
        peerNodes = msg.clients;
        updateRadarPeers();
        radarStatus.textContent = peerNodes.length ? `发现 ${peerNodes.length} 个设备` : '等待其他设备加入...';
    } else if (msg.type === 'new_peer') {
        if (!peerNodes.includes(msg.peer_id)) {
            peerNodes.push(msg.peer_id);
            updateRadarPeers();
            radarStatus.textContent = `发现 ${peerNodes.length} 个设备`;
            addLog(`[设备] ${msg.peer_id} 加入，当前共 ${peerNodes.length} 个`);
        }
    } else if (msg.type === 'peer_left') {
        peerNodes = peerNodes.filter(id => id !== msg.peer_id);
        updateRadarPeers();
        radarStatus.textContent = peerNodes.length ? `发现 ${peerNodes.length} 个设备` : '等待其他设备加入...';
        addLog(`[设备] ${msg.peer_id} 离开，当前共 ${peerNodes.length} 个`);
    } else if (msg.type === 'connect_request') {
        handleConnectRequest(msg.from);
    } else if (msg.type === 'connect_reject') {
        addLog('[连接] ' + (msg.from || '对方') + ' 拒绝了连接请求');
        hideLoadingOverlay();
        radarStatus.textContent = '连接被拒绝';
        // 清理发起方连接条目
        if (msg.from && connections[msg.from]) {
            cleanupConnection(msg.from);
        }
    } else if (msg.type === 'connect_accept') {
        startWebRTCAsInitiator(msg.from);
    } else if (msg.type === 'answer') {
        showLoadingOverlay('正在与 ' + (msg.from || '对方') + ' 建立连接...');
        if (role === 'receiver') {
            if (msg.from && !connections[msg.from]) {
                targetId = msg.from;
                createConnectionEntry(msg.from, role);
                connections[msg.from].pc = pc;
                connections[msg.from].dc = dc;
            }
            handleRemoteAnswerCompressed(msg.payload);
        }
    } else if (msg.type === 'offer') {
        showLoadingOverlay('正在与 ' + (msg.from || '对方') + ' 建立连接...');
        handleRemoteOfferCompressed(msg.payload, msg.from);
    } else if (msg.type === 'ice') {
        handleRemoteIce(msg.payload);
    }
}

async function handleConnectRequest(fromId) {
    addLog(`[连接] ${fromId} 正在请求连接...`);

    // 弹出确认框，让用户确认是否是期望的连接对象
    var confirmed = await showModal(
        '连接确认',
        fromId + ' 正在请求与您建立连接，请确认该 ID 是您期望的连接对象。',
        '🔒'
    );
    if (!confirmed) {
        addLog('[连接] 用户拒绝连接请求: ' + fromId);
        ws.send(JSON.stringify({ type: 'connect_reject', target: fromId }));
        return;
    }

    addLog('[连接] 用户确认连接请求: ' + fromId);

    // 显示加载覆盖层
    showLoadingOverlay('正在与 ' + fromId + ' 建立连接...');

    gatewayBurstAttempted = false;
    carrierNatHandlingStage = 0;
    carrierNatDetectedIp = null;
    carrierNatRealTimeDetectionTriggered = false;
    carrierNatReplacementMap = {};
    burstEnabledByStunMatch = false;
    localStunIp = null;
    remoteStunIp = null;

    pendingIceCandidates = [];
    remoteIceCandidates = [];
    localCandidates = [];

    createConnectionEntry(fromId, 'sender');
    targetId = fromId;
    role = 'sender';

    ws.send(JSON.stringify({ type: 'connect_accept', target: fromId }));
    addLog(`[连接] 已接受 ${fromId} 的连接请求`);
}

async function startWebRTCAsInitiator(peerId) {
    createConnectionEntry(peerId, 'receiver');
    targetId = peerId;
    role = 'receiver';
    radarStatus.textContent = `连接 ${peerId}...`;

    // 重置去重表和运营商NAT状态
    _embeddedIceSet = {};
    gatewayBurstAttempted = false;
    carrierNatHandlingStage = 0;
    carrierNatDetectedIp = null;
    carrierNatRealTimeDetectionTriggered = false;
    carrierNatReplacementMap = {};
    burstEnabledByStunMatch = false;
    localStunIp = null;
    remoteStunIp = null;

    createPeerConnection();
    if (connections[peerId]) connections[peerId].pc = pc;
    createDataChannel();
    if (connections[peerId]) connections[peerId].dc = dc;
    // 立即设置DC消息处理器（chat-ready握手需要）
    setupDataChannelForPeer(peerId, dc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // 不再等待ICE收集完成，立即提取SDP参数
    const sdp = pc.localDescription.sdp;
    const u = sdp.match(/a=ice-ufrag:(.+)/)[1];
    const p = sdp.match(/a=ice-pwd:(.+)/)[1];
    const f = sdp.match(/a=fingerprint:sha-256 (.+)/)[1];

    // 合并 Shadow PC 缓存候选 + 已收集到的本地候选
    var iceCompact = [];

    // 1. 先加入Shadow PC预热的候选（使用真实PC的ufrag重建）
    var shadowCands = window.getShadowCandidates ? window.getShadowCandidates() : [];
    for (var si = 0; si < shadowCands.length; si++) {
        var sc = shadowCands[si];
        var key = sc.ip + ':' + sc.port;
        if (!_embeddedIceSet[key]) {
            _embeddedIceSet[key] = true;
            iceCompact.push({ ip: sc.ip, port: sc.port, type: sc.type });
        }
    }

    // 2. 再加入已收集到的真实候选（去重，过滤TCP/低端口）
    for (var li = 0; li < localCandidates.length; li++) {
        var lc = localCandidates[li];
        if (lc.candidate.includes('tcptype')) continue;
        var lcParts = lc.candidate.split(' ');
        var lcTypIdx = lcParts.indexOf('typ');
        if (lcTypIdx > 1) {
            var lcPort = parseInt(lcParts[lcTypIdx - 1], 10);
            if (lcPort >= 1024) {
                var lcIp = lcParts[lcTypIdx - 2];
                var lcType = lcParts[lcTypIdx + 1];
                var lcKey = lcIp + ':' + lcPort;
                if (!_embeddedIceSet[lcKey]) {
                    _embeddedIceSet[lcKey] = true;
                    iceCompact.push({ ip: lcIp, port: lcPort, type: lcType });
                }
            }
        }
    }

    // 提取本机STUN IP，随Offer发送
    localStunIp = getLocalStunIp();
    addLog('[STUN检测] 本机STUN IPv4: ' + (localStunIp || '无'));

    ws.send(JSON.stringify({
        type: 'offer',
        target: peerId,
        payload: { u, p, f, ice: iceCompact, stunIp: localStunIp }
    }));
    addLog(`[探查] 发送Offer给 ${peerId}（嵌入${iceCompact.length}个候选）`);
}

// ---------- WebRTC 核心 ----------
function buildSDP(type, ufrag, pwd, fingerprint, candidates) {
    const sessionId = Math.floor(Math.random() * 1e18);
    var sdp = `v=0\r
o=- ${sessionId} 2 IN IP4 127.0.0.1\r
s=-\r
t=0 0\r
a=group:BUNDLE 0\r
a=extmap-allow-mixed\r
a=msid-semantic: WMS\r
m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r
c=IN IP4 0.0.0.0\r
a=ice-ufrag:${ufrag}\r
a=ice-pwd:${pwd}\r
a=ice-options:trickle\r
a=fingerprint:sha-256 ${fingerprint}\r
a=setup:${type === 'offer' ? 'actpass' : 'active'}\r
a=mid:0\r
a=sctp-port:5000\r
a=max-message-size:262144\r
`;
    // 嵌入in-band ICE候选（Vanilla ICE变体）
    if (candidates && candidates.length > 0) {
        for (var ci = 0; ci < candidates.length; ci++) {
            var c = candidates[ci];
            var candStr = buildICECandidate(c.ip, c.port, c.type, ufrag);
            sdp += 'a=' + candStr + '\r\n';
        }
    }
    return sdp;
}

function buildICECandidate(ip, port, type, ufrag, options) {
    var opts = options || {};
    var foundation = opts.foundation || Math.floor(Math.random() * 2e9);
    var priority;
    if (opts.priority !== undefined) {
        priority = opts.priority;
    } else if (type === 'host') {
        priority = ip.includes(':') ? 2113939711 : 2113937151;
    } else if (type === 'srflx') {
        priority = 1694498815;
    } else if (type === 'prflx') {
        priority = 100;
    } else {
        priority = 0;
    }
    return `candidate:${foundation} 1 udp ${priority} ${ip} ${port} typ ${type} generation 0 ufrag ${ufrag} network-cost 999`;
}

// 构建爆破候选字符串（降低priority确保浏览器优先尝试真实链路）
function buildICECandidate_Burst(ip, port, type, ufrag) {
    // host优先级 2113937151，爆破使用低1000的优先级
    var burstPriority = (type === 'host') ? (ip.includes(':') ? 2113938711 : 2113936151) : 1694497815;
    return buildICECandidate(ip, port, type, ufrag, { priority: burstPriority });
}

function createPeerConnection() {
    if (pc) {
        pc.close();
        pc = null;
    }
    pendingIceCandidates = [];
    remoteIceCandidates = [];
    const iceServers = stunServer ? [{ urls: stunServer }] : [];
    pc = new RTCPeerConnection({ iceServers });

    // 捕获创建时的目标ID，避免切换tab后targetId变化
    var createdPcForPeerId = targetId;

    pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        var now = Date.now();

        // 防ICE震荡：爆破期间忽略快速checking切换（<200ms间隔）
        if (_burstInProgress && state === 'checking' && pc._lastConnStateTime && (now - pc._lastConnStateTime < 200)) {
            return;
        }
        pc._lastConnState = state;
        pc._lastConnStateTime = now;

        addLog(`[连接状态] ${state}`);
        var connStateR = document.getElementById('connStateR');
        if (connStateR) connStateR.textContent = state;

        if (state === 'connected') {
            hideLoadingOverlay();
            connectionFailureCount = 0;
            // 连接建立，停止Shadow PC
            if (window.shadowPcStop) window.shadowPcStop();
            var peerId = createdPcForPeerId || targetId;
            if (peerId && connections[peerId]) {
                connections[peerId].pc = pc;
                connections[peerId].connected = true;

                // 确保DC已保存到连接条目（可能由ondatachannel或createDataChannel设置）
                if (!connections[peerId].dc && dc) {
                    connections[peerId].dc = dc;
                }

                // 设置数据通道消息处理器（DC就绪后通过chat-ready握手打开聊天界面）
                var peerDc = connections[peerId].dc || dc;
                if (peerDc) {
                    setupDataChannelForPeer(peerId, peerDc);
                }

                // 连接成功，断开信令
                if (ws) {
                    addLog('[信令] 连接已建立，断开信令服务器');
                    ws.close();
                }
            }
        } else if (state === 'failed') {
            hideLoadingOverlay();
            connectionFailureCount++;
            addLog(`[连接失败] 失败次数: ${connectionFailureCount}`);

            // 如果启用了网关爆破，提示用户调整爆破IP范围
            if (burstEnabledByStunMatch && gatewayBurstAttempted) {
                addLog('[连接失败] 提示：当前爆破范围可能不包含正确的网关IP，请在「高级设置」中调整「网关爆破范围」后重试');
                addLog('[连接失败] 当前爆破范围: ' + gatewayBurstRange);
                // 显示弹窗提示
                if (typeof showToast === 'function') {
                    showToast('连接失败，建议调整高级设置中的网关爆破IP范围后重试');
                }
            }

            var cleanupId = createdPcForPeerId || targetId;
            if (cleanupId) {
                // 延迟清理，让用户看到状态
                setTimeout(function() {
                    if (connections[cleanupId] && !connections[cleanupId].connected) {
                        cleanupConnection(cleanupId);
                    }
                }, 500);
            }
        } else if (state === 'disconnected') {
            // ICE断开，尝试ICE重启，不立即清理
            addLog('[连接断开] 等待可能的重连...');
            // 如果5秒内没有恢复，清理连接
            var discPeerId = createdPcForPeerId || targetId;
            if (discPeerId) {
                setTimeout(function() {
                    if (connections[discPeerId] && connections[discPeerId].pc) {
                        var currentState = connections[discPeerId].pc.connectionState;
                        if (currentState === 'disconnected' || currentState === 'failed') {
                            addLog('[连接清理] 超时未恢复，清理 ' + discPeerId);
                            cleanupConnection(discPeerId);
                        }
                    }
                }, 5000);
            }
        }
    };

    pc.onicecandidate = (e) => {
        if (e.candidate) {
            var candStr = e.candidate.candidate;
            addLog(`[本地ICE] ${candStr}`);
            var _cparts = candStr.split(' ');
            var _cport = _cparts.length >= 6 ? parseInt(_cparts[5], 10) : 0;
            var _isTcp = candStr.includes('tcptype');

            // 过滤低端口(<1024)和TCP候选，不添加到localCandidates（加速QR压缩）
            if (_cport >= 1024 && !_isTcp) {
                localCandidates.push(e.candidate);
            } else {
                addLog(`[本地ICE] 跳过${_isTcp ? 'TCP' : '低端口' + _cport}候选`);
            }

            // 发送给对端时同样过滤
            if (ws && ws.readyState === WebSocket.OPEN && targetId) {
                if (_cport >= 1024 && !_isTcp) {
                    var _cip = _cparts.length >= 5 ? _cparts[4] : '';
                    var _ckey = _cip + ':' + _cport;
                    if (_embeddedIceSet && _embeddedIceSet[_ckey]) {
                        addLog(`[本地ICE] 跳过已嵌入候选 ${_ckey}`);
                        return;
                    }
                    ws.send(JSON.stringify({
                        type: 'ice',
                        target: targetId,
                        payload: candStr
                    }));
                }
            }
        } else {
            addLog('[ICE收集] 完成');
            if (role === 'receiver' && centerDisplay && centerDisplay.classList.contains('show-qr')) {
                generateCompressedQR();
            }
        }
    };

    pc.ondatachannel = (e) => {
        dc = e.channel;
        var peerId = createdPcForPeerId || targetId;
        if (peerId && connections[peerId]) {
            connections[peerId].dc = dc;
            setupDataChannelForPeer(peerId, dc);
        }
    };

    return pc;
}

async function generateOffer() {
    try {
        if (pc) {
            addLog('[Offer] 关闭旧连接');
            pc.close();
        }
        localCandidates = [];

        // 重置去重表
        _embeddedIceSet = {};

        addLog('[Offer] 初始化 PeerConnection...');
        createPeerConnection();

        addLog('[Offer] 创建 DataChannel...');
        createDataChannel();

        addLog('[Offer] 正在创建 SDP Offer...');
        const offer = await pc.createOffer();

        addLog('[Offer] 设置本地描述...');
        await pc.setLocalDescription(offer);

        addLog('[Offer] ICE收集已启动（不等待完成，异步收集）');
    } catch (err) {
        addLog('[错误] generateOffer 内部崩溃: ' + err.message);
        throw err;
    }
}

async function handleRemoteAnswerCompressed(compressed) {
    const { u, p, f, ice, stunIp: remoteStun } = compressed;
    const answerCandidates = ice || [];

    // STUN IP比对：双方STUN IPv4相同 → 同一运营商NAT → 启用爆破
    localStunIp = getLocalStunIp();
    remoteStunIp = remoteStun || null;
    if (localStunIp && remoteStunIp && localStunIp === remoteStunIp) {
        burstEnabledByStunMatch = true;
        addLog('[STUN检测] 双方STUN IP相同 (' + localStunIp + ')，启用网关爆破');
    } else {
        burstEnabledByStunMatch = false;
        addLog('[STUN检测] 本机=' + (localStunIp || '无') + ' 对方=' + (remoteStunIp || '无') + '，关闭网关爆破');
    }

    const answerSdp = buildSDP('answer', u, p, f, answerCandidates);
    await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
    addLog('[设置远程Answer] 成功');
    while (pendingIceCandidates.length) {
        const cand = pendingIceCandidates.shift();
        await handleRemoteIce(cand);
    }

}

async function handleRemoteOfferCompressed(compressed, fromId) {
    addLog(`[探查] 处理来自 ${fromId} 的offer`);
    targetId = fromId;
    role = 'sender';

    // 重置去重表和运营商NAT状态
    _embeddedIceSet = {};
    gatewayBurstAttempted = false;
    carrierNatHandlingStage = 0;
    carrierNatDetectedIp = null;
    carrierNatRealTimeDetectionTriggered = false;
    carrierNatReplacementMap = {};
    burstEnabledByStunMatch = false;
    localStunIp = null;
    remoteStunIp = null;

    const { u, p, f, ice, stunIp: remoteStun } = compressed;
    const offerCandidates = ice || [];

    // STUN IP比对：双方STUN IPv4相同 → 同一运营商NAT → 启用爆破
    localStunIp = getLocalStunIp();
    remoteStunIp = remoteStun || null;
    if (localStunIp && remoteStunIp && localStunIp === remoteStunIp) {
        burstEnabledByStunMatch = true;
        addLog('[STUN检测] 双方STUN IP相同 (' + localStunIp + ')，启用网关爆破');
    } else {
        burstEnabledByStunMatch = false;
        addLog('[STUN检测] 本机=' + (localStunIp || '无') + ' 对方=' + (remoteStunIp || '无') + '，关闭网关爆破');
    }

    var savedPendingIce = pendingIceCandidates.slice();
    var savedRemoteIce = remoteIceCandidates.slice();

    createPeerConnection();
    if (connections[fromId]) connections[fromId].pc = pc;
    remoteIceCandidates = savedRemoteIce;

    // 构建SDP并嵌入in-band候选
    const offerSdp = buildSDP('offer', u, p, f, offerCandidates);
    await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });

    // 先处理缓存的pending ICE（trickle ICE有正确的端口，优先触发爆破）
    for (var pIdx = 0; pIdx < savedPendingIce.length; pIdx++) {
        await handleRemoteIce(savedPendingIce[pIdx]);
    }
    // 也处理在setRemoteDescription期间到达的trickle ICE候选
    while (pendingIceCandidates.length) {
        const cand = pendingIceCandidates.shift();
        await handleRemoteIce(cand);
    }

    // 再作为fallback显式添加in-band候选（跳过爆破，仅添加真实候选）
    for (var icIdx = 0; icIdx < offerCandidates.length; icIdx++) {
        var ic = offerCandidates[icIdx];
        await handleRemoteIce(buildICECandidate(ic.ip, ic.port, ic.type, u), true);
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);


    const ansSdp = answer.sdp;
    const ansU = ansSdp.match(/a=ice-ufrag:(.+)/)[1];
    const ansP = ansSdp.match(/a=ice-pwd:(.+)/)[1];
    const ansF = ansSdp.match(/a=fingerprint:sha-256 (.+)/)[1];

    // 收集应答方候选（Shadow + 已收集的真实候选）
    var answerIceCompact = [];

    // 1. Shadow缓存
    var shadowCands = window.getShadowCandidates ? window.getShadowCandidates() : [];
    for (var si = 0; si < shadowCands.length; si++) {
        var sc = shadowCands[si];
        var skey = sc.ip + ':' + sc.port;
        if (!_embeddedIceSet[skey]) {
            _embeddedIceSet[skey] = true;
            answerIceCompact.push({ ip: sc.ip, port: sc.port, type: sc.type });
        }
    }

    // 2. 已收集的真实候选（过滤TCP/低端口）
    for (var lai = 0; lai < localCandidates.length; lai++) {
        var alc = localCandidates[lai];
        if (alc.candidate.includes('tcptype')) continue;
        var aParts = alc.candidate.split(' ');
        var aTypIdx = aParts.indexOf('typ');
        if (aTypIdx > 1) {
            var aPort = parseInt(aParts[aTypIdx - 1], 10);
            if (aPort >= 1024) {
                var aIp = aParts[aTypIdx - 2];
                var aType = aParts[aTypIdx + 1];
                var aKey = aIp + ':' + aPort;
                if (!_embeddedIceSet[aKey]) {
                    _embeddedIceSet[aKey] = true;
                    answerIceCompact.push({ ip: aIp, port: aPort, type: aType });
                }
            }
        }
    }

    // 短暂延迟收集额外候选
    await new Promise(function(r) { setTimeout(r, 500); });

    const answerCompressed = { u: ansU, p: ansP, f: ansF, ice: answerIceCompact, stunIp: localStunIp };
    ws.send(JSON.stringify({ type: 'answer', target: targetId, payload: answerCompressed }));
    addLog(`[探查] 发送Answer给 ${targetId}（嵌入${answerIceCompact.length}个候选）`);
}

async function reconnectWithCarrierNatReplacement(detectedCarrierNatIp, replacementIpOrIps, port) {
    addLog(`[运营商NAT重新连接] 开始重新连接，替换IP: ${detectedCarrierNatIp}`);

    if (Array.isArray(replacementIpOrIps)) {
        carrierNatReplacementMap[detectedCarrierNatIp] = replacementIpOrIps;
    } else {
        carrierNatReplacementMap[detectedCarrierNatIp] = replacementIpOrIps;
    }

    gatewayBurstAttempted = true;

    if (pc) {
        pc.close();
        pc = null;
    }

    connectionFailureCount = 0;
    remoteIceCandidates = [];
    pendingIceCandidates = [];
    localCandidates = [];
    carrierNatRealTimeDetectionTriggered = false;

    if (role === 'receiver' && targetId) {
        addLog(`[运营商NAT重新连接] 主动方重新连接 ${targetId}`);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'connect_request', target: targetId }));
            radarStatus.textContent = `运营商NAT检测，重新连接 ${targetId}...`;
        }
    } else if (role === 'sender' && targetId) {
        addLog(`[运营商NAT重新连接] 被动方发送连接请求给 ${targetId}`);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'connect_request', target: targetId }));
            radarStatus.textContent = `运营商NAT检测，发送连接请求给 ${targetId}...`;
        }
    } else {
        addLog(`[运营商NAT重新连接] 无法重新连接：role=${role}, targetId=${targetId}`);
    }
}

// ========== ICE重启（移动端文件选择后秒级重连） ==========
async function iceRestart(peerId) {
    var conn = connections[peerId];
    if (!conn || !conn.pc) {
        addLog('[ICE重启] 无有效连接');
        return false;
    }

    var restartPc = conn.pc;
    addLog('[ICE重启] 开始为 ' + peerId + ' 触发ICE重启');

    // Step 1: 触发浏览器级别ICE重启
    try {
        restartPc.restartIce();
        addLog('[ICE重启] restartIce() 已调用');
    } catch (e) {
        addLog('[ICE重启] restartIce() 不可用: ' + e.message);
        // 降级：尝试通过信令重新协商
    }

    // Step 2: 等待自动恢复（最多4秒）
    var maxWait = 4000;
    var interval = 300;
    var waited = 0;

    return new Promise(function (resolve) {
        var check = function () {
            var state = restartPc.connectionState;
            var dcState = conn.dc ? conn.dc.readyState : 'closed';

            addLog('[ICE重启] 状态检查: conn=' + state + ', dc=' + dcState + ' (waited ' + waited + 'ms)');

            if (state === 'connected') {
                // 连接已恢复，检查DC是否需要重新创建
                if (dcState !== 'open' && conn.dc) {
                    // DC可能因ICE重启而关闭，尝试重新创建
                    addLog('[ICE重启] 连接恢复但DC未就绪，等待DC恢复...');
                    // DC应该由ondatachannel或浏览器自动恢复
                }
                if (dcState === 'open' || (conn.dc && conn.dc.readyState === 'open')) {
                    addLog('[ICE重启] 恢复成功！');
                    resolve(true);
                    return;
                }
            }

            waited += interval;
            if (waited >= maxWait) {
                addLog('[ICE重启] 超时，尝试通过信令重新协商...');
                // Step 3: 尝试信令层重新协商
                _iceRestartViaSignaling(peerId, restartPc, conn).then(resolve);
                return;
            }
            setTimeout(check, interval);
        };
        setTimeout(check, interval);
    });
}

async function _iceRestartViaSignaling(peerId, restartPc, conn) {
    try {
        // 重新连接信令
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            addLog('[ICE重启] 重新连接信令服务器...');
            await connectSignaling();
            // 等待OK和join_room
            await new Promise(function (r) { setTimeout(r, 500); });
        }

        // 创建带iceRestart的Offer
        var offer = await restartPc.createOffer({ iceRestart: true });
        await restartPc.setLocalDescription(offer);
        addLog('[ICE重启] 已创建ICE重启Offer');

        // 压缩SDP并发送
        var ufrag = null, pwd = null;
        var sdpLines = offer.sdp.split('\n');
        for (var i = 0; i < sdpLines.length; i++) {
            if (sdpLines[i].indexOf('a=ice-ufrag:') === 0) {
                ufrag = sdpLines[i].substring(12).trim();
            } else if (sdpLines[i].indexOf('a=ice-pwd:') === 0) {
                pwd = sdpLines[i].substring(11).trim();
            }
        }
        var fingerprint = '';
        var fpMatch = offer.sdp.match(/a=fingerprint:sha-256\s+(\S+)/);
        if (fpMatch) fingerprint = fpMatch[1];

        var compressed = {
            u: ufrag, p: pwd, f: fingerprint,
            ice: [],
            stunIp: localStunIp || ''
        };

        // 发送ICE重启Offer
        if (ws && ws.readyState === WebSocket.OPEN && peerId) {
            ws.send(JSON.stringify({
                type: 'offer',
                target: peerId,
                payload: compressed
            }));
            addLog('[ICE重启] 已通过信令发送ICE重启Offer');

            // 等待连接恢复
            var maxWait2 = 8000;
            var interval2 = 500;
            var waited2 = 0;
            return new Promise(function (resolve) {
                var check2 = function () {
                    if (restartPc.connectionState === 'connected') {
                        addLog('[ICE重启] 信令重新协商成功');
                        resolve(true);
                        return;
                    }
                    waited2 += interval2;
                    if (waited2 >= maxWait2) {
                        addLog('[ICE重启] 信令重新协商超时');
                        resolve(false);
                        return;
                    }
                    setTimeout(check2, interval2);
                };
                setTimeout(check2, interval2);
            });
        }

        return false;
    } catch (e) {
        addLog('[ICE重启] 信令协商错误: ' + e.message);
        return false;
    }
}

function replaceIceCandidateIp(candidateStr) {
    if (!candidateStr || typeof candidateStr !== 'string') return candidateStr;

    const parts = candidateStr.split(' ');
    if (parts.length < 8) return candidateStr;

    const originalIp = parts[4];
    if (!originalIp || originalIp.includes(':')) return candidateStr;

    const replacement = carrierNatReplacementMap[originalIp];
    if (!replacement) return candidateStr;

    const replacementIp = Array.isArray(replacement) ? replacement[0] : replacement;
    parts[4] = replacementIp;
    return parts.join(' ');
}

// 获取本机STUN服务器返回的IPv4（srflx候选IP）
// 优先从Shadow缓存获取，其次从已收集的真实候选获取
function getLocalStunIp() {
    // 1. 从Shadow PC缓存查找srflx
    var shadowCands = window.getShadowCandidates ? window.getShadowCandidates() : [];
    for (var i = 0; i < shadowCands.length; i++) {
        if (shadowCands[i].type === 'srflx' && shadowCands[i].ip && !shadowCands[i].ip.includes(':')) {
            return shadowCands[i].ip;
        }
    }
    // 2. 从已收集的真实候选查找srflx
    for (var j = 0; j < localCandidates.length; j++) {
        var parts = localCandidates[j].candidate.split(' ');
        var typIdx = parts.indexOf('typ');
        if (typIdx > 0 && parts[typIdx + 1] === 'srflx') {
            var ip = parts[typIdx - 2];
            if (ip && !ip.includes(':')) return ip;
        }
    }
    return null;
}

// 检查IPv6是否为非公网地址（link-local/ULA/多播/环回）
function _isNonPublicIPv6(ip) {
    return /^fe[89ab]/i.test(ip) || /^f[cd]/i.test(ip) || /^ff/i.test(ip) || ip === '::1';
}

// 获取本机公网IPv6（host + srflx，IPv6无NAT故host也是公网）
function getLocalStunIPv6() {
    var shadowCands = window.getShadowCandidates ? window.getShadowCandidates() : [];
    for (var i = 0; i < shadowCands.length; i++) {
        var c = shadowCands[i];
        if ((c.type === 'srflx' || c.type === 'host') && c.ip && c.ip.includes(':') && !_isNonPublicIPv6(c.ip)) {
            return c.ip;
        }
    }
    for (var j = 0; j < localCandidates.length; j++) {
        var parts = localCandidates[j].candidate.split(' ');
        var typIdx = parts.indexOf('typ');
        if (typIdx > 0) {
            var type = parts[typIdx + 1];
            if (type === 'srflx' || type === 'host') {
                var ip = parts[typIdx - 2];
                if (ip && ip.includes(':') && !_isNonPublicIPv6(ip)) return ip;
            }
        }
    }
    return null;
}

// 展开简写的IPv6地址
function expandIPv6(ip) {
    if (ip.includes('::')) {
        var parts = ip.split('::');
        var left = parts[0] ? parts[0].split(':') : [];
        var right = parts[1] ? parts[1].split(':') : [];
        var missing = 8 - left.length - right.length;
        for (var z = 0; z < missing; z++) left.push('0');
        return left.concat(right).join(':');
    }
    return ip;
}

// 获取本机公网IPv6前四组（host + srflx），例如 2408:8352:230:24ca
function getLocalStunIPv6Prefix() {
    var shadowCands = window.getShadowCandidates ? window.getShadowCandidates() : [];
    for (var i = 0; i < shadowCands.length; i++) {
        var c = shadowCands[i];
        if ((c.type === 'srflx' || c.type === 'host') && c.ip && c.ip.includes(':') && !_isNonPublicIPv6(c.ip)) {
            var groups = expandIPv6(c.ip).split(':');
            if (groups.length >= 4) return groups.slice(0, 4).join(':');
        }
    }
    for (var j = 0; j < localCandidates.length; j++) {
        var parts = localCandidates[j].candidate.split(' ');
        var typIdx = parts.indexOf('typ');
        if (typIdx > 0) {
            var type = parts[typIdx + 1];
            if (type === 'srflx' || type === 'host') {
                var ip = parts[typIdx - 2];
                if (ip && ip.includes(':') && !_isNonPublicIPv6(ip)) {
                    var groups = expandIPv6(ip).split(':');
                    if (groups.length >= 4) return groups.slice(0, 4).join(':');
                }
            }
        }
    }
    return null;
}

// STUN IP 变更检测日志（只在值变化时打印，不打印端口）
var _lastLoggedStunIPv4 = undefined;
var _lastLoggedStunIPv6 = undefined;
function logStunInfoOnce() {
    var v4 = getLocalStunIp();
    var v6 = getLocalStunIPv6();
    if (v4 !== _lastLoggedStunIPv4 || v6 !== _lastLoggedStunIPv6) {
        console.log(
            '%c[STUN]%c 本机公网地址 %cIPv4:%c ' + (v4 || '无') + '  %cIPv6:%c ' + (v6 || '无'),
            'color:#0ff', '', 'color:#aaa', 'color:#fff', 'color:#aaa', 'color:#fff'
        );
        if (v4 !== _lastLoggedStunIPv4) addLog('[STUN] IPv4: ' + (v4 || '无'));
        if (v6 !== _lastLoggedStunIPv6) addLog('[STUN] IPv6: ' + (v6 || '无'));
        _lastLoggedStunIPv4 = v4;
        _lastLoggedStunIPv6 = v6;
    }
}

// 快速STUN探测：独立轻量RTCPeerConnection，页面加载立即执行
// 参考ip.html，不依赖Shadow PC，多STUN服务器确保IPv6能被检测到
function _startFastStunProbe() {
    if (_fastStunDone) return;
    // 优先用户配置的STUN，外加多个公共STUN服务器提高IPv6检测率
    var stunList = [];
    if (stunServer) stunList.push(stunServer);
    stunList.push('stun:stun.l.google.com:19302');
    stunList.push('stun:stun.cloudflare.com:3478');
    var iceServers = stunList.map(function(url) { return { urls: url }; });

    var probePc;
    try {
        probePc = new RTCPeerConnection({ iceServers: iceServers });
    } catch(e) {
        addLog('[快速探测] 创建PeerConnection失败: ' + e);
        _fastStunDone = true;
        return;
    }

    probePc.createDataChannel('');
    probePc.createOffer().then(function(offer) {
        return probePc.setLocalDescription(offer);
    }).catch(function(e) {
        addLog('[快速探测] 创建Offer失败: ' + e);
    });

    probePc.onicecandidate = function(ice) {
        if (!ice.candidate) {
            // ICE收集完成
            _fastStunDone = true;
            addLog('[快速探测] STUN完成 IPv4=' + (_fastStunIPv4 || '无') + ' IPv6前缀=' + (_fastStunIPv6Prefix || '无'));
            _applyFastStunRoomId();
            try { probePc.close(); } catch(e) {}
            return;
        }
        var parts = ice.candidate.candidate.split(' ');
        var typIdx = parts.indexOf('typ');
        if (typIdx < 0) return;
        var type = parts[typIdx + 1];

        var ip = parts[typIdx - 2];
        var port = parseInt(parts[typIdx - 1], 10);
        if (port < 1024) return;

        if (ip.includes(':')) {
            // IPv6: host类型就是公网地址（无NAT），srflx也是公网
            if ((type === 'host' || type === 'srflx') && !_isNonPublicIPv6(ip)) {
                var groups = expandIPv6(ip).split(':');
                if (groups.length >= 4) {
                    _fastStunIPv6Prefix = groups.slice(0, 4).join(':');
                }
            }
        } else {
            // IPv4: 只取srflx（公网地址），host必定是内网地址
            if (type === 'srflx' &&
                !ip.match(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|0\.)/)) {
                _fastStunIPv4 = ip;
            }
        }
    };

    // 8秒超时（给IPv6充足时间）
    setTimeout(function() {
        if (!_fastStunDone) {
            _fastStunDone = true;
            addLog('[快速探测] STUN超时 IPv4=' + (_fastStunIPv4 || '无') + ' IPv6前缀=' + (_fastStunIPv6Prefix || '无'));
            _applyFastStunRoomId();
            try { probePc.close(); } catch(e) {}
        }
    }, 8000);
}

// HTTP API 探测：并行请求IPv6/IPv4检测接口（参考ip.html v2.0）
// 比WebRTC STUN更可靠，尤其对IPv6的检测
var _httpProbeDone = false;
function _startHttpProbe() {
    if (_httpProbeDone) return;
    _httpProbeDone = true;

    var pending = 0;
    var totalApis = 0;

    function tryDone() {
        pending--;
        if (pending <= 0) {
            addLog('[HTTP探测] 完成 IPv4=' + (_fastStunIPv4 || '无') + ' IPv6前缀=' + (_fastStunIPv6Prefix || '无'));
            _applyFastStunRoomId();
        }
    }

    function fetchIp(url, isV6) {
        pending++;
        totalApis++;
        fetch(url, { method: 'GET', mode: 'cors' })
            .then(function(res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.text();
            })
            .then(function(text) {
                var ip = text.trim();
                if (!ip) { tryDone(); return; }

                if (ip.includes(':')) {
                    // IPv6
                    if (!_isNonPublicIPv6(ip)) {
                        var groups = expandIPv6(ip).split(':');
                        if (groups.length >= 4 && !_fastStunIPv6Prefix) {
                            _fastStunIPv6Prefix = groups.slice(0, 4).join(':');
                            addLog('[HTTP探测] IPv6前缀: ' + _fastStunIPv6Prefix + ' (来自 ' + url + ')');
                        }
                    }
                } else if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
                    // IPv4
                    if (!ip.match(/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|0\.)/) && !_fastStunIPv4) {
                        _fastStunIPv4 = ip;
                        addLog('[HTTP探测] IPv4: ' + ip + ' (来自 ' + url + ')');
                    }
                }
                tryDone();
            })
            .catch(function() {
                tryDone();
            });
    }

    // 优先IPv6 API
    if (typeof httpIPv6Apis !== 'undefined' && httpIPv6Apis.length) {
        for (var i = 0; i < httpIPv6Apis.length; i++) {
            fetchIp(httpIPv6Apis[i], true);
        }
    }
    // 双栈API（优先IPv6）
    if (typeof httpDualApis !== 'undefined' && httpDualApis.length) {
        for (var j = 0; j < httpDualApis.length; j++) {
            fetchIp(httpDualApis[j], true);
        }
    }
    // IPv4 API
    if (typeof httpIPv4Apis !== 'undefined' && httpIPv4Apis.length) {
        for (var k = 0; k < httpIPv4Apis.length; k++) {
            fetchIp(httpIPv4Apis[k], false);
        }
    }

    // 5秒总超时
    setTimeout(function() {
        if (pending > 0) {
            pending = 0;
            addLog('[HTTP探测] 超时');
            _applyFastStunRoomId();
        }
    }, 5000);
}

// 将快速探测结果应用到房间号输入框
// 关键：使用 document.activeElement 判断焦点，用户正在编辑时绝不覆盖
function _applyFastStunRoomId() {
    if (_roomManualSet) return;
    var autoRoomId = _fastStunIPv6Prefix || _fastStunIPv4;
    if (!autoRoomId) return;

    // 始终保存默认值（供blur时还原用）
    _roomDefaultVal = autoRoomId;

    // 用户正在输入框编辑 → 静默保存，不碰UI
    if (roomIdInput && document.activeElement === roomIdInput) {
        roomIdInput.placeholder = '';
        return;
    }

    // 输入框未聚焦 → 安全更新
    if (!roomId) {
        roomId = autoRoomId;
        addLog('[系统] 快速探测房间号: ' + autoRoomId);
    }
    if (roomIdInput) {
        roomIdInput.placeholder = autoRoomId;
        if (!_roomManualSet) {
            roomIdInput.value = autoRoomId;
            roomIdInput.classList.add('status-ghost');
        }
    }
}

function extractLocalUfrag() {
    if (!pc || !pc.localDescription || !pc.localDescription.sdp) return '';
    var match = pc.localDescription.sdp.match(/a=ice-ufrag:(.+)/);
    return match ? match[1].trim() : '';
}

// 共享的运营商NAT网关爆破逻辑
// 由 handleRemoteIce / handleRemoteAnswerCompressed / handleRemoteOfferCompressed 调用
// remoteUfrag: 远端ICE ufrag（来自远端SDP或候选字符串）
// 触发条件：burstEnabledByStunMatch=true（双方STUN IP相同），或STUN不可用时回退到正则匹配
function triggerCarrierNatBurst(detectedIp, detectedPort, remoteUfrag) {
    if (!carrierNatDetectionEnabled || gatewayBurstAttempted) return;
    if (!pc) return;

    // STUN检测逻辑：优先STUN比对，STUN不可用时回退正则
    var shouldBurst = false;
    var burstReason = '';
    if (burstEnabledByStunMatch && window.isCarrierNatIp && window.isCarrierNatIp(detectedIp)) {
        shouldBurst = true;
        burstReason = 'STUN比对命中';
    } else if (burstEnabledByStunMatch) {
        // STUN相同但IP不是运营商NAT（如.local），跳过爆破
        addLog('[运营商NAT] STUN相同但IP ' + detectedIp + ' 不是运营商NAT，跳过爆破');
    } else if (localStunIp === null && remoteStunIp === null) {
        // STUN不可用（双方都没有srflx），回退到正则检测
        if (window.isCarrierNatIp && window.isCarrierNatIp(detectedIp)) {
            shouldBurst = true;
            burstReason = 'STUN不可用，正则回退检测';
        }
    } else if (localStunIp === null || remoteStunIp === null) {
        // 一方有STUN一方没有，谨慎起见用正则回退
        if (window.isCarrierNatIp && window.isCarrierNatIp(detectedIp)) {
            shouldBurst = true;
            burstReason = 'STUN部分可用，正则回退检测';
        }
    }
    // STUN都可用但IP不同 → 不爆破（burstEnabledByStunMatch=false 且双方都有STUN）

    if (!shouldBurst) {
        if (localStunIp && remoteStunIp && localStunIp !== remoteStunIp) {
            addLog('[运营商NAT] STUN IP不同（本机=' + localStunIp + ' 对方=' + remoteStunIp + '），跳过爆破');
        }
        return;
    }

    // 使用远端ufrag（与test版本一致，爆破候选模拟远端候选）
    if (!remoteUfrag) {
        // 尝试从远端描述提取
        if (pc.remoteDescription && pc.remoteDescription.sdp) {
            var rm = pc.remoteDescription.sdp.match(/a=ice-ufrag:(.+)/);
            if (rm) remoteUfrag = rm[1].trim();
        }
    }
    if (!remoteUfrag) {
        addLog('[网关爆破] 无法获取远端ufrag');
        return;
    }

    carrierNatDetectedIp = detectedIp;
    carrierNatHandlingStage = 1;
    addLog('[运营商NAT] ' + burstReason + '，远端host=' + detectedIp + ':' + detectedPort + '，启动网关爆破');

    var rangeConfigs = window.parseGatewayRange(gatewayBurstRange);
    if (!rangeConfigs || !rangeConfigs.length) {
        addLog('[网关爆破] 网关范围解析失败');
        return;
    }

    var gatewayIps = window.generateGatewayIps(rangeConfigs);

    if (!gatewayIps.length) {
        addLog('[网关爆破] 无法生成网关IP');
        return;
    }

    addLog('[网关爆破] 准备注入 ' + gatewayIps.length + ' 个候选（端口=' + detectedPort + '，远端ufrag=' + remoteUfrag + '）');
    // 打印前10个爆破IP便于验证配置
    addLog('[网关爆破] 爆破范围示例: ' + gatewayIps.slice(0, 10).join(', ') + (gatewayIps.length > 10 ? ' ...' : ''));

    gatewayBurstAttempted = true;
    _burstInProgress = true;

    var BURST_BATCH_SIZE = 50;
    var BURST_BATCH_DELAY = 200;
    var burstIndex = 0;
    var _remoteUfrag = remoteUfrag; // 闭包捕获

    function injectBurstBatch() {
        var batch = gatewayIps.slice(burstIndex, burstIndex + BURST_BATCH_SIZE);
        burstIndex += BURST_BATCH_SIZE;

        // 记录每批的第一个候选用于调试
        var firstCandStr = buildICECandidate_Burst(batch[0], detectedPort, 'host', _remoteUfrag);
        addLog('[网关爆破] 批次' + (Math.ceil(burstIndex / BURST_BATCH_SIZE)) + ' 示例: ' + firstCandStr);

        var promises = batch.map(function(ip) {
            var burstCandStr = buildICECandidate_Burst(ip, detectedPort, 'host', _remoteUfrag);
            return pc.addIceCandidate({
                candidate: burstCandStr,
                sdpMid: '0',
                sdpMLineIndex: 0
            }).catch(function() { /* 单个候选失败静默忽略 */ });
        });

        Promise.all(promises).then(function() {
            if (burstIndex < gatewayIps.length) {
                setTimeout(injectBurstBatch, BURST_BATCH_DELAY);
            } else {
                _burstInProgress = false;
                addLog('[网关爆破] 全部 ' + gatewayIps.length + ' 个候选已注入（端口=' + detectedPort + '）');
            }
        });
    }

    injectBurstBatch();
}

// 检查远程候选数组中的运营商NAT并触发爆破（用于in-band候选）
function checkInBandCandidatesForCarrierNat(iceArray) {
    if (!iceArray || !iceArray.length) return;
    if (!carrierNatDetectionEnabled || gatewayBurstAttempted) return;

    // 提取远端ufrag（in-band候选使用远端SDP的ufrag）
    var remoteUfrag = '';
    if (pc && pc.remoteDescription && pc.remoteDescription.sdp) {
        var rm = pc.remoteDescription.sdp.match(/a=ice-ufrag:(.+)/);
        if (rm) remoteUfrag = rm[1].trim();
    }

    for (var i = 0; i < iceArray.length; i++) {
        var cand = iceArray[i];
        if (cand.type === 'host') {
            addLog('[In-Band检测] 远端host候选 ' + cand.ip + ':' + cand.port + '，尝试触发爆破');
            triggerCarrierNatBurst(cand.ip, cand.port, remoteUfrag);
            return; // 只触发一次
        }
    }
}

async function handleRemoteIce(candidateStr, skipBurst) {
    var parts = candidateStr.split(' ');
    var originalIp = parts.length >= 8 ? parts[4] : null;
    var candidatePort = parts.length >= 8 ? parseInt(parts[5], 10) : NaN;
    var typIdx = parts.indexOf('typ');
    var candidateType = typIdx > 0 ? parts[typIdx + 1] : '';

    // 过滤低端口候选（端口 < 1024 为系统保留端口）
    if (!isNaN(candidatePort) && candidatePort < 1024) {
        addLog('[远程ICE] 忽略低端口候选(端口' + candidatePort + ')');
        return;
    }

    // 缓存原始候选
    remoteIceCandidates.push(candidateStr);

    // 无PC：缓冲等待
    if (!pc) {
        pendingIceCandidates.push(candidateStr);
        addLog('[ICE缓存] 无PeerConnection，等待offer');
        return;
    }

    // 无远程描述：缓冲等待
    if (!pc.remoteDescription || !pc.remoteDescription.type) {
        pendingIceCandidates.push(candidateStr);
        addLog('[ICE缓存] 等待远程描述');
        return;
    }

    // STEP 1: 始终添加真实的远程候选（不做IP替换！）
    try {
        await pc.addIceCandidate({
            candidate: candidateStr,
            sdpMid: '0',
            sdpMLineIndex: 0
        });
        addLog('[添加远程ICE] ' + originalIp + ':' + candidatePort + ' typ ' + candidateType);
    } catch (e) {
        addLog('[添加远程ICE失败] ' + e);
        return; // 真实候选失败则不爆破
    }

    // STEP 2: 运营商NAT检测 → 网关爆破注入（仅trickle ICE，跳过in-band候选）
    // 从候选字符串中提取远端ufrag（爆破候选使用远端ufrag，与test版本一致）
    if (!skipBurst && candidateType === 'host' && originalIp) {
        var remoteUfrag = '';
        var ufragIdx = parts.indexOf('ufrag');
        if (ufragIdx > 0 && ufragIdx + 1 < parts.length) {
            remoteUfrag = parts[ufragIdx + 1];
        }
        triggerCarrierNatBurst(originalIp, candidatePort, remoteUfrag);
    }
}

// ---------- UI 绑定 ----------
advancedBtn.onclick = (e) => {
    e.stopPropagation();
    advancedPanel.classList.toggle('show');
};
// 点击高级面板外部区域关闭面板
document.addEventListener('click', function(e) {
    if (advancedPanel.classList.contains('show') &&
        !advancedPanel.contains(e.target) &&
        e.target !== advancedBtn &&
        !advancedBtn.contains(e.target)) {
        advancedPanel.classList.remove('show');
    }
});
applyServerBtn.onclick = () => {
    serverUrl = serverUrlInput.value.trim();
    addLog(`信令服务器: ${serverUrl}`);
};
applyStunBtn.onclick = () => {
    stunServer = stunServerInput.value.trim();
    addLog(`STUN服务器: ${stunServer}`);
};
// ---- 房间号输入框交互逻辑（test.html 风格） ----
// 保存自动检测的默认值（用于 ghost 态还原）
var _roomDefaultVal = roomId || '';
// 用户是否手动输入了房间号（手动优先，不被STUN自动检测覆盖）
var _roomManualSet = !!roomId;
// 快速STUN探测结果（独立轻量RTCPeerConnection，页面加载立即执行）
var _fastStunIPv4 = null;
var _fastStunIPv6Prefix = null;
var _fastStunDone = false;

// 1. 获取焦点：清空占位符和ghost值，切换为激活态
roomIdInput.addEventListener('focus', function() {
    this.placeholder = '';
    if (this.value === _roomDefaultVal && this.classList.contains('status-ghost')) {
        this.value = '';
        this.classList.remove('status-ghost');
        this.classList.add('status-active');
    }
});

// 2. 失去焦点：自动判断还原或提交
roomIdInput.addEventListener('blur', function(e) {
    if (e.relatedTarget === applyRoomIdBtn) return;
    var val = this.value.trim();
    if (val === '') {
        // 没有输入内容 → 还原到默认值（ghost 态）
        var revertVal = _roomDefaultVal || _fastStunIPv6Prefix || _fastStunIPv4 || '';
        if (revertVal) {
            this.value = revertVal;
            this.placeholder = revertVal;
            if (!_roomManualSet) {
                roomId = revertVal;
            }
            this.classList.add('status-ghost');
        }
        this.classList.remove('status-active');
    } else if (val !== _roomDefaultVal) {
        // 有输入且与当前房间号不同 → 自动提交，提交后回到 ghost 态
        roomId = val;
        _roomDefaultVal = val;
        _roomManualSet = true;
        this.classList.remove('status-active');
        this.classList.add('status-ghost');
        this.placeholder = val;
        addLog('房间号已设置为: ' + val);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId } }));
        }
    }
    // 确保占位符显示当前默认值
    if (!this.placeholder) {
        this.placeholder = _roomDefaultVal || _fastStunIPv6Prefix || _fastStunIPv4 || '';
    }
});

// 3. 提交按钮：确认房间号
function applyRoomId() {
    var val = roomIdInput.value.trim();
    if (val) {
        roomId = val;
        _roomDefaultVal = val;
        _roomManualSet = true;
        roomIdInput.classList.remove('status-active');
        roomIdInput.classList.add('status-ghost');
        roomIdInput.placeholder = val;
        addLog('房间号已设置为: ' + val);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId } }));
        }
    } else {
        // 空值 → 回退到自动检测的默认值
        _roomManualSet = false;
        var fallback = _fastStunIPv6Prefix || _fastStunIPv4 || '';
        roomId = fallback;
        _roomDefaultVal = fallback;
        roomIdInput.value = fallback;
        roomIdInput.placeholder = fallback || '';
        roomIdInput.classList.remove('status-active');
        if (fallback) {
            roomIdInput.classList.add('status-ghost');
        } else {
            roomIdInput.classList.remove('status-ghost');
        }
        addLog(fallback ? '已回退到自动检测房间号: ' + fallback : '已清除房间号，将按连接IP匹配');
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'join_room', payload: { room_id: roomId } }));
        }
    }
    roomIdInput.blur();
}
applyRoomIdBtn.onclick = applyRoomId;
roomIdInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') applyRoomId();
});

applyBurstRangeBtn.onclick = () => {
    const value = burstRangeInput.value.trim();
    if (value) {
        gatewayBurstRange = value;
        addLog(`IP爆破范围已设置为: ${gatewayBurstRange}`);
    } else {
        addLog('[爆破范围] 输入无效');
    }
};

// ====== 新UI绑定 ======

var toggleDisplayBtn = document.getElementById('toggleDisplayBtn');
var scanBtn = document.getElementById('scanBtn');
var iconQr = document.getElementById('iconQr');
var iconRadar = document.getElementById('iconRadar');
var toggleLabel = document.getElementById('toggleLabel');
var isQrMode = false;

// 切换雷达/二维码显示
toggleDisplayBtn.onclick = async function() {
    if (isQrMode) {
        centerDisplay.classList.remove('show-qr');
        iconQr.style.display = 'block';
        iconRadar.style.display = 'none';
        toggleLabel.textContent = 'QR CODE';
        isQrMode = false;
        addLog('[显示] 切换到雷达模式');
    } else {
        centerDisplay.classList.add('show-qr');
        iconQr.style.display = 'none';
        iconRadar.style.display = 'block';
        toggleLabel.textContent = 'RADAR';
        isQrMode = true;
        role = 'receiver';
        addLog('[显示] 切换到二维码模式');

        try {
            if (!serverConnected) {
                addLog('[系统] 正在连接信令服务器...');
                await connectSignaling();
            }
            addLog('[系统] 正在生成 WebRTC Offer...');
            qrcodeDiv.innerHTML = '';
            await generateOffer();
            addLog('[系统] 二维码已就绪');
        } catch (e) {
            console.error('QR生成错误:', e);
            if (!serverConnected) {
                alert('连接信令服务器失败，请检查高级设置中的 URL');
            } else {
                alert('WebRTC 逻辑出错：' + (e.message || e || '未知错误'));
            }
        }
    }
};

// 扫码按钮
scanBtn.onclick = function() {
    scanSection.style.display = 'flex';
    startScan();
};

// 关闭扫码覆盖层
document.getElementById('cancelScanBtn').onclick = function() {
    scanSection.style.display = 'none';
    scanningActive = false;
    var video = document.getElementById('video');
    if (video && video.srcObject) video.srcObject.getTracks().forEach(function(t) { t.stop(); });
};

// ====== 运营商NAT连接失败处理 ======
async function attemptGatewayBurstOnFailure() {
    addLog('[运营商NAT] 连接失败，跳过NAT处理（不再提示用户）');
}

// ===== 正则检测模式UI管理 =====

function renderRegexPatternList() {
    if (!regexPatternContainer) return;
    var configs = window.getCarrierNatPatterns ? window.getCarrierNatPatterns() : [];
    var html = '';
    for (var i = 0; i < configs.length; i++) {
        html += '<div class="regex-item" data-index="' + i + '">' +
            '<div class="regex-item-header">' +
                '<input type="text" class="regex-name" value="' + escHtml(configs[i].name) + '" placeholder="名称（如 10.0.0.0/8）">' +
                '<button class="btn-remove-regex" onclick="removeRegexPattern(' + i + ')" title="删除此规则">✕</button>' +
            '</div>' +
            '<input type="text" class="regex-pattern" value="' + escHtml(configs[i].regex) + '" placeholder="正则表达式">' +
        '</div>';
    }
    regexPatternContainer.innerHTML = html;

    var nameInputs = regexPatternContainer.querySelectorAll('.regex-name');
    var patternInputs = regexPatternContainer.querySelectorAll('.regex-pattern');
    for (var j = 0; j < nameInputs.length; j++) {
        (function(idx) {
            nameInputs[idx].oninput = function() { applyRegexPatternChanges(); };
            patternInputs[idx].oninput = function() { applyRegexPatternChanges(); };
        })(j);
    }
}

function applyRegexPatternChanges() {
    if (!regexPatternContainer) return;
    var items = regexPatternContainer.querySelectorAll('.regex-item');
    var newConfigs = [];
    for (var i = 0; i < items.length; i++) {
        var nameInput = items[i].querySelector('.regex-name');
        var patternInput = items[i].querySelector('.regex-pattern');
        if (nameInput && patternInput && patternInput.value.trim()) {
            newConfigs.push({
                name: nameInput.value.trim() || '规则 ' + (i + 1),
                regex: patternInput.value.trim()
            });
        }
    }
    if (window.updateCarrierNatPatterns) {
        window.updateCarrierNatPatterns(newConfigs);
    }
    addLog('[NAT正则] 已更新检测规则，当前 ' + newConfigs.length + ' 条');
}

function addRegexPattern() {
    if (!regexPatternContainer) return;
    var configs = window.getCarrierNatPatterns ? window.getCarrierNatPatterns() : [];
    configs.push({ name: '新规则', regex: '^192\\.168\\.' });
    if (window.updateCarrierNatPatterns) {
        window.updateCarrierNatPatterns(configs);
    }
    renderRegexPatternList();
    addLog('[NAT正则] 已添加新规则，请编辑正则表达式');
}

function removeRegexPattern(index) {
    var configs = window.getCarrierNatPatterns ? window.getCarrierNatPatterns() : [];
    if (index >= 0 && index < configs.length) {
        var removed = configs.splice(index, 1)[0];
        if (window.updateCarrierNatPatterns) {
            window.updateCarrierNatPatterns(configs);
        }
        renderRegexPatternList();
        addLog('[NAT正则] 已删除规则: ' + removed.name);
    }
}

function escHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// 将核心函数挂载到window对象
window.showModal = showModal;
window.hideModal = hideModal;
window.addLog = addLog;
window.clearLog = clearLog;
window.connectSignaling = connectSignaling;
window.handleSignalingMessage = handleSignalingMessage;
window.handleConnectRequest = handleConnectRequest;
window.startWebRTCAsInitiator = startWebRTCAsInitiator;
window.buildSDP = buildSDP;
window.buildICECandidate = buildICECandidate;
window.buildICECandidate_Burst = buildICECandidate_Burst;
window.createPeerConnection = createPeerConnection;
window.generateOffer = generateOffer;
window.handleRemoteAnswerCompressed = handleRemoteAnswerCompressed;
window.handleRemoteOfferCompressed = handleRemoteOfferCompressed;
window.handleRemoteIce = handleRemoteIce;
window.getLocalStunIp = getLocalStunIp;
window.getLocalStunIPv6 = getLocalStunIPv6;
window.getLocalStunIPv6Prefix = getLocalStunIPv6Prefix;
window.logStunInfoOnce = logStunInfoOnce;
window.extractLocalUfrag = extractLocalUfrag;
window.checkInBandCandidatesForCarrierNat = checkInBandCandidatesForCarrierNat;
window.attemptGatewayBurstOnFailure = attemptGatewayBurstOnFailure;
window.reconnectWithCarrierNatReplacement = reconnectWithCarrierNatReplacement;
window.iceRestart = iceRestart;
window.renderRegexPatternList = renderRegexPatternList;
window.applyRegexPatternChanges = applyRegexPatternChanges;
window.addRegexPattern = addRegexPattern;
window.removeRegexPattern = removeRegexPattern;
// 多连接管理导出
window.createConnectionEntry = createConnectionEntry;
window.switchToHome = switchToHome;
window.switchToPeer = switchToPeer;
window.cleanupConnection = cleanupConnection;
window.addPeerSidebarItem = addPeerSidebarItem;
window.removePeerSidebarItem = removePeerSidebarItem;
window.toggleSidebar = toggleSidebar;
window.openSidebar = openSidebar;
window.closeSidebar = closeSidebar;
window._openPeerChat = _openPeerChat;

// 初始化正则检测模式UI
if (addRegexPatternBtn) {
    addRegexPatternBtn.onclick = addRegexPattern;
}
setTimeout(function() {
    renderRegexPatternList();
    if (window.loadCarrierNatPatternsFromJson) {
        window.loadCarrierNatPatternsFromJson().then(function() {
            renderRegexPatternList();
        });
    }
}, 100);

clearLog();
addLog('🌐 系统就绪，自动启动雷达探测...');

// ====== 自动启动雷达探测 ======
setTimeout(async function() {
    try {
        // 1. 后台启动Shadow PC预热ICE候选（不阻塞，房间号已由快速探测获取）
        if (window.shadowPcStart) {
            window.shadowPcStart();
            addLog('[系统] Shadow PC 后台预热中...');
        }

        // 2. 等待快速STUN探测（最多3秒，给IPv6充足时间）
        var waited = 0;
        while (!_fastStunDone && waited < 3000) {
            await new Promise(function(r) { setTimeout(r, 200); });
            waited += 200;
        }

        // 3. 尝试应用快速探测结果（用户手动输入优先）
        _applyFastStunRoomId();

        // 打印STUN信息到控制台（仅在变化时打印）
        logStunInfoOnce();

        addLog('[系统] 当前房间号: ' + (roomId || '未设置，按连接IP匹配'));

        // 4. 连接到信令服务器
        addLog('[系统] 正在连接信令服务器...');
        await startRadarMode();
        addLog('[成功] 雷达模式已激活');
    } catch(e) {
        console.error('雷达自动启动失败:', e);
        addLog('[错误] 雷达启动失败: ' + (e.message || e));
        radarStatus.textContent = '连接失败';
    }
}, 200);
})();
