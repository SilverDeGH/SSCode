package dev.sscode.app.terminal

/**
 * 简化 VT 终端模型：固定 cols×rows 字符网格（每格一个字符 + 前景色索引）+ 滚动回退缓冲。
 *
 * 支持的转义子集：
 * - 控制字符：\n \r \b \t（BEL/NUL 忽略）
 * - CSI：SGR(m，0/1/22/30-37/39/90-97)、CUP(H/f)、CUU/CUD/CUF/CUB(A/B/C/D)、
 *   CNL/CPL(E/F)、CHA(G/`)、VPA(d)、ED(J 0/1/2)、EL(K 0/1/2)、ECH(X)、
 *   SU(S)/SD(T)、DECSC/DECRC(s/u)
 * - ESC：7/8 保存恢复光标、D(IND)、E(NEL)、M(RI)、c(RIS)、字符集选择序列 (( ) # % 跳过一字节)
 * - OSC（]…BEL 或 ]…ESC\）：整体跳过
 * - 宽字符（CJK 等）占 2 列，第二列存 '\u0000' 占位；emoji 代理对占 2 列各存半个代理
 * - 自动换行（延迟换行 pending-wrap 语义）、光标越底行上滚并进入回退缓冲
 *
 * 其他未知序列直接跳过（vim/htop 等全屏程序尽力而为）。
 * 线程安全：feed/snapshot/resize 均 synchronized。
 */
class TerminalModel(cols: Int = 80, rows: Int = 24) {

    /** 一行快照：chars/fg 长度均为 cols，length 为去除行尾空格后的有效长度。fg -1 = 默认色，0-15 = ANSI 调色板索引。 */
    class TerminalLine(val chars: CharArray, val fg: IntArray, val length: Int)

    var cols: Int = cols.coerceAtLeast(2)
        private set
    var rows: Int = rows.coerceAtLeast(2)
        private set

    /** 内容版本号，任何变化后自增，供 UI 触发重组。 */
    var version: Int = 0
        private set

    var cursorRow: Int = 0
        private set
    var cursorCol: Int = 0
        private set

    val scrollbackSize: Int get() = scrollback.size

    private var grid = Array(this.rows) { CharArray(this.cols) { ' ' } }
    private var gridFg = Array(this.rows) { IntArray(this.cols) { -1 } }
    private val scrollback = ArrayDeque<TerminalLine>()

    private var currentFg = -1
    private var bold = false
    private var wrapPending = false
    private var savedRow = 0
    private var savedCol = 0

    private enum class Mode { GROUND, ESC, CSI, OSC, OSC_ESC, SKIP1 }

    private var mode = Mode.GROUND
    private val csiBuf = StringBuilder()
    private var pendingHigh = -1

    // ---------------------------------------------------------------- 输入解析

    @Synchronized
    fun feed(text: String) {
        if (text.isEmpty()) return
        var s = text
        if (pendingHigh >= 0) {
            s = pendingHigh.toChar() + s
            pendingHigh = -1
        }
        var i = 0
        while (i < s.length) {
            val c = s[i]
            val cp: Int
            if (c.isHighSurrogate()) {
                if (i + 1 < s.length && s[i + 1].isLowSurrogate()) {
                    cp = Character.toCodePoint(c, s[i + 1])
                    i += 2
                } else {
                    // 半包：保留高位代理等下一次 feed
                    pendingHigh = c.code
                    break
                }
            } else {
                cp = c.code
                i++
            }
            process(cp)
        }
        version++
    }

    private fun process(cp: Int) {
        when (mode) {
            Mode.GROUND -> ground(cp)
            Mode.ESC -> esc(cp)
            Mode.CSI -> csi(cp)
            Mode.OSC -> when (cp) {
                0x07 -> mode = Mode.GROUND
                0x1B -> mode = Mode.OSC_ESC
                else -> {}
            }

            Mode.OSC_ESC -> mode = if (cp == '\\'.code) Mode.GROUND else Mode.OSC
            Mode.SKIP1 -> mode = Mode.GROUND
        }
    }

