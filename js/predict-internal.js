// 内网预测和网关爆破模块
// 依赖的全局变量：pc, targetId, localCandidates, gatewayBurstRange, maxGatewayAttempts, carrierNatDetectionEnabled, manualIpFallbackEnabled
// 依赖的全局函数：addLog, showModal, buildICECandidate

// 运营商NAT检测模式（优先从 assets/carrier-nat-patterns.json 加载）
var carrierNatPatterns = [];           // 编译后的 RegExp 对象数组
var carrierNatPatternConfigs = [];     // 用户可配置的 { name, regex } 数组

// ⚠️ 内建兜底规则 —— 必须与 assets/carrier-nat-patterns.json 的 patterns 保持一致
// 为什么需要：直接双击打开 index.html 时页面处于 file:// 协议，fetch 本地文件会被
// 浏览器以 Origin: null 拦截并抛出 TypeError，导致正则列表空白、运营商NAT检测失效。
// 本数组保证任何协议下（含离线 file://）NAT 检测开箱可用；http(s) 下仍优先读 JSON。
var DEFAULT_CARRIER_NAT_PATTERNS = [
    {
        name: 'RFC1918 - 10.0.0.0/8',
        regex: '^10\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$'
    },
    {
        name: 'RFC6598 - Carrier-Grade NAT 100.64.0.0/10',
        regex: '^100\\.(?:6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7])\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$'
    }
];

// 初始化检测模式：先用内建规则填充，保证 NAT 检测立即可用（不等 fetch）
function initCarrierNatPatterns() {
    if (carrierNatPatternConfigs.length === 0) {
        carrierNatPatternConfigs = DEFAULT_CARRIER_NAT_PATTERNS.map(function(p) {
            return { name: p.name, regex: p.regex };
        });
    }
    compileCarrierNatPatterns();
    if (typeof addLog === 'function') addLog('[内网预测] 已启用内建规则 ' + carrierNatPatterns.length + ' 条，尝试从 JSON 覆盖...');
}

// 重新编译检测模式
function compileCarrierNatPatterns() {
    carrierNatPatterns = carrierNatPatternConfigs.map(function(c) {
        try { return new RegExp(c.regex); }
        catch(e) { console.error('[正则错误] ' + c.name + ': ' + e.message); return null; }
    }).filter(Boolean);
}

// 获取当前检测模式配置
function getCarrierNatPatterns() {
    return carrierNatPatternConfigs;
}

// 更新检测模式配置
function updateCarrierNatPatterns(newConfigs) {
    carrierNatPatternConfigs = newConfigs;
    compileCarrierNatPatterns();
    if (typeof addLog === 'function') addLog('[检测规则] 已更新 ' + carrierNatPatterns.length + ' 条检测规则');
}

// 从 JSON 文件加载检测模式；失败（file:// / 离线 / CORS）时保留内建兜底规则
async function loadCarrierNatPatternsFromJson() {
    var loaded = false;
    try {
        var resp = await fetch('assets/carrier-nat-patterns.json');
        if (resp.ok) {
            var data = await resp.json();
            if (data.patterns && data.patterns.length > 0) {
                carrierNatPatternConfigs = data.patterns.map(function(p) {
                    return { name: p.name || p.cidr, regex: p.regex };
                });
                compileCarrierNatPatterns();
                loaded = true;
                if (typeof addLog === 'function') addLog('[检测规则] 从文件加载 ' + carrierNatPatterns.length + ' 条规则');
            }
        }
    } catch(e) {
        // file:// 下 fetch 本地文件会被拦截，静默走兜底
    }

    if (!loaded) {
        // 保留 initCarrierNatPatterns 填充的内建规则，确保 NAT 检测不失效
        compileCarrierNatPatterns();
        var reason = (typeof location !== 'undefined' && location.protocol === 'file:')
            ? 'file:// 协议禁止读取本地文件'
            : 'JSON 加载失败';
        if (typeof addLog === 'function') {
            addLog('[检测规则] ' + reason + '，使用内建默认规则 ' + carrierNatPatterns.length + ' 条');
        }
    }
    return loaded;
}

// 初始化默认模式
initCarrierNatPatterns();

