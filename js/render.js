/**
 * 聊天消息的富文本渲染：Markdown + 图表 + 流程图。
 *
 * 为什么是这个形状（这几条决定了整个文件的写法，改之前先读）：
 *
 *  1. **只吃数据，不吃 HTML。** 对端是不可信的 —— 房间号是唯一的门槛，
 *     而「这是 AI 发的」靠消息里的 device 字段判断，那个字段是对端自己填的。
 *     所以这里**没有任何一处 innerHTML**：文字一律 createTextNode，图形用
 *     createElementNS 建 SVG。安全性不来自「转义写得对」，而来自整条链路上
 *     根本没有把字符串当 HTML 解析的代码路径。
 *
 *  2. **一律 SVG，不用 canvas。** 不只是为了矢量清晰 —— jsdom 没装 canvas 原生模块，
 *     getContext('2d') 会抛错，而网页端测试断言「载入期间没有脚本异常」必须为空。
 *     用 canvas 会让测试直接挂掉。
 *
 *  3. **不调 getBBox() / getComputedTextLength()。** jsdom 没实现它们。
 *     所有尺寸都用固定 viewBox + 按字符数估算宽度算出来，布局是确定的、可断言的。
 *
 *  4. **降级是常态。** 对端发来的 JSON/语法不可信，畸形输入是预期情况而不是异常。
 *     任何解析失败都退回「原样显示代码块」，绝不抛异常、绝不吞掉消息。
 */
