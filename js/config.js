// WebRTC内网直传 - 全局配置和状态变量
// 注意：此文件必须最先加载，确保所有全局变量在其他脚本之前声明

// ========== WebRTC连接状态 ==========
var ws = null;              // WebSocket信令连接
var pc = null;              // 当前激活的RTCPeerConnection对象
var dc = null;              // 当前激活的RTCDataChannel对象

// ========== 多连接管理 ==========
var connections = {};       // { peerId: { pc, dc, role, messages, targetId, container } }
var activePeerId = null;    // 当前选中的侧边栏peerId（null = 首页）

// ========== 用户身份和连接目标 ==========
var myId = null;            // 当前用户ID（由信令服务器分配）
var targetId = null;        // 当前激活的目标用户ID
var role = null;            // 当前激活的角色：'receiver'(主动方) 或 'sender'(被动方)

// ========== ICE候选和SDP信息 ==========
var localCandidates = [];   // 本地收集的ICE候选
var pendingIceCandidates = []; // 缓存早期收到的远程ICE候选

// ========== 文件传输状态 ==========
var receiveBuffer = [];     // 文件接收缓冲区
var receivedFileName = '';  // 接收的文件名
var receivedFileSize = 0;   // 接收的文件大小

// ========== 信令服务器配置 ==========
var serverUrl = "beacon.cliayn.top/parties/my-server/default";      // 信令服务器地址
var stunServer = "stun:stun.l.google.com:19302"; // STUN服务器地址
var serverConnected = false;                // 信令连接状态

// ========== HTTP IP探测 API（可自行增删改） ==========
var httpIPv6Apis = [                        // 纯IPv6检测
    'https://api-ipv6.ip.sb/ip',
    'https://ipv6.icanhazip.com'
];
var httpIPv4Apis = [                        // 纯IPv4检测
    'https://api-ipv4.ip.sb/ip',
    'https://ipv4.icanhazip.com'
];
var httpDualApis = [                        // 优先IPv6，无IPv6则返回IPv4
    'https://ip.sb/ip'
];

// ========== 网络探查状态 ==========
var peerNodes = [];         // 发现的设备节点列表
var roomId = '';            // 当前房间号（用于雷达匹配，空字符串表示无房间号）

// ========== 扫描和UI状态 ==========
var scanningActive = false; // 二维码扫描激活状态

// ========== 模态框状态 ==========
var modalResolve = null;    // 模态框Promise解析函数

// ========== DOM元素引用 ==========
// 注意：这些变量将在DOM加载后由main.js初始化
var advancedBtn = null;
var advancedPanel = null;
var serverUrlInput = null;
var applyServerBtn = null;
var stunServerInput = null;
var applyStunBtn = null;
var roomIdInput = null;
var applyRoomIdBtn = null;
var logBox = null;
var scanSection = null;
var myIdDisplay = null;
var peersGroup = null;
var radarStatus = null;
var sidebarItems = null;     // 侧边栏用户列表容器
var scanSection = null;
var qrcodeDiv = null;
var modalOverlay = null;
var modalTitle = null;
var modalMessage = null;
var modalCancelBtn = null;
var modalConfirmBtn = null;

// ========== 爆破范围配置DOM元素 ==========
var burstRangeInput = null;
var applyBurstRangeBtn = null;

// ========== 正则检测模式DOM元素 ==========
var regexPatternContainer = null;
var addRegexPatternBtn = null;

// ========== 内网预测和网关爆破配置 ==========
var carrierNatDetectionEnabled = true;           // 是否启用运营商NAT检测
var gatewayBurstRange = "192.168.1-254.1;172.20.10.1";          // 网关爆破范围，用";"分隔多个，支持格式: 单IP、192.168.1-254(第三段范围)、192.168.1.1-254(第四段范围)
var realtimeGatewayBurstEnabled = true;          // 是否启用实时网关爆破（检测到运营商NAT立即添加候选）
var maxGatewayAttempts = 255;                    // 最大网关尝试数
var manualIpFallbackEnabled = true;              // 是否启用手动IP回退

// 运营商NAT检测正则配置统一由 assets/carrier-nat-patterns.json 管理
var remoteIceCandidates = [];                    // 收集的远程ICE候选
var gatewayBurstAttempted = false;               // 网关爆破是否已尝试
var connectionFailureCount = 0;                  // 连接失败计数
var carrierNatReplacementMap = {};               // 运营商NAT IP -> 替换IP映射
var pendingCarrierNatReplacement = false;        // 是否有待处理的运营商NAT替换
var pendingReplacementIps = [];                  // 待处理的替换IP列表（用于爆破）
var carrierNatRealTimeDetectionTriggered = false; // 实时检测是否已触发
var carrierNatHandlingStage = 0;                 // 运营商NAT处理阶段: 0=未处理, 1=已自动爆破, 2=已询问用户, 3=全部失败
var carrierNatDetectedIp = null;                 // 当前检测到的运营商NAT IP
var localStunIp = null;                           // 本机STUN服务器返回的IPv4（srflx候选IP）
var remoteStunIp = null;                          // 对方STUN服务器返回的IPv4（srflx候选IP）
var burstEnabledByStunMatch = false;              // 是否通过STUN IP比对启用爆破（true=双方STUN IP相同，需爆破）

// ========== Shadow PC 预热模块 ==========
var shadowPc = null;                             // 隐藏的预热用RTCPeerConnection
var shadowPcTimer = null;                        // 30秒刷新定时器
var _shadowCandidateCache = [];                  // 缓存的热身候选 [{ip, port, type}]
var shadowPcActive = false;                      // 预热模块生命周期标志
var _embeddedIceSet = {};                        // 已在SDP中嵌入的候选 "ip:port" -> true 去重表
var _burstInProgress = false;                    // 网关爆破是否正在进行（防ICE震荡）

console.log('[配置] 全局变量已初始化');