// 检测IP是否为运营商NAT
function isCarrierNatIp(ip) {
    if (!ip || typeof ip !== 'string') return false;
    return carrierNatPatterns.some(pattern => pattern.test(ip));
}

// 解析网关爆破范围字符串，支持";"分隔多个IP/范围
// 支持格式:
//   单IP: "172.20.10.1"
//   第三段范围(旧格式): "192.168.1-254.1" → 生成 192.168.1.1 ~ 192.168.254.1
//   第三段范围(简写): "192.168.1-254" → 同上，第四段默认.1
//   第四段范围: "192.168.1.1-254" → 生成 192.168.1.1 ~ 192.168.1.254
//   多段组合: "192.168.1-254;172.20.10.1"
// 返回配置数组，失败返回空数组
function parseGatewayRange(rangeStr) {
    if (!rangeStr || typeof rangeStr !== 'string') return [];

    var segments = rangeStr.split(';');
    var configs = [];

    for (var s = 0; s < segments.length; s++) {
        var seg = segments[s].trim();
        if (!seg) continue;

        var parts = seg.split('.');
        var rangeIdx = -1;
        for (var i = 0; i < parts.length; i++) {
            if (parts[i].includes('-')) { rangeIdx = i; break; }
        }

        if (rangeIdx === -1 && parts.length === 4) {
            // 单IP: 172.20.10.1
            var valid = parts.every(function(p) {
                var n = parseInt(p, 10);
                return !isNaN(n) && n >= 0 && n <= 255;
            });
            if (valid) {
                configs.push({ type: 'single', ip: seg });
            } else {
                addLog('[网关解析] IP格式无效: ' + seg);
            }
        } else if (rangeIdx >= 0) {
            var rangeParts = parts[rangeIdx].split('-');
            var start = parseInt(rangeParts[0], 10);
            var end = parseInt(rangeParts[1], 10);
            if (isNaN(start) || isNaN(end) || start < 0 || start > 255 || end < 0 || end > 255) {
                addLog('[网关解析] 范围无效: ' + seg);
                continue;
            }

            // 构建前缀（范围之前的段）
            var prefixParts = [];
            for (var j = 0; j < rangeIdx; j++) {
                var n = parseInt(parts[j], 10);
                if (isNaN(n) || n < 0 || n > 255) { prefixParts = null; break; }
                prefixParts.push(parts[j]);
            }
            if (!prefixParts) { addLog('[网关解析] 前缀无效: ' + seg); continue; }
            var prefix = prefixParts.join('.');

            // 构建后缀（范围之后的段）
            var suffixOctets = [];
            for (var k = rangeIdx + 1; k < parts.length; k++) {
                var n2 = parseInt(parts[k], 10);
                if (isNaN(n2) || n2 < 0 || n2 > 255) { suffixOctets = null; break; }
                suffixOctets.push(parts[k]);
            }
            if (!suffixOctets) { addLog('[网关解析] 后缀无效: ' + seg); continue; }

            // 3段简写格式如 "192.168.1-254": rangeIdx=2 但没有后缀 → 默认第四段为.1
            if (rangeIdx === 2 && parts.length === 3 && suffixOctets.length === 0) {
                suffixOctets = ['1'];
            }

            // 验证总段数合理（前缀 + 1段范围 + 后缀 = 4段）
            if (prefixParts.length + 1 + suffixOctets.length !== 4) {
                addLog('[网关解析] 段数不正确(需4段): ' + seg + ' (前缀' + prefixParts.length + '+范围1+后缀' + suffixOctets.length + ')');
                continue;
            }

            configs.push({
                type: 'range',
                prefix: prefix,
                rangeStart: start,
                rangeEnd: end,
                rangePosition: rangeIdx,
                suffixOctets: suffixOctets
            });
        } else {
            addLog('[网关解析] 无法识别的格式: ' + seg);
        }
    }

    if (configs.length === 0) {
        addLog('[网关解析] 未解析出有效配置');
    } else {
        addLog('[网关解析] 解析出 ' + configs.length + ' 个IP范围/地址');
    }
    return configs;
}