    private fun ground(cp: Int) {
        when (cp) {
            0x1B -> mode = Mode.ESC
            0x07, 0x00 -> {}
            0x0A, 0x0B, 0x0C -> {
                wrapPending = false
                // 服务端初始画面是 capture-pane 的纯 \n 拼接：LF 需隐含回车，
                // 否则各行从上一行末列续写，呈阶梯状错位。
                cursorCol = 0
                lineFeed()
            }

            0x0D -> {
                wrapPending = false
                cursorCol = 0
            }

            0x08 -> {
                wrapPending = false
                if (cursorCol > 0) cursorCol--
            }

            0x09 -> {
                wrapPending = false
                cursorCol = ((cursorCol / 8) + 1) * 8
                if (cursorCol >= cols) cursorCol = cols - 1
            }

            in 0x20..0x7E -> putChar(cp)
            0x7F -> {}
            else -> if (cp > 0x9F) putChar(cp) // 跳过 C1 控制区 (0x80-0x9F)
        }
    }

    private fun esc(cp: Int) {
        when (cp.toChar()) {
            '[' -> {
                mode = Mode.CSI
                csiBuf.setLength(0)
            }

            ']' -> mode = Mode.OSC
            '(', ')', '*', '+', '#', '%' -> mode = Mode.SKIP1
            '7' -> {
                savedRow = cursorRow
                savedCol = cursorCol
                mode = Mode.GROUND
            }

            '8' -> {
                cursorRow = savedRow.coerceIn(0, rows - 1)
                cursorCol = savedCol.coerceIn(0, cols - 1)
                wrapPending = false
                mode = Mode.GROUND
            }

            'c' -> {
                reset()
                mode = Mode.GROUND
            }

            'D' -> {
                wrapPending = false
                lineFeed()
                mode = Mode.GROUND
            }

            'E' -> {
                wrapPending = false
                cursorCol = 0
                lineFeed()
                mode = Mode.GROUND
            }

            'M' -> {
                wrapPending = false
                if (cursorRow == 0) scrollDownInPlace(1) else cursorRow--
                mode = Mode.GROUND
            }

            else -> mode = Mode.GROUND
        }
    }

    private fun csi(cp: Int) {
        if (cp in 0x40..0x7E) {
            dispatchCsi(cp.toChar())
            mode = Mode.GROUND
        } else {
            csiBuf.append(cp.toChar())
        }
    }

    private fun dispatchCsi(f: Char) {
        val raw = csiBuf.toString()
        val isPrivate = raw.startsWith("?") || raw.startsWith(">") || raw.startsWith("!")
        val cleaned = raw.trimStart('?', '>', '!', ' ')
        val parts = cleaned.split(';')

        fun p(i: Int, def: Int): Int {
            val s = parts.getOrNull(i)?.takeIf { it.isNotEmpty() } ?: return def
            return s.toIntOrNull() ?: def
        }

        when (f) {
            'm' -> sgr(parts)
            'H', 'f' -> {
                wrapPending = false
                cursorRow = (p(0, 1) - 1).coerceIn(0, rows - 1)
                cursorCol = (p(1, 1) - 1).coerceIn(0, cols - 1)
            }

            'A' -> {
                wrapPending = false
                cursorRow = (cursorRow - p(0, 1)).coerceAtLeast(0)
            }

            'B' -> {
                wrapPending = false
                cursorRow = (cursorRow + p(0, 1)).coerceAtMost(rows - 1)
            }

            'C' -> {
                wrapPending = false
                cursorCol = (cursorCol + p(0, 1)).coerceAtMost(cols - 1)
            }

            'D' -> {
                wrapPending = false
                cursorCol = (cursorCol - p(0, 1)).coerceAtLeast(0)
            }

            'E' -> {
                wrapPending = false
                cursorRow = (cursorRow + p(0, 1)).coerceAtMost(rows - 1)
                cursorCol = 0
            }

            'F' -> {
                wrapPending = false
                cursorRow = (cursorRow - p(0, 1)).coerceAtLeast(0)
                cursorCol = 0
            }

            'G', '`' -> {
                wrapPending = false
                cursorCol = (p(0, 1) - 1).coerceIn(0, cols - 1)
            }

            'd' -> {
                wrapPending = false
                cursorRow = (p(0, 1) - 1).coerceIn(0, rows - 1)
            }

            'J' -> ed(p(0, 0))
            'K' -> el(p(0, 0))
            'S' -> scrollUp(p(0, 1))
            'T' -> if (!isPrivate) scrollDownInPlace(p(0, 1))
            'X' -> {
                val end = (cursorCol + p(0, 1)).coerceAtMost(cols)
                for (c in cursorCol until end) {
                    grid[cursorRow][c] = ' '
                    gridFg[cursorRow][c] = -1
                }
            }

            's' -> if (!isPrivate) {
                savedRow = cursorRow
                savedCol = cursorCol
            }

            'u' -> if (!isPrivate) {
                cursorRow = savedRow.coerceIn(0, rows - 1)
                cursorCol = savedCol.coerceIn(0, cols - 1)
                wrapPending = false
            }

            else -> {}
        }
    }