(function () {
    'use strict';

    var SVG_NS = 'http://www.w3.org/2000/svg';

    // 单个块最大 256KB、最多 2000 个数据点。
    // 对端塞一个巨大的 JSON 过来就能让页面卡死，这里先设防。
    var MAX_BLOCK_BYTES = 256 * 1024;
    var MAX_POINTS = 2000;

    // 浅灰气泡（#f0f4f9）上能看清的一组颜色
    var PALETTE = ['#007bff', '#e63946', '#2a9d8f', '#f4a261', '#6f42c1', '#17a2b8', '#d63384', '#6c757d'];
    // A 股习惯：红涨绿跌
    var UP_COLOR = '#e63946';
    var DOWN_COLOR = '#2a9d8f';
    var AXIS_COLOR = '#9aa5b1';
    var GRID_COLOR = '#e3e8ee';
    var TEXT_COLOR = '#4a5568';

    // 画布固定尺寸，靠 viewBox 缩放到气泡宽度
    var CW = 640;
    var CH = 320;

    // ———————————————————— DOM 小工具 ————————————————————

    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) n.className = cls;
        if (text !== undefined && text !== null) n.appendChild(document.createTextNode(String(text)));
        return n;
    }

    function svgEl(tag, attrs) {
        var n = document.createElementNS(SVG_NS, tag);
        if (attrs) {
            for (var k in attrs) {
                if (Object.prototype.hasOwnProperty.call(attrs, k) && attrs[k] !== null && attrs[k] !== undefined) {
                    n.setAttribute(k, String(attrs[k]));
                }
            }
        }
        return n;
    }

    function svgText(x, y, str, attrs) {
        var n = svgEl('text', Object.assign({ x: x, y: y }, attrs || {}));
        n.appendChild(document.createTextNode(String(str)));
        return n;
    }

    /** 数值转字符串，避免 0.30000000000000004 这种 */
    function fmt(v) {
        if (!isFinite(v)) return '';
        if (v !== 0 && (Math.abs(v) >= 1e7 || Math.abs(v) < 1e-4)) return v.toExponential(1);
        var r = Math.round(v * 1000) / 1000;
        return String(r);
    }

    /**
     * 按字符数估算文本宽度。中文字符是 ASCII 的两倍宽。
     * 之所以要估算而不是量：getComputedTextLength / getBBox 在 jsdom 里没实现。
     */
    function textWidth(s, size) {
        var w = 0;
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            w += (c > 0x2e80) ? size : size * 0.58;
        }
        return w;
    }

    function isFiniteNum(v) {
        return typeof v === 'number' && isFinite(v);
    }

    // ———————————————————— 行内 Markdown ————————————————————

    /**
     * 链接只放行 http/https/mailto。
     * javascript: 之类一律不生成 <a>，退化成纯文本 —— 这不是防 XSS（本来也解析不了 HTML），
     * 是防钓鱼：对端发个 [点这里](https://evil) 骗点击。
     */
    function makeLink(label, url) {
        var u = String(url || '').trim();
        if (!/^(https?:\/\/|mailto:)/i.test(u)) return null;
        var a = document.createElement('a');
        a.setAttribute('href', u);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        a.appendChild(document.createTextNode(label));
        return a;
    }

    // 行内标记：`代码` / **粗** / ~~删~~ / *斜* / [文字](链接)
    //
    // 必须每次调用新建一个正则，不能提到外面共用：下面碰到 **粗体** 会递归进来
    // 处理内部，而内层那次 exec 会把同一个正则对象的 lastIndex 冲成 0，
    // 外层再 exec 时就从头又匹配上同一个 **粗体** —— 死循环，直到把内存吃光。
    var INLINE_SRC = '(`([^`\\n]+)`)|(\\*\\*([^*\\n]+)\\*\\*)|(~~([^~\\n]+)~~)|(\\*([^*\\n]+)\\*)|(\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\))';

    function renderInline(parent, src) {
        var s = String(src == null ? '' : src);
        var last = 0, m;
        var re = new RegExp(INLINE_SRC, 'g');
        while ((m = re.exec(s)) !== null) {
            if (m.index > last) parent.appendChild(document.createTextNode(s.slice(last, m.index)));
            if (m[2] !== undefined) {
                parent.appendChild(el('code', 'md-code', m[2]));
            } else if (m[4] !== undefined) {
                // 递归一层，好让 **粗体里有 `代码`** 也能解析。
                // 内层字符串严格更短且去掉了标记，不会无限递归。
                var strong = el('strong');
                renderInline(strong, m[4]);
                parent.appendChild(strong);
            } else if (m[6] !== undefined) {
                var del = el('s');
                renderInline(del, m[6]);
                parent.appendChild(del);
            } else if (m[8] !== undefined) {
                var em = el('em');
                renderInline(em, m[8]);
                parent.appendChild(em);
            } else if (m[10] !== undefined) {
                var a = makeLink(m[10], m[11]);
                parent.appendChild(a || document.createTextNode(m[0]));
            }
            last = re.lastIndex;
        }
        if (last < s.length) parent.appendChild(document.createTextNode(s.slice(last)));
    }

    // ———————————————————— 块级 Markdown ————————————————————

    function isTableSep(line) {
        if (!line || line.indexOf('-') < 0) return false;
        return line.indexOf('|') >= 0 && /^[\s|:-]+$/.test(line);
    }

    function splitRow(line) {
        var t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
        return t.split('|').map(function (c) { return c.trim(); });
    }

    function renderCodeBlock(code, lang) {
        var pre = el('pre', 'md-pre');
        var codeEl = el('code', 'md-codeblock', code);
        if (lang) codeEl.setAttribute('data-lang', lang);
        pre.appendChild(codeEl);
        return pre;
    }

    function renderHeading(level, text) {
        var h = document.createElement('h' + level);
        h.className = 'md-h';
        renderInline(h, text);
        return h;
    }

    function renderParagraph(lines) {
        var p = el('p', 'md-p');
        for (var i = 0; i < lines.length; i++) {
            if (i) p.appendChild(document.createElement('br'));
            renderInline(p, lines[i]);
        }
        return p;
    }

    /**
     * 列表。支持缩进嵌套：缩进更深的那几行挂到上一个 <li> 里。
     * 用递归而不是记栈，逻辑短且天然支持任意层。
     */
    function renderList(items, ordered) {
        var listEl = el(ordered ? 'ol' : 'ul', 'md-list');
        var i = 0;
        while (i < items.length) {
            var cur = items[i];
            // 收集这一条下面所有更深缩进的子项
            var sub = [];
            var j = i + 1;
            while (j < items.length && items[j].indent > cur.indent) {
                sub.push(items[j]);
                j++;
            }
            var li = el('li');
            renderInline(li, cur.text);
            if (sub.length) {
                var base = sub[0].indent;
                li.appendChild(renderList(sub.map(function (it) {
                    return { indent: it.indent - base, text: it.text, ordered: it.ordered };
                }), sub[0].ordered));
            }
            listEl.appendChild(li);
            i = j;
        }
        return listEl;
    }

    function renderTable(header, rows) {
        var wrap = el('div', 'md-table-wrap');
        var t = el('table', 'md-table');
        var thead = el('thead');
        var tr = el('tr');
        header.forEach(function (c) {
            var th = el('th');
            renderInline(th, c);
            tr.appendChild(th);
        });
        thead.appendChild(tr);
        t.appendChild(thead);
        var tbody = el('tbody');
        rows.forEach(function (r) {
            var rtr = el('tr');
            for (var i = 0; i < header.length; i++) {
                var td = el('td');
                renderInline(td, r[i] === undefined ? '' : r[i]);
                rtr.appendChild(td);
            }
            tbody.appendChild(rtr);
        });
        t.appendChild(tbody);
        wrap.appendChild(t);
        return wrap;
    }

    var HEADING_RE = /^(#{1,6})\s+(.+)$/;
    var HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;
    var UL_RE = /^(\s*)[-*+]\s+(.+)$/;
    var OL_RE = /^(\s*)\d+[.)]\s+(.+)$/;
    var QUOTE_RE = /^\s*>\s?(.*)$/;
    var FENCE_RE = /^\s*```\s*([A-Za-z0-9_-]*)\s*$/;

    /** 把纯文本段落（非围栏部分）按块渲染进 parent */
    function renderTextBlocks(parent, lines) {
        var i = 0;
        while (i < lines.length) {
            var line = lines[i];

            if (!line.trim()) { i++; continue; }

            var m;

            if ((m = HEADING_RE.exec(line))) {
                parent.appendChild(renderHeading(m[1].length, m[2]));
                i++;
                continue;
            }

            if (HR_RE.test(line)) {
                parent.appendChild(el('hr', 'md-hr'));
                i++;
                continue;
            }

            // 表格：本行有 |，且下一行是分隔行
            if (line.indexOf('|') >= 0 && i + 1 < lines.length && isTableSep(lines[i + 1])) {
                var header = splitRow(line);
                var rows = [];
                var k = i + 2;
                while (k < lines.length && lines[k].trim() && lines[k].indexOf('|') >= 0) {
                    rows.push(splitRow(lines[k]));
                    k++;
                }
                parent.appendChild(renderTable(header, rows));
                i = k;
                continue;
            }

            if (QUOTE_RE.test(line)) {
                var q = el('blockquote', 'md-quote');
                var qlines = [];
                while (i < lines.length && (m = QUOTE_RE.exec(lines[i]))) {
                    qlines.push(m[1]);
                    i++;
                }
                q.appendChild(renderParagraph(qlines));
                parent.appendChild(q);
                continue;
            }

            if (UL_RE.test(line) || OL_RE.test(line)) {
                var items = [];
                while (i < lines.length) {
                    var mu = UL_RE.exec(lines[i]);
                    var mo = OL_RE.exec(lines[i]);
                    if (mu) items.push({ indent: mu[1].length, text: mu[2], ordered: false });
                    else if (mo) items.push({ indent: mo[1].length, text: mo[2], ordered: true });
                    else break;
                    i++;
                }
                parent.appendChild(renderList(items, items[0].ordered));
                continue;
            }

            // 其余：连续的普通行合成一段
            var para = [];
            while (i < lines.length && lines[i].trim() &&
                   !HEADING_RE.test(lines[i]) && !HR_RE.test(lines[i]) &&
                   !QUOTE_RE.test(lines[i]) && !UL_RE.test(lines[i]) && !OL_RE.test(lines[i]) &&
                   lines[i].indexOf('|') < 0) {
                para.push(lines[i]);
                i++;
            }
            if (para.length) parent.appendChild(renderParagraph(para));
            else i++;   // 保险：上面某个分支没吃掉，别死循环
        }
    }

    // ———————————————————— 图表：解析 ————————————————————

    /**
     * 校验并归一化一个图表 spec。
     * 返回 {ok:true, spec} 或 {ok:false, error} —— 失败时调用方退回显示原始代码块。
     */
    function parseChart(src) {
        var raw = String(src == null ? '' : src);
        if (raw.length > MAX_BLOCK_BYTES) return { ok: false, error: '图表块过大（' + raw.length + ' 字节）' };

        var s;
        try {
            s = JSON.parse(raw);
        } catch (e) {
            return { ok: false, error: 'JSON 解析失败' };
        }
        if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, error: '顶层必须是对象' };

        var type = s.type;
        if (type !== 'line' && type !== 'bar' && type !== 'pie' && type !== 'candlestick') {
            return { ok: false, error: '不支持的 type: ' + String(type) };
        }

        var title = (typeof s.title === 'string') ? s.title : '';

        // —— 饼图：允许 {data:[{name,value}]} 简写，也允许走 series[0].data ——
        if (type === 'pie') {
            var items = Array.isArray(s.data) ? s.data : null;
            if (!items && Array.isArray(s.series) && s.series[0] && Array.isArray(s.series[0].data)) {
                items = s.series[0].data;
            }
            if (!items || !items.length) return { ok: false, error: '饼图需要 data 数组' };
            if (items.length > MAX_POINTS) return { ok: false, error: '数据点过多（' + items.length + '）' };
            var norm = [];
            for (var i = 0; i < items.length; i++) {
                var it = items[i];
                if (!it || typeof it !== 'object') return { ok: false, error: 'data[' + i + '] 必须是对象' };
                var v = it.value;
                if (!isFiniteNum(v) || v < 0) return { ok: false, error: 'data[' + i + '].value 必须是非负数字' };
                norm.push({ name: String(it.name === undefined ? ('项' + (i + 1)) : it.name), value: v });
            }
            return { ok: true, spec: { type: 'pie', title: title, items: norm } };
        }

        // —— 其余三种：x 标签 + series ——
        var series = s.series;
        if (!Array.isArray(series) || !series.length) return { ok: false, error: '缺少 series 数组' };

        var x = [];
        if (Array.isArray(s.x)) x = s.x.map(function (v) { return String(v); });
        else if (s.x !== undefined) return { ok: false, error: 'x 必须是数组' };

        var total = 0;
        var outSeries = [];
        for (var si = 0; si < series.length; si++) {
            var ser = series[si];
            if (!ser || typeof ser !== 'object' || !Array.isArray(ser.data)) {
                return { ok: false, error: 'series[' + si + '].data 必须是数组' };
            }
            total += ser.data.length;
            if (total > MAX_POINTS) return { ok: false, error: '数据点过多（>' + MAX_POINTS + '）' };

            if (type === 'candlestick') {
                var cd = [];
                for (var ci = 0; ci < ser.data.length; ci++) {
                    var d = ser.data[ci];
                    if (!Array.isArray(d) || d.length < 4) {
                        return { ok: false, error: 'K 线每个点必须是 [open, close, low, high]' };
                    }
                    var quad = [d[0], d[1], d[2], d[3]];
                    for (var qi = 0; qi < 4; qi++) {
                        if (!isFiniteNum(quad[qi])) return { ok: false, error: 'K 线数据里有非数字' };
                    }
                    cd.push(quad);
                }
                outSeries.push({ name: String(ser.name || 'K'), data: cd });
            } else {
                var nd = [];
                for (var di = 0; di < ser.data.length; di++) {
                    var val = ser.data[di];
                    if (!isFiniteNum(val)) return { ok: false, error: 'series[' + si + '].data 里有非数字' };
                    nd.push(val);
                }
                outSeries.push({ name: String(ser.name || ('系列' + (si + 1))), data: nd });
            }
        }

        return { ok: true, spec: { type: type, title: title, x: x, series: outSeries } };
    }

    // ———————————————————— 图表：渲染 ————————————————————

    /** 取一个「好看」的纵轴刻度范围 */
    function niceScale(min, max, ticks) {
        if (!isFinite(min) || !isFinite(max)) { min = 0; max = 1; }
        if (min === max) {
            var d = Math.abs(min) || 1;
            min -= d * 0.5;
            max += d * 0.5;
        }
        var span = max - min;
        var step = Math.pow(10, Math.floor(Math.log(span / ticks) / Math.LN10));
        var err = (span / ticks) / step;
        if (err >= 7.5) step *= 10;
        else if (err >= 3.5) step *= 5;
        else if (err >= 1.5) step *= 2;
        return { min: Math.floor(min / step) * step, max: Math.ceil(max / step) * step, step: step };
    }

    /** 画坐标系，返回绘图区几何信息 */
    function drawAxes(root, scale, plot, xLabels) {
        var y0 = plot.top, y1 = plot.top + plot.height;

        // 横向网格线 + 纵轴刻度
        for (var v = scale.min; v <= scale.max + scale.step / 2; v += scale.step) {
            var y = y1 - (v - scale.min) / (scale.max - scale.min) * plot.height;
            root.appendChild(svgEl('line', {
                x1: plot.left, y1: y, x2: plot.left + plot.width, y2: y,
                stroke: GRID_COLOR, 'stroke-width': 1,
            }));
            root.appendChild(svgText(plot.left - 6, y + 4, fmt(v), {
                'text-anchor': 'end', 'font-size': 11, fill: TEXT_COLOR,
            }));
        }

        // 轴
        root.appendChild(svgEl('line', {
            x1: plot.left, y1: y0, x2: plot.left, y2: y1, stroke: AXIS_COLOR, 'stroke-width': 1,
        }));
        root.appendChild(svgEl('line', {
            x1: plot.left, y1: y1, x2: plot.left + plot.width, y2: y1, stroke: AXIS_COLOR, 'stroke-width': 1,
        }));

        // 横轴标签：最多显示 8 个，不然挤成一团
        var n = xLabels.length;
        if (n) {
            var everyX = Math.max(1, Math.ceil(n / 8));
            for (var i = 0; i < n; i += everyX) {
                var cx = n === 1 ? plot.left + plot.width / 2
                                 : plot.left + (i / (n - 1)) * plot.width;
                var label = xLabels[i];
                if (label.length > 7) label = label.slice(0, 6) + '…';
                root.appendChild(svgText(cx, y1 + 16, label, {
                    'text-anchor': 'middle', 'font-size': 11, fill: TEXT_COLOR,
                }));
            }
        }
        return { y0: y0, y1: y1 };
    }

    /** 图例：标题行下方一排色块 + 名字 */
    function drawLegend(root, entries) {
        var x = 16, y = 14;
        entries.forEach(function (e) {
            var w = textWidth(e.name, 12) + 26;
            if (x + w > CW - 16) return;
            root.appendChild(svgEl('rect', {
                x: x, y: y - 8, width: 9, height: 9, rx: 2, fill: e.color,
            }));
            root.appendChild(svgText(x + 14, y, e.name, { 'font-size': 12, fill: TEXT_COLOR }));
            x += w;
        });
    }

    function renderLineChart(root, spec, plot) {
        var colors = [];
        var all = [];
        spec.series.forEach(function (s, i) {
            colors.push(PALETTE[i % PALETTE.length]);
            s.data.forEach(function (v) { all.push(v); });
        });
        var scale = niceScale(Math.min.apply(null, all), Math.max.apply(null, all), 5);
        var n = Math.max.apply(null, spec.series.map(function (s) { return s.data.length; }));
        var xLabels = spec.x.length ? spec.x : spec.series[0].data.map(function (_, i) { return String(i + 1); });

        drawAxes(root, scale, plot, xLabels);
        if (spec.series.length > 1) {
            drawLegend(root, spec.series.map(function (s, i) { return { name: s.name, color: colors[i] }; }));
        }

        var span = scale.max - scale.min || 1;
        function px(i, len) { return len === 1 ? plot.left + plot.width / 2 : plot.left + (i / (len - 1)) * plot.width; }
        function py(v) { return plot.top + plot.height - (v - scale.min) / span * plot.height; }

        spec.series.forEach(function (s, si) {
            var pts = s.data.map(function (v, i) {
                return px(i, n) + ',' + py(v);
            }).join(' ');
            root.appendChild(svgEl('polyline', {
                points: pts, fill: 'none', stroke: colors[si], 'stroke-width': 2,
                'stroke-linejoin': 'round', 'stroke-linecap': 'round',
            }));
            // 点少的时候把数据点画出来，多了就成了一坨
            if (s.data.length <= 40) {
                s.data.forEach(function (v, i) {
                    root.appendChild(svgEl('circle', {
                        cx: px(i, n), cy: py(v), r: 2.5, fill: colors[si],
                    }));
                });
            }
            // 悬停提示：每个点挂一个原生 <title>，零 JS
            if (s.data.length <= 60) {
                s.data.forEach(function (v, i) {
                    var t = svgEl('circle', { cx: px(i, n), cy: py(v), r: 8, fill: 'transparent' });
                    t.appendChild(svgEl('title', {}));
                    t.firstChild.appendChild(document.createTextNode(
                        (xLabels[i] !== undefined ? xLabels[i] + '  ' : '') + s.name + ': ' + fmt(v)));
                    root.appendChild(t);
                });
            }
        });
        return root;
    }

    function renderBarChart(root, spec, plot) {
        var colors = [];
        var all = [0];
        spec.series.forEach(function (s, i) {
            colors.push(PALETTE[i % PALETTE.length]);
            s.data.forEach(function (v) { all.push(v); });
        });
        var scale = niceScale(Math.min(0, Math.min.apply(null, all)), Math.max.apply(null, all), 5);
        var n = Math.max.apply(null, spec.series.map(function (s) { return s.data.length; }));
        var xLabels = spec.x.length ? spec.x : spec.series[0].data.map(function (_, i) { return String(i + 1); });

        drawAxes(root, scale, plot, xLabels);
        if (spec.series.length > 1) {
            drawLegend(root, spec.series.map(function (s, i) { return { name: s.name, color: colors[i] }; }));
        }

        var span = scale.max - scale.min || 1;
        // 每组柱子的总宽，留 30% 间隙
        var groupW = plot.width / Math.max(1, n);
        var barW = Math.max(1, (groupW * 0.7) / spec.series.length);
        var zeroY = plot.top + plot.height - (0 - scale.min) / span * plot.height;

        spec.series.forEach(function (s, si) {
            s.data.forEach(function (v, i) {
                var gx = plot.left + i * groupW + (groupW - barW * spec.series.length) / 2 + si * barW;
                var vy = plot.top + plot.height - (v - scale.min) / span * plot.height;
                var top = Math.min(vy, zeroY);
                var h = Math.max(1, Math.abs(zeroY - vy));
                var r = svgEl('rect', { x: gx, y: top, width: barW, height: h, fill: colors[si] });
                r.appendChild(svgEl('title', {}));
                r.firstChild.appendChild(document.createTextNode(
                    (xLabels[i] !== undefined ? xLabels[i] + '  ' : '') + s.name + ': ' + fmt(v)));
                root.appendChild(r);
            });
        });
        return root;
    }

    function renderCandleChart(root, spec, plot) {
        var data = spec.series[0].data;
        var all = [];
        data.forEach(function (q) { all.push(q[2], q[3]); });   // low, high
        var scale = niceScale(Math.min.apply(null, all), Math.max.apply(null, all), 5);
        var xLabels = spec.x.length ? spec.x : data.map(function (_, i) { return String(i + 1); });

        drawAxes(root, scale, plot, xLabels);

        var span = scale.max - scale.min || 1;
        function py(v) { return plot.top + plot.height - (v - scale.min) / span * plot.height; }

        var slot = plot.width / Math.max(1, data.length);
        var bodyW = Math.max(1, Math.min(slot * 0.6, 18));

        data.forEach(function (q, i) {
            var open = q[0], close = q[1], low = q[2], high = q[3];
            var cx = plot.left + slot * (i + 0.5);
            var up = close >= open;
            var color = up ? UP_COLOR : DOWN_COLOR;
            var label = (xLabels[i] !== undefined ? xLabels[i] + '  ' : '') +
                '开 ' + fmt(open) + '  收 ' + fmt(close) + '  低 ' + fmt(low) + '  高 ' + fmt(high);

            // 影线
            var wick = svgEl('line', {
                x1: cx, y1: py(high), x2: cx, y2: py(low), stroke: color, 'stroke-width': 1,
            });
            wick.appendChild(svgEl('title', {}));
            wick.firstChild.appendChild(document.createTextNode(label));
            root.appendChild(wick);

            // 实体。开=收时退化成一条横线（十字星）
            var yTop = py(Math.max(open, close));
            var yBot = py(Math.min(open, close));
            if (Math.abs(yBot - yTop) < 1) {
                root.appendChild(svgEl('line', {
                    x1: cx - bodyW / 2, y1: yTop, x2: cx + bodyW / 2, y2: yTop,
                    stroke: color, 'stroke-width': 2,
                }));
            } else {
                var r = svgEl('rect', {
                    x: cx - bodyW / 2, y: yTop, width: bodyW, height: yBot - yTop,
                    fill: up ? '#fff' : color, stroke: color, 'stroke-width': 1.5,
                });
                r.appendChild(svgEl('title', {}));
                r.firstChild.appendChild(document.createTextNode(label));
                root.appendChild(r);
            }
        });
        return root;
    }

    function renderPieChart(root, spec) {
        var items = spec.items;
        var total = items.reduce(function (a, b) { return a + b.value; }, 0);
        if (!(total > 0)) return null;

        var cx = CW * 0.34, cy = CH / 2 + 6;
        var r = Math.min(CH / 2 - 40, CW * 0.28);

        var angle = -Math.PI / 2;   // 从 12 点方向开始
        items.forEach(function (it, i) {
            var frac = it.value / total;
            var a0 = angle;
            var a1 = angle + frac * Math.PI * 2;
            angle = a1;
            var color = PALETTE[i % PALETTE.length];
            var pct = (frac * 100).toFixed(1) + '%';

            var shape;
            if (items.length === 1) {
                // 整圆用 arc 画不出来（起终点重合），单独处理
                shape = svgEl('circle', { cx: cx, cy: cy, r: r, fill: color });
            } else {
                var x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
                var x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
                var large = (a1 - a0) > Math.PI ? 1 : 0;
                shape = svgEl('path', {
                    d: 'M ' + cx + ' ' + cy + ' L ' + x0 + ' ' + y0 +
                       ' A ' + r + ' ' + r + ' 0 ' + large + ' 1 ' + x1 + ' ' + y1 + ' Z',
                    fill: color, stroke: '#fff', 'stroke-width': 1.5,
                });
            }
            shape.appendChild(svgEl('title', {}));
            shape.firstChild.appendChild(document.createTextNode(it.name + ': ' + fmt(it.value) + '（' + pct + '）'));
            root.appendChild(shape);

            // 扇形外面的百分比标签
            var mid = (a0 + a1) / 2;
            if (frac >= 0.05) {
                root.appendChild(svgText(
                    cx + r * 0.68 * Math.cos(mid), cy + r * 0.68 * Math.sin(mid) + 4, pct,
                    { 'text-anchor': 'middle', 'font-size': 11, fill: '#fff', 'font-weight': 'bold' }
                ));
            }
        });

        // 图例
        var lx = cx + r + 32, ly = cy - (items.length * 20) / 2 + 10;
        items.forEach(function (it, i) {
            var y = ly + i * 20;
            root.appendChild(svgEl('rect', { x: lx, y: y - 9, width: 10, height: 10, rx: 2, fill: PALETTE[i % PALETTE.length] }));
            var name = it.name.length > 10 ? it.name.slice(0, 9) + '…' : it.name;
            root.appendChild(svgText(lx + 16, y, name + '  ' + fmt(it.value), { 'font-size': 12, fill: TEXT_COLOR }));
        });
        return root;
    }

    /** 把 spec 画成 SVG。解析失败返回 null，调用方退回代码块。 */
    function renderChart(spec) {
        if (!spec || !spec.type) return null;

        var root = svgEl('svg', {
            viewBox: '0 0 ' + CW + ' ' + CH,
            width: '100%',
            role: 'img',
            class: 'p2p-chart-svg',
            preserveAspectRatio: 'xMidYMid meet',
        });

        var plot = { left: 52, top: spec.title ? 40 : 24, width: CW - 52 - 20, height: CH - (spec.title ? 40 : 24) - 36 };

        if (spec.title) {
            root.appendChild(svgText(16, 20, spec.title, {
                'font-size': 14, 'font-weight': 'bold', fill: '#1f1f1f',
            }));
        }

        var body = null;
        try {
            if (spec.type === 'line') body = renderLineChart(root, spec, plot);
            else if (spec.type === 'bar') body = renderBarChart(root, spec, plot);
            else if (spec.type === 'candlestick') body = renderCandleChart(root, spec, plot);
            else if (spec.type === 'pie') body = renderPieChart(root, spec);
        } catch (e) {
            return null;
        }
        return body ? root : null;
    }

    // ———————————————————— 流程图（mermaid 子集） ————————————————————

    var NODE_ID = '[A-Za-z0-9_\\u4e00-\\u9fa5]+';
    var ARROW_RE = /(-\.->|---|-->)/;

    /** 解析 `A[文本]` / `B{判断}` / `C(圆)`，也接受裸 id */
    function parseNodeRef(str) {
        var s = String(str || '').trim();
        var label = null;
        var lm = /^\|([^|]*)\|\s*/.exec(s);
        if (lm) {
            label = lm[1];
            s = s.slice(lm[0].length).trim();
        }
        var re = new RegExp('^(' + NODE_ID + ')\\s*(?:\\[([^\\]]*)\\]|\\(([^)]*)\\)|\\{([^}]*)\\})?$');
        var m = re.exec(s);
        if (!m) return null;
        var shape = 'rect';
        var text = m[1];
        if (m[2] !== undefined) { shape = 'rect'; text = m[2]; }
        else if (m[3] !== undefined) { shape = 'round'; text = m[3]; }
        else if (m[4] !== undefined) { shape = 'diamond'; text = m[4]; }
        return { id: m[1], label: text, shape: shape, edgeLabel: label };
    }

    /** 把一行拆成 节点-箭头-节点 的链 */
    function splitEdges(line) {
        // 先把 `A -- 文字 --> B` 归一成 `A -->|文字| B`
        var ln = line.replace(/--\s*([^-|>][^>]*?)\s*-->/g, '-->|$1|');
        var out = [];
        var rest = ln;
        var m;
        while ((m = ARROW_RE.exec(rest)) !== null) {
            out.push({ text: rest.slice(0, m.index), arrow: m[1] });
            rest = rest.slice(m.index + m[1].length);
        }
        out.push({ text: rest, arrow: null });
        return out;
    }

    function parseMermaid(src) {
        var raw = String(src == null ? '' : src);
        if (raw.length > MAX_BLOCK_BYTES) return { ok: false, error: '流程图块过大' };

        var lines = raw.split('\n');
        var head = null, headIdx = -1;
        for (var i = 0; i < lines.length; i++) {
            if (lines[i].trim()) { head = lines[i]; headIdx = i; break; }
        }
        if (head === null) return { ok: false, error: '空内容' };

        var hm = /^\s*(flowchart|graph)\s+(TD|TB|BT|LR|RL)?\s*$/.exec(head);
        if (!hm) {
            return { ok: false, error: '只支持 flowchart/graph（不支持序列图、甘特图等）' };
        }
        var dir = hm[2] || 'TD';

        var nodes = {};
        var order = [];
        var edges = [];

        function touch(ref) {
            if (!nodes[ref.id]) {
                nodes[ref.id] = { id: ref.id, label: ref.label, shape: ref.shape };
                order.push(ref.id);
            }
            return nodes[ref.id];
        }

        for (var li = headIdx + 1; li < lines.length; li++) {
            var ln = lines[li].trim();
            if (!ln || ln.charAt(0) === '%') continue;

            // 这些语法这个子集实现不了，明确报错让调用方退回代码块，
            // 而不是画一张错的图出来骗人
            if (/^(subgraph|end|style|classDef|class|click|linkStyle|sequenceDiagram|gantt|pie|stateDiagram|erDiagram|journey)\b/.test(ln)) {
                return { ok: false, error: '不支持的语法: ' + ln.split(/\s/)[0] };
            }

            var segs = splitEdges(ln);
            var prev = null;
            var bad = false;
            for (var si = 0; si < segs.length; si++) {
                var ref = parseNodeRef(segs[si].text);
                if (!ref) { bad = true; break; }
                var node = touch(ref);
                if (prev) {
                    edges.push({ from: prev.id, to: node.id, label: ref.edgeLabel || '', arrow: segs[si - 1].arrow });
                }
                prev = node;
            }
            if (bad || !prev) return { ok: false, error: '看不懂这一行: ' + ln };
        }

        if (!order.length) return { ok: false, error: '没有节点' };
        // 只声明了节点、没有连线时也画得出来，但只有当它是合法节点声明时才算
        return { ok: true, spec: { dir: dir, nodes: nodes, order: order, edges: edges } };
    }

    /** 节点盒子尺寸。估算而不是量，见文件头第 3 条。 */
    function nodeSize(node) {
        var w = Math.max(46, textWidth(node.label, 13) + 26);
        var h = 34;
        if (node.shape === 'diamond') {
            w += 26;
            h = 44;
        }
        return { w: w, h: h };
    }

    function renderMermaid(spec) {
        var H_GAP = 30, V_GAP = 52;
        var horizontal = (spec.dir === 'LR' || spec.dir === 'RL');
        var reverse = (spec.dir === 'BT' || spec.dir === 'RL');

        // —— 分层：松弛迭代算最长路径，有环也会在有限步内停下 ——
        var rank = {};
        spec.order.forEach(function (id) { rank[id] = 0; });
        for (var it = 0; it < spec.order.length + 2; it++) {
            var changed = false;
            spec.edges.forEach(function (e) {
                if (rank[e.to] < rank[e.from] + 1) { rank[e.to] = rank[e.from] + 1; changed = true; }
            });
            if (!changed) break;
        }

        var byRank = {};
        spec.order.forEach(function (id) {
            (byRank[rank[id]] = byRank[rank[id]] || []).push(id);
        });
        var rankKeys = Object.keys(byRank).map(Number).sort(function (a, b) { return a - b; });
        if (reverse) rankKeys.reverse();

        var sizes = {};
        spec.order.forEach(function (id) { sizes[id] = nodeSize(spec.nodes[id]); });

        // 每个 rank 在主/交叉轴上的尺寸
        var mainSize = {}, crossTotal = {}, maxCross = 0;
        rankKeys.forEach(function (k) {
            var row = byRank[k];
            var m = 0, c = 0;
            row.forEach(function (id) {
                var s = sizes[id];
                if (horizontal) {
                    m = Math.max(m, s.w);
                    c += s.h;
                } else {
                    m = Math.max(m, s.h);
                    c += s.w;
                }
            });
            c += (row.length - 1) * H_GAP;
            mainSize[k] = m;
            crossTotal[k] = c;
            maxCross = Math.max(maxCross, c);
        });

        // —— 定位 ——
        var pos = {};
        var mainPos = 24;
        rankKeys.forEach(function (k) {
            var row = byRank[k];
            var cross = 24 + (maxCross - crossTotal[k]) / 2;
            row.forEach(function (id) {
                var s = sizes[id];
                if (horizontal) {
                    pos[id] = { x: mainPos + s.w / 2, y: cross + s.h / 2 };
                    cross += s.h + H_GAP;
                } else {
                    pos[id] = { x: cross + s.w / 2, y: mainPos + s.h / 2 };
                    cross += s.w + H_GAP;
                }
            });
            mainPos += mainSize[k] + V_GAP;
        });

        var totalMain = mainPos - V_GAP + 24;
        var totalCross = maxCross + 48;
        var vw = horizontal ? totalMain : totalCross;
        var vh = horizontal ? totalCross : totalMain;

        // 方向对了之后把整体挪回画面内
        spec.order.forEach(function (id) {
            var s = sizes[id];
            if (reverse) {
                if (horizontal) pos[id].x = vw - pos[id].x;
                else pos[id].y = vh - pos[id].y;
            }
        });

        var root = svgEl('svg', {
            viewBox: '0 0 ' + Math.round(vw) + ' ' + Math.round(vh),
            width: '100%',
            role: 'img',
            class: 'p2p-mermaid-svg',
            preserveAspectRatio: 'xMidYMid meet',
        });

        // —— 连线画在节点下面 ——
        spec.edges.forEach(function (e) {
            var a = pos[e.from], b = pos[e.to];
            if (!a || !b) return;
            var sa = sizes[e.from], sb = sizes[e.to];

            var dx = b.x - a.x, dy = b.y - a.y;
            var len = Math.sqrt(dx * dx + dy * dy);
            if (len < 1) return;
            var ux = dx / len, uy = dy / len;

            // 从中心走到各自盒子边界，别让线插进节点里
            function clip(c, s) {
                var tx = ux === 0 ? Infinity : (s.w / 2) / Math.abs(ux);
                var ty = uy === 0 ? Infinity : (s.h / 2) / Math.abs(uy);
                var t = Math.min(tx, ty);
                return { x: c.x + ux * t, y: c.y + uy * t };
            }
            var p0 = clip(a, sa);
            var p1 = clip(b, sb);

            var attrs = {
                x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y,
                stroke: '#8a94a6', 'stroke-width': 1.5, fill: 'none',
            };
            if (e.arrow === '-.->') attrs['stroke-dasharray'] = '5 4';
            if (e.arrow === '---') attrs['stroke-width'] = 2;
            root.appendChild(svgEl('line', attrs));

            // 箭头。手画多边形而不是 <marker>：marker 要靠 id 引用，
            // 一页里多个图会撞 id
            if (e.arrow === '-->' || e.arrow === '-.->') {
                var head = 8, wing = 4;
                var bx = p1.x - ux * head, by = p1.y - uy * head;
                root.appendChild(svgEl('polygon', {
                    points: p1.x + ',' + p1.y + ' ' +
                            (bx - uy * wing) + ',' + (by + ux * wing) + ' ' +
                            (bx + uy * wing) + ',' + (by - ux * wing),
                    fill: '#8a94a6',
                }));
            }

            if (e.label) {
                var mx = (p0.x + p1.x) / 2, my = (p0.y + p1.y) / 2;
                var tw = textWidth(e.label, 11) + 10;
                root.appendChild(svgEl('rect', {
                    x: mx - tw / 2, y: my - 9, width: tw, height: 17, rx: 4,
                    fill: '#f0f4f9', stroke: '#dfe5ec',
                }));
                root.appendChild(svgText(mx, my + 3, e.label, {
                    'text-anchor': 'middle', 'font-size': 11, fill: TEXT_COLOR,
                }));
            }
        });

        // —— 节点 ——
        spec.order.forEach(function (id) {
            var node = spec.nodes[id];
            var s = sizes[id];
            var p = pos[id];
            var x = p.x - s.w / 2, y = p.y - s.h / 2;

            var g = svgEl('g', { class: 'p2p-mermaid-node' });
            if (node.shape === 'diamond') {
                g.appendChild(svgEl('polygon', {
                    points: p.x + ',' + (p.y - s.h / 2) + ' ' +
                            (p.x + s.w / 2) + ',' + p.y + ' ' +
                            p.x + ',' + (p.y + s.h / 2) + ' ' +
                            (p.x - s.w / 2) + ',' + p.y,
                    fill: '#fff', stroke: PALETTE[0], 'stroke-width': 1.5,
                }));
            } else {
                g.appendChild(svgEl('rect', {
                    x: x, y: y, width: s.w, height: s.h,
                    rx: node.shape === 'round' ? s.h / 2 : 6,
                    fill: '#fff', stroke: PALETTE[0], 'stroke-width': 1.5,
                }));
            }
            g.appendChild(svgText(p.x, p.y + 4, node.label, {
                'text-anchor': 'middle', 'font-size': 13, fill: '#1f1f1f',
            }));
            var gTitle = svgEl('title', {});
            gTitle.appendChild(document.createTextNode(node.label));
            g.appendChild(gTitle);
            root.appendChild(g);
        });

        return root;
    }

    // ———————————————————— 主入口 ————————————————————

    /** 把源码切成 [{kind:'fence',lang,code}, {kind:'text',lines}] */
    function splitBlocks(src) {
        var lines = src.split('\n');
        var blocks = [];
        var buf = [];
        var i = 0;

        function flush() {
            if (buf.length) {
                blocks.push({ kind: 'text', lines: buf });
                buf = [];
            }
        }

        while (i < lines.length) {
            var m = FENCE_RE.exec(lines[i]);
            if (!m) {
                buf.push(lines[i]);
                i++;
                continue;
            }

            // 先探一探闭没闭合，再决定它是不是代码块。
            // 没闭合（对面发到一半断了、或者就是随手打了三个反引号）就整段当普通文本，
            // 否则后面的话会被一股脑吞进代码块里，用户什么都看不见。
            var j = i + 1;
            var code = [];
            var closed = false;
            while (j < lines.length) {
                if (/^\s*```\s*$/.test(lines[j])) { closed = true; break; }
                code.push(lines[j]);
                j++;
            }
            if (!closed) {
                buf.push(lines[i]);
                i++;
                continue;
            }

            flush();
            blocks.push({ kind: 'fence', lang: m[1].toLowerCase(), code: code.join('\n') });
            i = j + 1;
        }
        flush();
        return blocks;
    }

    function renderFence(container, block) {
        var lang = block.lang;
        var code = block.code;

        if (lang === 'chart') {
            var parsed = parseChart(code);
            if (parsed.ok) {
                var svg = renderChart(parsed.spec);
                if (svg) {
                    var wrap = el('div', 'p2p-chart');
                    wrap.appendChild(svg);
                    container.appendChild(wrap);
                    return true;
                }
            }
            container.appendChild(renderCodeBlock(code, 'chart'));
            return false;
        }

        if (lang === 'mermaid') {
            var pm = parseMermaid(code);
            if (pm.ok) {
                var msvg = renderMermaid(pm.spec);
                if (msvg) {
                    var mwrap = el('div', 'p2p-mermaid');
                    mwrap.appendChild(msvg);
                    container.appendChild(mwrap);
                    return true;
                }
            }
            container.appendChild(renderCodeBlock(code, 'mermaid'));
            return false;
        }

        container.appendChild(renderCodeBlock(code, lang));
        return false;
    }

    /**
     * 主入口：把 container 的内容换成渲染结果。
     * 返回 true 表示放了图（调用方据此放宽气泡宽度）。
     */
    function renderInto(container, text) {
        if (!container) return false;
        var s = String(text == null ? '' : text);
        container.textContent = '';
        if (!s) return false;

        var hasChart = false;
        try {
            var blocks = splitBlocks(s);
            for (var i = 0; i < blocks.length; i++) {
                if (blocks[i].kind === 'fence') {
                    if (renderFence(container, blocks[i])) hasChart = true;
                } else {
                    renderTextBlocks(container, blocks[i].lines);
                }
            }
        } catch (e) {
            // 渲染出任何意外都不能把消息弄丢 —— 退回纯文本，聊天继续
            container.textContent = s;
            return false;
        }

        if (hasChart) container.classList.add('has-rich');
        return hasChart;
    }

    window.P2PRender = {
        renderInto: renderInto,
        parseChart: parseChart,
        parseMermaid: parseMermaid,
        renderChart: renderChart,
        renderMermaid: renderMermaid,
        MAX_POINTS: MAX_POINTS,
        MAX_BLOCK_BYTES: MAX_BLOCK_BYTES,
    };
})();