// 生成网关IP列表（支持多范围配置）
function generateGatewayIps(rangeConfigs) {
    if (!Array.isArray(rangeConfigs)) {
        // 兼容旧调用（单配置对象）
        rangeConfigs = [rangeConfigs];
    }

    var ips = [];

    for (var i = 0; i < rangeConfigs.length; i++) {
        var cfg = rangeConfigs[i];

        if (cfg.type === 'single') {
            ips.push(cfg.ip);
        } else if (cfg.type === 'range') {
            var suffixStr = cfg.suffixOctets.length > 0 ? '.' + cfg.suffixOctets.join('.') : '';
            for (var v = cfg.rangeStart; v <= cfg.rangeEnd; v++) {
                ips.push(cfg.prefix + '.' + v + suffixStr);
                if (ips.length >= maxGatewayAttempts) break;
            }
        }
        if (ips.length >= maxGatewayAttempts) break;
    }

    addLog('[网关生成] 生成 ' + ips.length + ' 个网关IP');
    return ips;
}

// 为网关IP创建ICE候选并添加到PeerConnection
function addGatewayIceCandidates(gatewayIps, originalPort, ufrag) {
    if (!pc || !gatewayIps.length) return;

    addLog(`[网关ICE] 添加 ${gatewayIps.length} 个网关候选，端口: ${originalPort}（仅本端使用，不发送给对方）`);

    gatewayIps.forEach(ip => {
        // 创建host类型的ICE候选
        const candidateStr = buildICECandidate(ip, originalPort, 'host', ufrag);
        const candidate = new RTCIceCandidate({
            candidate: candidateStr,
            sdpMid: '0',
            sdpMLineIndex: 0
        });

        try {
            pc.addIceCandidate(candidate);
            addLog(`[网关ICE] 添加候选: ${ip}:${originalPort}`);
            // 注意：这些网关IP候选仅在自己端添加，不发送给对方
            // 因为对方可能在内网，使用运营商NAT地址，我们尝试猜测其网关IP

            // 更新候选状态
            if (window.gatewayCandidateStatus) {
                window.gatewayCandidateStatus[ip] = { status: 'added', time: Date.now() };
            }
            // 更新状态显示
            if (window.updateGatewayStatusDisplay) {
                window.updateGatewayStatusDisplay();
            }
        } catch (err) {
            addLog(`[网关ICE错误] ${ip}: ${err.message}`);
            if (window.gatewayCandidateStatus) {
                window.gatewayCandidateStatus[ip] = { status: 'failed', time: Date.now(), error: err.message };
            }
            // 更新状态显示
            if (window.updateGatewayStatusDisplay) {
                window.updateGatewayStatusDisplay();
            }
        }
    });
}

// 【已废弃】实时运营商NAT替换函数
// 旧版逻辑会替换真实IP，导致连接失败。新逻辑在 main.js 的 handleRemoteIce() 中：
// 先添加真实候选，再批量注入爆破候选（相同端口 + 降低priority）
// 保留此函数仅为向后兼容，不再执行任何实际操作
function setupRealtimeReplacement(carrierNatIp) {
    if (typeof addLog === 'function') addLog('[实时替换] 已废弃，新逻辑由 handleRemoteIce 处理');
    return null;
}

// 旧版实时爆破函数（已废弃）
function triggerRealtimeGatewayBurst(carrierNatIp, remotePort, remoteCandidateStr) {
    if (typeof addLog === 'function') addLog('[实时爆破] 已废弃，新逻辑由 handleRemoteIce 处理');
    return false;
}

// 检测对方IP并触发网关爆破
// remoteIps: 对方IP数组（从ICE候选中提取）
// remotePort: 对方端口（通常所有候选端口相同）
// ufrag: ICE用户名片段
function triggerGatewayBurst(remoteIps, remotePort, ufrag) {
    if (!carrierNatDetectionEnabled) {
        addLog('[网关爆破] 运营商NAT检测已禁用');
        return false;
    }

    // 检查是否有运营商NAT IP
    const carrierNatIp = remoteIps.find(ip => isCarrierNatIp(ip));
    if (!carrierNatIp) {
        addLog('[网关爆破] 未检测到运营商NAT IP');
        return false;
    }

    addLog(`[网关爆破] 检测到运营商NAT IP: ${carrierNatIp}`);

    // 解析网关范围
    var rangeConfigs = parseGatewayRange(gatewayBurstRange);
    if (!rangeConfigs.length) {
        addLog('[网关爆破] 网关范围解析失败');
        return false;
    }

    // 生成网关IP
    const gatewayIps = generateGatewayIps(rangeConfigs);
    if (!gatewayIps.length) {
        addLog('[网关爆破] 无网关IP生成');
        return false;
    }

    // 添加ICE候选
    addGatewayIceCandidates(gatewayIps, remotePort, ufrag);
    return true;
}