    private fun sgr(parts: List<String>) {
        val nums = if (parts.isEmpty() || (parts.size == 1 && parts[0].isEmpty())) {
            listOf(0)
        } else {
            parts.map { it.toIntOrNull() ?: 0 }
        }
        for (n in nums) {
            when (n) {
                0 -> {
                    currentFg = -1
                    bold = false
                }

                1 -> bold = true
                22 -> bold = false
                39 -> currentFg = -1
                in 30..37 -> currentFg = n - 30
                in 90..97 -> currentFg = n - 90 + 8
                else -> {}
            }
        }
    }

    // ---------------------------------------------------------------- 写字符

    private fun effectiveFg(): Int = if (bold && currentFg in 0..7) currentFg + 8 else currentFg

    private fun isWide(cp: Int): Boolean =
        cp in 0x1100..0x115F || cp in 0x2E80..0x303E || cp in 0x3041..0x33FF ||
            cp in 0x3400..0x4DBF || cp in 0x4E00..0x9FFF || cp in 0xA000..0xA4CF ||
            cp in 0xAC00..0xD7A3 || cp in 0xF900..0xFAFF || cp in 0xFE30..0xFE6F ||
            cp in 0xFF00..0xFF60 || cp in 0xFFE0..0xFFE6 || cp in 0x20000..0x2FFFD ||
            cp in 0x30000..0x3FFFD

    private fun putChar(cp: Int) {
        if (wrapPending) {
            wrapPending = false
            cursorCol = 0
            lineFeed()
        }
        val units = Character.toChars(cp)
        val width = if (units.size == 2 || isWide(cp)) 2 else 1
        if (width == 2 && cursorCol == cols - 1) {
            // 最后一列放不下宽字符，先换行
            cursorCol = 0
            lineFeed()
        }
        val line = grid[cursorRow]
        val fg = gridFg[cursorRow]
        // 若覆盖在旧宽字符的占位格上，清掉左邻残留的半字符
        if (line[cursorCol] == '\u0000' && cursorCol > 0) {
            line[cursorCol - 1] = ' '
            gridFg[cursorRow][cursorCol - 1] = -1
        }
        val color = effectiveFg()
        if (units.size == 2) {
            // 代理对（emoji 等）：两个 UTF-16 单元各占一格，共 2 列
            line[cursorCol] = units[0]
            fg[cursorCol] = color
            line[cursorCol + 1] = units[1]
            fg[cursorCol + 1] = color
        } else {
            line[cursorCol] = units[0]
            fg[cursorCol] = color
            if (width == 2) {
                line[cursorCol + 1] = '\u0000'
                fg[cursorCol + 1] = color
            }
        }
        val endCol = cursorCol + width
        // 清理右侧残留的宽字符占位
        if (endCol < cols && line[endCol] == '\u0000') {
            line[endCol] = ' '
            fg[endCol] = -1
        }
        cursorCol = endCol
        if (cursorCol >= cols) {
            cursorCol = cols - 1
            wrapPending = true
        }
    }

    // ---------------------------------------------------------------- 滚动与擦除

    private fun lineFeed() {
        if (cursorRow == rows - 1) scrollUpOne() else cursorRow++
    }

    private fun scrollUpOne() {
        pushScrollback(grid[0], gridFg[0])
        for (r in 0 until rows - 1) {
            grid[r] = grid[r + 1]
            gridFg[r] = gridFg[r + 1]
        }
        grid[rows - 1] = CharArray(cols) { ' ' }
        gridFg[rows - 1] = IntArray(cols) { -1 }
    }

    private fun scrollUp(n: Int) {
        repeat(n.coerceAtMost(rows)) { scrollUpOne() }
    }

    private fun scrollDownInPlace(n: Int) {
        repeat(n.coerceAtMost(rows)) {
            for (r in rows - 1 downTo 1) {
                grid[r] = grid[r - 1]
                gridFg[r] = gridFg[r - 1]
            }
            grid[0] = CharArray(cols) { ' ' }
            gridFg[0] = IntArray(cols) { -1 }
        }
    }

    private fun pushScrollback(chars: CharArray, fg: IntArray) {
        scrollback.addLast(TerminalLine(chars.copyOf(), fg.copyOf(), trimmedLength(chars)))
        while (scrollback.size > SCROLLBACK_CAP) scrollback.removeFirst()
    }

    private fun ed(m: Int) {
        when (m) {
            0 -> {
                clearRange(cursorRow, cursorCol, cols)
                for (r in cursorRow + 1 until rows) clearLine(r)
            }

            1 -> {
                for (r in 0 until cursorRow) clearLine(r)
                clearRange(cursorRow, 0, cursorCol + 1)
            }

            else -> for (r in 0 until rows) clearLine(r)
        }
    }

    private fun el(m: Int) {
        when (m) {
            0 -> clearRange(cursorRow, cursorCol, cols)
            1 -> clearRange(cursorRow, 0, cursorCol + 1)
            else -> clearLine(cursorRow)
        }
    }

    private fun clearRange(row: Int, from: Int, to: Int) {
        for (c in from until to.coerceAtMost(cols)) {
            grid[row][c] = ' '
            gridFg[row][c] = -1
        }
    }

    private fun clearLine(row: Int) {
        java.util.Arrays.fill(grid[row], ' ')
        java.util.Arrays.fill(gridFg[row], -1)
    }

    private fun reset() {
        for (r in 0 until rows) clearLine(r)
        cursorRow = 0
        cursorCol = 0
        currentFg = -1
        bold = false
        wrapPending = false
    }

    // ---------------------------------------------------------------- 快照与尺寸

    @Synchronized
    fun snapshot(): List<TerminalLine> {
        val out = ArrayList<TerminalLine>(scrollback.size + rows)
        for (l in scrollback) out.add(TerminalLine(l.chars.copyOf(), l.fg.copyOf(), l.length))
        for (r in 0 until rows) {
            out.add(TerminalLine(grid[r].copyOf(), gridFg[r].copyOf(), trimmedLength(grid[r])))
        }
        // 去掉尾部空行：UI 按"跟随末尾"滚动，光标未到底部时网格尾部的空白行
        // 会把仅有顶部几行内容的画面顶出可视区，表现为终端空白。
        while (out.size > 1 && out[out.size - 1].length == 0) out.removeAt(out.size - 1)
        return out
    }

    @Synchronized
    fun resize(newCols: Int, newRows: Int) {
        val nc = newCols.coerceAtLeast(2)
        val nr = newRows.coerceAtLeast(2)
        if (nc == cols && nr == rows) return
        grid = Array(nr) { r -> CharArray(nc) { c -> if (r < rows && c < cols) grid[r][c] else ' ' } }
        gridFg = Array(nr) { r -> IntArray(nc) { c -> if (r < rows && c < cols) gridFg[r][c] else -1 } }
        cols = nc
        rows = nr
        cursorRow = cursorRow.coerceIn(0, rows - 1)
        cursorCol = cursorCol.coerceIn(0, cols - 1)
        wrapPending = false
        version++
    }

    private fun trimmedLength(chars: CharArray): Int {
        var end = chars.size
        while (end > 0 && chars[end - 1] == ' ') end--
        return end
    }

    private companion object {
        const val SCROLLBACK_CAP = 2000
    }
}