// 手动IP回退：弹窗让用户输入对端内网IP
async function manualIpFallback(detectedCarrierNatIp, remotePort, ufrag) {
    if (!manualIpFallbackEnabled) return null;

    addLog('[手动回退] 启动手动IP回退');

    const userInput = await showModal(
        '手动指定内网IP',
        `检测到对方IP ${detectedCarrierNatIp} 为运营商NAT地址，自动网关爆破失败。\n\n` +
        `请手动输入对方的内网IP地址（例如 192.168.1.100）：`
    );

    if (userInput === false) return null; // 用户取消

    // 用户输入的是字符串 true（确认），但我们需要文本输入框
    // 由于现有showModal只有确认/取消，我们需要扩展或创建新的输入模态框
    // 暂时简化：使用prompt
    try {
        const ip = prompt(`请输入对方的内网IP地址（当前端口: ${remotePort}）:`, '192.168.1.100');
        if (!ip) return null;

        // 简单验证IP格式
        const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        if (!ipRegex.test(ip)) {
            alert('IP地址格式无效');
            return null;
        }

        // 创建ICE候选
        const candidateStr = buildICECandidate(ip, remotePort, 'host', ufrag);
        const candidate = new RTCIceCandidate({
            candidate: candidateStr,
            sdpMid: '0',
            sdpMLineIndex: 0
        });

        pc.addIceCandidate(candidate);
        addLog(`[手动回退] 添加手动IP候选: ${ip}:${remotePort}`);
        // 注意：手动输入的IP候选仅在自己端添加，不发送给对方
        // 因为对方可能在内网，使用运营商NAT地址，我们尝试猜测其内网IP

        return ip;
    } catch (err) {
        addLog(`[手动回退错误] ${err.message}`);
        return null;
    }
}

// 提取远程ICE候选中的IP和端口
function extractRemoteIpsAndPort(remoteCandidates) {
    const ips = new Set();
    let port = null;

    remoteCandidates.forEach(candidateStr => {
        // 解析ICE候选字符串，格式: "candidate:... udp ... IP PORT typ ..."
        const parts = candidateStr.split(' ');
        if (parts.length < 8) return;

        const ip = parts[4];
        const candidatePort = parseInt(parts[5], 10);

        if (ip && !ip.includes(':')) { // 忽略IPv6
            ips.add(ip);
            if (port === null && !isNaN(candidatePort)) {
                port = candidatePort;
            }
        }
    });

    return {
        ips: Array.from(ips),
        port: port
    };
}

// 初始化模块
function initInternalPrediction() {
    addLog('[内网预测] 模块初始化完成');
}

// 导出全局函数
window.isCarrierNatIp = isCarrierNatIp;
window.parseGatewayRange = parseGatewayRange;
window.generateGatewayIps = generateGatewayIps;
window.addGatewayIceCandidates = addGatewayIceCandidates;
window.triggerGatewayBurst = triggerGatewayBurst;
window.setupRealtimeReplacement = setupRealtimeReplacement;
window.triggerRealtimeGatewayBurst = triggerRealtimeGatewayBurst;
window.manualIpFallback = manualIpFallback;
window.extractRemoteIpsAndPort = extractRemoteIpsAndPort;
window.initInternalPrediction = initInternalPrediction;
window.getCarrierNatPatterns = getCarrierNatPatterns;
window.updateCarrierNatPatterns = updateCarrierNatPatterns;
window.loadCarrierNatPatternsFromJson = loadCarrierNatPatternsFromJson;
window.compileCarrierNatPatterns = compileCarrierNatPatterns;