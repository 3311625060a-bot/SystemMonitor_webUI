param(
  [Parameter(Mandatory = $true)][int]$ServerPid,
  [string]$Url = ''
)

$ErrorActionPreference = 'Stop'

# 与服务端 port.js 保持一致：SM_PORT 环境变量 > %LOCALAPPDATA%\SystemMonitor\port.txt > 3000
function Get-ListenPort {
  $candidates = @($env:SM_PORT)
  if ($env:LOCALAPPDATA) {
    $portFile = Join-Path (Join-Path $env:LOCALAPPDATA 'SystemMonitor') 'port.txt'
    if (Test-Path -LiteralPath $portFile) {
      $firstLine = (Get-Content -LiteralPath $portFile -TotalCount 1)
      $candidates += (-join ($firstLine -replace '[^0-9]', ''))
    }
  }
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    $value = 0
    if ([int]::TryParse($candidate.Trim(), [ref]$value) -and $value -ge 1 -and $value -le 65535) {
      return $value
    }
  }
  return 3000
}

if (-not $Url) {
  $Url = ('http://127.0.0.1:{0}' -f (Get-ListenPort))
}

$mutex = New-Object System.Threading.Mutex($false, 'Local\SystemMonitorTray')
$acquired = $false
try {
  $acquired = $mutex.WaitOne(4000)
} catch [System.Threading.AbandonedMutexException] {
  $acquired = $true
}
if (-not $acquired) { exit 0 }

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$uiSource = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace SystemMonitorTray
{
    public sealed class TrayMetrics
    {
        public bool IsOnline;
        public string Status = "未连接";
        public string Subtitle = "实时性能监控";
        public string CpuValue = "--";
        public string CpuSub = "";
        public double CpuPct = -1;
        public string MemValue = "--";
        public string MemSub = "";
        public double MemPct = -1;
        public string GpuValue = "--";
        public string GpuSub = "";
        public double GpuPct = -1;
        public string VramTitle = "显存";
        public string VramValue = "--";
        public string VramSub = "";
        public double VramPct = -1;
        public string NetValue = "--";
        public string NetSub = "MB/s";
        public string PowerValue = "--";
        public string PowerSub = "";
        public double PowerPct = -1;
    }

    public static class NativeDpi
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int X;
            public int Y;
        }

        [DllImport("user32.dll")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("shcore.dll")]
        private static extern int SetProcessDpiAwareness(int value);
        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")]
        private static extern IntPtr MonitorFromPoint(POINT point, int flags);
        [DllImport("shcore.dll")]
        private static extern int GetDpiForMonitor(IntPtr monitor, int dpiType, out uint dpiX, out uint dpiY);
        [DllImport("user32.dll")]
        public static extern int GetDpiForWindow(IntPtr hwnd);
        [DllImport("user32.dll")]
        public static extern int GetDpiForSystem();
        [DllImport("user32.dll")]
        public static extern bool DestroyIcon(IntPtr hIcon);
        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        public static void EnableDpiAwareness()
        {
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
            try { if (SetProcessDpiAwareness(2) == 0) return; } catch { }
            try { SetProcessDPIAware(); } catch { }
        }

        public static int DpiAtPoint(int x, int y)
        {
            try
            {
                POINT point;
                point.X = x;
                point.Y = y;
                IntPtr monitor = MonitorFromPoint(point, 2);
                uint dpiX;
                uint dpiY;
                if (monitor != IntPtr.Zero && GetDpiForMonitor(monitor, 0, out dpiX, out dpiY) == 0 && dpiX > 0)
                    return (int)dpiX;
            }
            catch { }
            return 96;
        }

        public static void EnableRoundedCorners(IntPtr hwnd)
        {
            try
            {
                int preference = 2;
                DwmSetWindowAttribute(hwnd, 33, ref preference, 4);
            }
            catch { }
        }
    }

    public sealed class ModernTrayPopup : Form
    {
        private const float BaseWidth = 360f;
        private const float BaseHeight = 494f;
        private const int WmDpiChanged = 0x02E0;

        private TrayMetrics metrics;
        private float scale = 1f;
        private int currentDpi;
        private bool isDark;
        private bool ignoreDpiChange;
        private Font fCaption;
        private Font fValue;
        private Font fValueSmall;
        private Font fSub;
        private Font fTitle;
        private Font fSubtitle;
        private Font fButton;
        private Font fChip;
        private RectangleF rectOpen;
        private RectangleF rectExit;
        private RectangleF rectAutoStart;
        private RectangleF rectIdlePause;
        private bool autoStart;
        private bool idlePause = true;
        private int hover;
        private int pressed;

        public event EventHandler OpenRequested;
        public event EventHandler ExitRequested;
        public event EventHandler AutoStartToggled;
        public event EventHandler IdlePauseToggled;

        public ModernTrayPopup()
        {
            metrics = new TrayMetrics();
            SetStyle(ControlStyles.AllPaintingInWmPaint |
                     ControlStyles.OptimizedDoubleBuffer |
                     ControlStyles.UserPaint |
                     ControlStyles.ResizeRedraw, true);
            FormBorderStyle = FormBorderStyle.None;
            ShowInTaskbar = false;
            StartPosition = FormStartPosition.Manual;
            TopMost = true;
            AutoScaleMode = AutoScaleMode.None;
            DoubleBuffered = true;
            KeyPreview = true;
            BackColor = Color.White;
            Text = "系统监控面板";
            Font = new Font("Microsoft YaHei UI", 9f, FontStyle.Regular, GraphicsUnit.Point);
        }

        public bool IsDark
        {
            get { return isDark; }
            set
            {
                if (isDark != value)
                {
                    isDark = value;
                    Invalidate();
                }
            }
        }

        public bool AutoStart
        {
            get { return autoStart; }
            set
            {
                if (autoStart != value)
                {
                    autoStart = value;
                    Invalidate();
                }
            }
        }

        public bool IdlePause
        {
            get { return idlePause; }
            set
            {
                if (idlePause != value)
                {
                    idlePause = value;
                    Invalidate();
                }
            }
        }

        protected override CreateParams CreateParams
        {
            get
            {
                CreateParams cp = base.CreateParams;
                cp.ClassStyle |= 0x00020000;
                cp.ExStyle |= 0x00000080;
                return cp;
            }
        }

        public void SetMetrics(TrayMetrics value)
        {
            metrics = value == null ? new TrayMetrics() : value;
            Invalidate();
        }

        public void ShowNearCursor()
        {
            Point cursor = Cursor.Position;
            Screen screen = Screen.FromPoint(cursor);
            int dpi = NativeDpi.DpiAtPoint(cursor.X, cursor.Y);
            int x;
            int y;

            ignoreDpiChange = true;
            try
            {
                ApplyDpi(dpi);
                Rectangle area = screen.WorkingArea;
                int margin = S(10);
                x = cursor.X - Width / 2;
                y = cursor.Y > area.Top + area.Height / 2
                    ? area.Bottom - Height - margin
                    : area.Top + margin;
                if (x + Width > area.Right - margin) x = area.Right - Width - margin;
                if (x < area.Left + margin) x = area.Left + margin;
                if (y < area.Top + margin) y = area.Top + margin;
                if (y + Height > area.Bottom - margin) y = area.Bottom - Height - margin;
                Location = new Point(x, y);
                Show();
                Activate();
                BringToFront();
            }
            finally
            {
                ignoreDpiChange = false;
            }
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (!ignoreDpiChange)
            {
                int dpi = 96;
                try { dpi = NativeDpi.GetDpiForWindow(Handle); } catch { }
                ApplyDpi(dpi);
            }
            NativeDpi.EnableRoundedCorners(Handle);
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WmDpiChanged)
            {
                if (ignoreDpiChange) return;
                if (Visible) Hide();
                return;
            }
            base.WndProc(ref m);
        }

        private void ApplyDpi(int dpi)
        {
            if (dpi <= 0) dpi = 96;
            if (dpi == currentDpi && fTitle != null)
            {
                UpdateLayout();
                return;
            }

            currentDpi = dpi;
            scale = dpi / 96f;
            DisposeFonts();

            string ui = "Microsoft YaHei UI";
            string numeric = "Segoe UI";
            fCaption = new Font(ui, 8.25f, FontStyle.Regular, GraphicsUnit.Point);
            fSub = new Font(ui, 8.25f, FontStyle.Regular, GraphicsUnit.Point);
            fSubtitle = new Font(ui, 8.25f, FontStyle.Regular, GraphicsUnit.Point);
            fChip = new Font(ui, 8f, FontStyle.Regular, GraphicsUnit.Point);
            fTitle = new Font(ui, 11.5f, FontStyle.Bold, GraphicsUnit.Point);
            fButton = new Font(ui, 9.25f, FontStyle.Bold, GraphicsUnit.Point);
            fValue = new Font(numeric, 15.5f, FontStyle.Bold, GraphicsUnit.Point);
            fValueSmall = new Font(numeric, 12.5f, FontStyle.Bold, GraphicsUnit.Point);

            ClientSize = new Size(S(BaseWidth), S(BaseHeight));
            UpdateLayout();
            ApplyWindowShape();
        }

        private void ApplyWindowShape()
        {
            if (Environment.OSVersion.Version.Build < 22000)
            {
                using (GraphicsPath path = RoundRect(new RectangleF(0f, 0f, Width, Height), SF(11)))
                    Region = new Region(path);
            }
        }

        private void UpdateLayout()
        {
            float pad = SF(18);
            float cardTop = SF(64);
            float cardHeight = SF(80);
            float gap = SF(10);
            float autoTop = cardTop + cardHeight * 3 + gap * 2 + SF(12);
            float rowHeight = SF(42);
            float idleTop = autoTop + rowHeight + SF(10);
            float buttonTop = idleTop + rowHeight + SF(12);
            float buttonHeight = SF(40);
            float contentWidth = ClientSize.Width - pad * 2 - gap;
            float openWidth = (float)Math.Round(contentWidth * 0.58f);
            rectAutoStart = new RectangleF(pad, autoTop, ClientSize.Width - pad * 2, rowHeight);
            rectIdlePause = new RectangleF(pad, idleTop, ClientSize.Width - pad * 2, rowHeight);
            rectOpen = new RectangleF(pad, buttonTop, openWidth, buttonHeight);
            rectExit = new RectangleF(pad + openWidth + gap, buttonTop, contentWidth - openWidth, buttonHeight);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (fTitle == null) return;

            Graphics g = e.Graphics;
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            g.InterpolationMode = InterpolationMode.HighQualityBicubic;

            Color background = isDark ? Color.FromArgb(23, 26, 32) : Color.White;
            Color border = isDark ? Color.FromArgb(42, 48, 59) : Color.FromArgb(228, 232, 238);
            Color textColor = isDark ? Color.FromArgb(230, 234, 241) : Color.FromArgb(31, 41, 55);
            Color mutedColor = isDark ? Color.FromArgb(133, 144, 160) : Color.FromArgb(138, 147, 160);

            g.Clear(background);
            using (GraphicsPath outline = RoundRect(new RectangleF(SF(0.5f), SF(0.5f), ClientSize.Width - SF(1), ClientSize.Height - SF(1)), SF(11)))
            using (Pen borderPen = new Pen(border, Math.Max(1f, SF(1))))
                g.DrawPath(borderPen, outline);

            DrawHeader(g, textColor, mutedColor);
            DrawCards(g, textColor, mutedColor);
            DrawAutoStart(g, textColor, mutedColor);
            DrawIdlePause(g, textColor, mutedColor);
            DrawButtons(g);
        }

        private void DrawHeader(Graphics g, Color textColor, Color mutedColor)
        {
            float pad = SF(18);
            float iconSize = SF(28);
            float iconTop = SF(16);
            DrawPulseIcon(g, new RectangleF(pad, iconTop, iconSize, iconSize));

            float textX = pad + iconSize + SF(10);
            float titleY = SF(11);
            float titleHeight = fTitle.GetHeight(g);
            float headerTextWidth = ClientSize.Width - textX - SF(112);
            DrawText(g, "系统监控", fTitle, new RectangleF(textX, titleY, headerTextWidth, titleHeight + SF(3)), textColor,
                TextFormatFlags.Left | TextFormatFlags.Top | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);

            float subtitleY = titleY + titleHeight - SF(1);
            DrawText(g, metrics.Subtitle == null ? "实时性能监控" : metrics.Subtitle, fSubtitle,
                new RectangleF(textX, subtitleY, headerTextWidth, fSubtitle.GetHeight(g) + SF(3)), mutedColor,
                TextFormatFlags.Left | TextFormatFlags.Top | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);

            string status = string.IsNullOrEmpty(metrics.Status) ? "未连接" : metrics.Status;
            Size statusSize = TextRenderer.MeasureText(status, fChip, new Size(1000, 100), TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
            float dot = SF(6);
            float chipHeight = SF(24);
            float chipWidth = statusSize.Width + SF(26);
            float chipX = ClientSize.Width - pad - chipWidth;
            float chipY = SF(18);

            Color chipBackground = metrics.IsOnline
                ? (isDark ? Color.FromArgb(24, 52, 43) : Color.FromArgb(231, 248, 242))
                : (isDark ? Color.FromArgb(58, 30, 34) : Color.FromArgb(253, 236, 236));
            Color chipForeground = metrics.IsOnline
                ? (isDark ? Color.FromArgb(52, 211, 153) : Color.FromArgb(5, 150, 105))
                : (isDark ? Color.FromArgb(248, 113, 113) : Color.FromArgb(220, 38, 38));

            FillRound(g, chipBackground, new RectangleF(chipX, chipY, chipWidth, chipHeight), chipHeight / 2f);
            FillEllipse(g, chipForeground, new RectangleF(chipX + SF(10), chipY + (chipHeight - dot) / 2f, dot, dot));
            DrawText(g, status, fChip, new RectangleF(chipX + SF(20), chipY, chipWidth - SF(24), chipHeight), chipForeground,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
        }

        private void DrawCards(Graphics g, Color textColor, Color mutedColor)
        {
            float pad = SF(18);
            float top = SF(64);
            float gap = SF(10);
            float cardWidth = (ClientSize.Width - pad * 2 - gap) / 2f;
            float cardHeight = SF(80);

            DrawMetricCard(g, pad, top, cardWidth, cardHeight, "CPU", metrics.CpuValue, metrics.CpuSub, metrics.CpuPct, Accent(0), textColor, mutedColor);
            DrawMetricCard(g, pad + cardWidth + gap, top, cardWidth, cardHeight, "内存", metrics.MemValue, metrics.MemSub, metrics.MemPct, Accent(1), textColor, mutedColor);
            DrawMetricCard(g, pad, top + cardHeight + gap, cardWidth, cardHeight, "显卡", metrics.GpuValue, metrics.GpuSub, metrics.GpuPct, Accent(2), textColor, mutedColor);
            DrawMetricCard(g, pad + cardWidth + gap, top + cardHeight + gap, cardWidth, cardHeight, string.IsNullOrEmpty(metrics.VramTitle) ? "显存" : metrics.VramTitle, metrics.VramValue, metrics.VramSub, metrics.VramPct, Accent(3), textColor, mutedColor);
            DrawMetricCard(g, pad, top + (cardHeight + gap) * 2, cardWidth, cardHeight, "网络", metrics.NetValue, metrics.NetSub, -1, Accent(4), textColor, mutedColor);
            DrawMetricCard(g, pad + cardWidth + gap, top + (cardHeight + gap) * 2, cardWidth, cardHeight, "电源", metrics.PowerValue, metrics.PowerSub, metrics.PowerPct, Accent(5), textColor, mutedColor);
        }

        private void DrawMetricCard(Graphics g, float x, float y, float width, float height, string title, string value, string sub, double percent, Color accent, Color textColor, Color mutedColor)
        {
            Color cardFill = isDark ? Color.FromArgb(29, 34, 42) : Color.FromArgb(248, 250, 252);
            Color cardStroke = isDark ? Color.FromArgb(38, 44, 54) : Color.FromArgb(237, 240, 244);
            FillRound(g, cardFill, new RectangleF(x, y, width, height), SF(11));
            using (GraphicsPath path = RoundRect(new RectangleF(x + SF(0.5f), y + SF(0.5f), width - SF(1), height - SF(1)), SF(11)))
            using (Pen pen = new Pen(cardStroke, Math.Max(1f, SF(1))))
                g.DrawPath(pen, path);

            float innerX = x + SF(12);
            float innerWidth = width - SF(24);
            float dot = SF(6);
            float captionY = y + SF(9);
            float captionHeight = fCaption.GetHeight(g);
            FillEllipse(g, accent, new RectangleF(innerX, captionY + (captionHeight - dot) / 2f, dot, dot));
            DrawText(g, title == null ? "" : title, fCaption,
                new RectangleF(innerX + dot + SF(6), captionY, innerWidth - dot - SF(6), captionHeight + SF(2)), mutedColor,
                TextFormatFlags.Left | TextFormatFlags.Top | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);

            float barHeight = SF(4);
            float barY = y + height - SF(12);
            float subHeight = fSub.GetHeight(g);
            float subY = barY - SF(4) - subHeight;
            float valueY = y + SF(23);
            float valueHeight = Math.Max(SF(20), subY - valueY - SF(1));

            Font valueFont = fValue;
            Size valueSize = TextRenderer.MeasureText(value == null ? "--" : value, fValue, new Size(10000, 1000), TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
            if (valueSize.Width > innerWidth)
                valueFont = fValueSmall;

            DrawText(g, value == null ? "--" : value, valueFont, new RectangleF(innerX, valueY, innerWidth, valueHeight), textColor,
                TextFormatFlags.Left | TextFormatFlags.Top | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);
            DrawText(g, sub == null ? "" : sub, fSub, new RectangleF(innerX, subY, innerWidth, subHeight + SF(1)), mutedColor,
                TextFormatFlags.Left | TextFormatFlags.Top | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);

            if (percent >= 0)
            {
                Color track = isDark ? Color.FromArgb(42, 48, 59) : Color.FromArgb(237, 241, 246);
                FillRound(g, track, new RectangleF(innerX, barY, innerWidth, barHeight), barHeight / 2f);
                double clamped = percent > 100 ? 100 : percent;
                if (clamped > 0)
                {
                    float fillWidth = innerWidth * (float)(clamped / 100.0);
                    if (fillWidth < barHeight) fillWidth = barHeight;
                    FillRound(g, accent, new RectangleF(innerX, barY, fillWidth, barHeight), barHeight / 2f);
                }
            }
        }

        private void DrawAutoStart(Graphics g, Color textColor, Color mutedColor)
        {
            DrawSwitchRow(g, rectAutoStart, 3, autoStart, "开机自动启动",
                "登录 Windows 后自动在后台运行", textColor, mutedColor);
        }

        private void DrawIdlePause(Graphics g, Color textColor, Color mutedColor)
        {
            DrawSwitchRow(g, rectIdlePause, 4, idlePause, "空闲时暂停采样",
                "没人查看约 2 分钟后停止采集，访问时自动恢复", textColor, mutedColor);
        }

        private void DrawSwitchRow(Graphics g, RectangleF row, int hoverIndex, bool on,
            string title, string caption, Color textColor, Color mutedColor)
        {
            bool rowHover = hover == hoverIndex;
            Color fill = isDark
                ? (rowHover ? Color.FromArgb(33, 39, 48) : Color.FromArgb(29, 34, 42))
                : (rowHover ? Color.FromArgb(242, 246, 251) : Color.FromArgb(248, 250, 252));
            Color stroke = isDark ? Color.FromArgb(38, 44, 54) : Color.FromArgb(237, 240, 244);
            FillRound(g, fill, row, SF(11));
            using (GraphicsPath path = RoundRect(new RectangleF(row.X + SF(0.5f), row.Y + SF(0.5f), row.Width - SF(1), row.Height - SF(1)), SF(11)))
            using (Pen pen = new Pen(stroke, Math.Max(1f, SF(1))))
                g.DrawPath(pen, path);

            float innerX = row.X + SF(12);
            float labelY = row.Y + SF(5);
            float labelHeight = fButton.GetHeight(g);
            float trackWidth = SF(40);
            float trackX = row.Right - SF(12) - trackWidth;
            DrawText(g, title, fButton,
                new RectangleF(innerX, labelY, trackX - innerX - SF(8), labelHeight + SF(2)), textColor,
                TextFormatFlags.Left | TextFormatFlags.Top | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);

            float captionY = labelY + labelHeight - SF(2);
            DrawText(g, caption, fSub,
                new RectangleF(innerX, captionY, trackX - innerX - SF(8), fSub.GetHeight(g) + SF(2)), mutedColor,
                TextFormatFlags.Left | TextFormatFlags.Top | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine | TextFormatFlags.EndEllipsis);

            float trackHeight = SF(22);
            float trackY = row.Y + (row.Height - trackHeight) / 2f;
            Color track = on
                ? (isDark ? Color.FromArgb(96, 165, 250) : Color.FromArgb(59, 130, 246))
                : (isDark ? Color.FromArgb(55, 62, 74) : Color.FromArgb(209, 216, 226));
            FillRound(g, track, new RectangleF(trackX, trackY, trackWidth, trackHeight), trackHeight / 2f);

            float knob = trackHeight - SF(4);
            float knobX = on ? trackX + trackWidth - knob - SF(2) : trackX + SF(2);
            FillEllipse(g, Color.White, new RectangleF(knobX, trackY + SF(2), knob, knob));
        }

        private void DrawButtons(Graphics g)
        {
            Color accent = Color.FromArgb(59, 130, 246);
            Color accentHover = isDark ? Color.FromArgb(96, 165, 250) : Color.FromArgb(47, 115, 232);
            Color primary = (hover == 1 || pressed == 1) ? accentHover : accent;
            FillRound(g, primary, rectOpen, SF(10));
            DrawText(g, "打开监控页面", fButton, rectOpen, Color.White,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);

            bool exitHover = hover == 2 || pressed == 2;
            Color exitBackground = exitHover
                ? (isDark ? Color.FromArgb(46, 27, 30) : Color.FromArgb(254, 242, 242))
                : (isDark ? Color.FromArgb(29, 34, 42) : Color.FromArgb(248, 250, 252));
            Color exitBorder = exitHover
                ? (isDark ? Color.FromArgb(80, 40, 45) : Color.FromArgb(252, 205, 205))
                : (isDark ? Color.FromArgb(38, 44, 54) : Color.FromArgb(237, 240, 244));
            Color exitText = exitHover
                ? (isDark ? Color.FromArgb(248, 113, 113) : Color.FromArgb(220, 38, 38))
                : (isDark ? Color.FromArgb(185, 193, 205) : Color.FromArgb(75, 85, 99));
            FillRound(g, exitBackground, rectExit, SF(10));
            using (GraphicsPath path = RoundRect(new RectangleF(rectExit.X + SF(0.5f), rectExit.Y + SF(0.5f), rectExit.Width - SF(1), rectExit.Height - SF(1)), SF(10)))
            using (Pen pen = new Pen(exitBorder, Math.Max(1f, SF(1))))
                g.DrawPath(pen, path);
            DrawText(g, "结束后台进程", fButton, rectExit, exitText,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.SingleLine);
        }

        private void DrawPulseIcon(Graphics g, RectangleF rect)
        {
            using (LinearGradientBrush brush = new LinearGradientBrush(rect, Color.FromArgb(52, 211, 153), Color.FromArgb(5, 150, 105), 45f))
                g.FillEllipse(brush, rect);

            float size = rect.Width;
            PointF[] points = new PointF[]
            {
                new PointF(rect.X + size * 0.22f, rect.Y + size * 0.53f),
                new PointF(rect.X + size * 0.36f, rect.Y + size * 0.53f),
                new PointF(rect.X + size * 0.43f, rect.Y + size * 0.36f),
                new PointF(rect.X + size * 0.52f, rect.Y + size * 0.69f),
                new PointF(rect.X + size * 0.61f, rect.Y + size * 0.45f),
                new PointF(rect.X + size * 0.74f, rect.Y + size * 0.45f),
                new PointF(rect.X + size * 0.80f, rect.Y + size * 0.53f)
            };
            using (Pen pen = new Pen(Color.White, Math.Max(1.4f, size * 0.085f)))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                pen.LineJoin = LineJoin.Round;
                g.DrawLines(pen, points);
            }
        }

        private Color Accent(int index)
        {
            if (isDark)
            {
                switch (index)
                {
                    case 0: return Color.FromArgb(96, 165, 250);
                    case 1: return Color.FromArgb(167, 139, 250);
                    case 2: return Color.FromArgb(52, 211, 153);
                    case 3: return Color.FromArgb(251, 191, 36);
                    case 4: return Color.FromArgb(34, 211, 238);
                    default: return Color.FromArgb(74, 222, 128);
                }
            }
            switch (index)
            {
                case 0: return Color.FromArgb(59, 130, 246);
                case 1: return Color.FromArgb(139, 92, 246);
                case 2: return Color.FromArgb(16, 185, 129);
                case 3: return Color.FromArgb(245, 158, 11);
                case 4: return Color.FromArgb(6, 182, 212);
                default: return Color.FromArgb(34, 197, 94);
            }
        }

        private float SF(float value)
        {
            return value * scale;
        }

        private int S(float value)
        {
            return (int)Math.Round(value * scale);
        }

        private static void DrawText(Graphics g, string text, Font font, RectangleF rect, Color color, TextFormatFlags flags)
        {
            TextRenderer.DrawText(g, text, font, Rectangle.Round(rect), color, flags | TextFormatFlags.NoPrefix);
        }

        private static void FillEllipse(Graphics g, Color color, RectangleF rect)
        {
            using (SolidBrush brush = new SolidBrush(color))
                g.FillEllipse(brush, rect);
        }

        private static void FillRound(Graphics g, Color color, RectangleF rect, float radius)
        {
            using (GraphicsPath path = RoundRect(rect, radius))
            using (SolidBrush brush = new SolidBrush(color))
                g.FillPath(brush, path);
        }

        private static GraphicsPath RoundRect(RectangleF rect, float radius)
        {
            GraphicsPath path = new GraphicsPath();
            if (radius <= 0.5f || rect.Width <= 0f || rect.Height <= 0f)
            {
                path.AddRectangle(rect);
                return path;
            }
            float diameter = radius * 2f;
            if (diameter > rect.Width) diameter = rect.Width;
            if (diameter > rect.Height) diameter = rect.Height;
            path.AddArc(rect.X, rect.Y, diameter, diameter, 180f, 90f);
            path.AddArc(rect.Right - diameter, rect.Y, diameter, diameter, 270f, 90f);
            path.AddArc(rect.Right - diameter, rect.Bottom - diameter, diameter, diameter, 0f, 90f);
            path.AddArc(rect.X, rect.Bottom - diameter, diameter, diameter, 90f, 90f);
            path.CloseFigure();
            return path;
        }

        private void DisposeFonts()
        {
            if (fCaption != null) fCaption.Dispose();
            if (fValue != null) fValue.Dispose();
            if (fValueSmall != null) fValueSmall.Dispose();
            if (fSub != null) fSub.Dispose();
            if (fTitle != null) fTitle.Dispose();
            if (fSubtitle != null) fSubtitle.Dispose();
            if (fButton != null) fButton.Dispose();
            if (fChip != null) fChip.Dispose();
            fCaption = null;
            fValue = null;
            fValueSmall = null;
            fSub = null;
            fTitle = null;
            fSubtitle = null;
            fButton = null;
            fChip = null;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) DisposeFonts();
            base.Dispose(disposing);
        }

        // 1=打开页面 2=结束进程 3=开机启动 4=空闲暂停采样
        private int HitIndex(System.Drawing.Point p)
        {
            if (rectOpen.Contains(p)) return 1;
            if (rectExit.Contains(p)) return 2;
            if (rectAutoStart.Contains(p)) return 3;
            if (rectIdlePause.Contains(p)) return 4;
            return 0;
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            int next = HitIndex(e.Location);
            if (next != hover)
            {
                hover = next;
                Cursor = next == 0 ? Cursors.Default : Cursors.Hand;
                Invalidate();
            }
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            base.OnMouseLeave(e);
            if (hover != 0)
            {
                hover = 0;
                Cursor = Cursors.Default;
                Invalidate();
            }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left)
            {
                pressed = HitIndex(e.Location);
                Invalidate();
            }
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            base.OnMouseUp(e);
            if (e.Button != MouseButtons.Left) return;
            int hit = HitIndex(e.Location);
            int action = hit == pressed ? hit : 0;
            pressed = 0;
            Invalidate();
            if (action == 0) return;
            if (action == 3)
            {
                AutoStart = !autoStart;
                if (AutoStartToggled != null) AutoStartToggled(this, EventArgs.Empty);
                return;
            }
            if (action == 4)
            {
                IdlePause = !idlePause;
                if (IdlePauseToggled != null) IdlePauseToggled(this, EventArgs.Empty);
                return;
            }
            Hide();
            if (action == 1 && OpenRequested != null) OpenRequested(this, EventArgs.Empty);
            if (action == 2 && ExitRequested != null) ExitRequested(this, EventArgs.Empty);
        }

        protected override void OnVisibleChanged(EventArgs e)
        {
            base.OnVisibleChanged(e);
            if (!Visible)
            {
                hover = 0;
                pressed = 0;
                Cursor = Cursors.Default;
            }
        }

        protected override void OnDeactivate(EventArgs e)
        {
            base.OnDeactivate(e);
            if (Visible) Hide();
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
            }
            base.OnFormClosing(e);
        }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            if (keyData == Keys.Escape)
            {
                Hide();
                return true;
            }
            return base.ProcessCmdKey(ref msg, keyData);
        }
    }
}
'@

Add-Type -TypeDefinition $uiSource -ReferencedAssemblies 'System.Windows.Forms.dll', 'System.Drawing.dll' -ErrorAction Stop
[SystemMonitorTray.NativeDpi]::EnableDpiAwareness()

function Get-JsonUtf8 {
  param(
    [Parameter(Mandatory = $true)][string]$Uri,
    [int]$TimeoutSec = 3
  )
  $response = Invoke-WebRequest -Uri $Uri -TimeoutSec $TimeoutSec -UseBasicParsing
  $bytes = $response.RawContentStream.ToArray()
  [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
}

function Stop-Server {
  $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ServerPid" -ErrorAction SilentlyContinue
  if ($proc -and $proc.Name -match '^node(\.exe)?$') {
    Stop-Process -Id $ServerPid -Force -ErrorAction SilentlyContinue
  }
}

function Get-SystemThemeDark {
  try {
    $value = Get-ItemPropertyValue -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize' -Name 'AppsUseLightTheme' -ErrorAction Stop
    return ([int]$value -eq 0)
  } catch {
    return $false
  }
}

$script:runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$script:runValue = 'SystemMonitor'

function Get-LauncherPath {
  $candidates = @(
    (Join-Path $PSScriptRoot 'SystemMonitor.exe'),
    (Join-Path $PSScriptRoot 'build\SystemMonitor.exe')
  )
  foreach ($path in $candidates) {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      return $path
    }
  }
  return $null
}

function Get-AutoStartEnabled {
  try {
    $value = Get-ItemPropertyValue -Path $script:runKey -Name $script:runValue -ErrorAction Stop
    return (-not [string]::IsNullOrWhiteSpace([string]$value))
  } catch {
    return $false
  }
}

function Set-AutoStartEnabled([bool]$enabled) {
  if ($enabled) {
    $launcher = Get-LauncherPath
    if (-not $launcher) {
      throw '未找到 SystemMonitor.exe，无法设置开机启动。'
    }
    if (-not (Test-Path -LiteralPath $script:runKey)) {
      New-Item -Path $script:runKey -Force | Out-Null
    }
    $command = '"' + $launcher + '" --silent'
    Set-ItemProperty -Path $script:runKey -Name $script:runValue -Value $command
  } else {
    Remove-ItemProperty -Path $script:runKey -Name $script:runValue -ErrorAction SilentlyContinue
  }
}

# 采样策略由服务端保存在 settings.json 里，托盘只负责读和写：
# 服务重启后仍然保持上一次的选择。读取失败（比如服务刚重启）时按默认值"开启"显示。
function Get-SamplerIdlePause {
  try {
    $settings = Get-JsonUtf8 -Uri ($Url + '/api/settings') -TimeoutSec 2
    if ($null -eq $settings) { return $true }
    return [bool]$settings.samplerIdlePause
  } catch {
    return $true
  }
}

function Set-SamplerIdlePause([bool]$enabled) {
  $body = '{"samplerIdlePause":' + $(if ($enabled) { 'true' } else { 'false' }) + '}'
  $tmp = Join-Path $env:TEMP ('sm-tray-settings-' + $ServerPid + '.json')
  try {
    [IO.File]::WriteAllText($tmp, $body, (New-Object Text.UTF8Encoding($false)))
    $raw = & curl.exe -s -X POST -H 'Content-Type: application/json' --data-binary ('@' + $tmp) ($Url + '/api/settings')
    if ($LASTEXITCODE -ne 0) { throw ("curl 退出码 " + $LASTEXITCODE) }
    if ([string]::IsNullOrWhiteSpace($raw)) { throw '服务没有响应' }
    $parsed = $raw | ConvertFrom-Json
    if ($null -eq $parsed.samplerIdlePause) { throw '响应格式不正确' }
    return [bool]$parsed.samplerIdlePause
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }
}

function New-TrayIconBitmap([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gfx = [System.Drawing.Graphics]::FromImage($bmp)
  $brush = $null
  $pen = $null
  try {
    $gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $gfx.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $gfx.Clear([System.Drawing.Color]::Transparent)
    $inset = [Math]::Max(0.5, $size * 0.04)
    $rect = New-Object System.Drawing.RectangleF([float]$inset, [float]$inset, [float]($size - 2 * $inset), [float]($size - 2 * $inset))
    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect, [System.Drawing.Color]::FromArgb(52, 211, 153), [System.Drawing.Color]::FromArgb(5, 150, 105), [float]45)
    $gfx.FillEllipse($brush, $rect)

    $pen = New-Object System.Drawing.Pen([System.Drawing.Color]::White, [float]([Math]::Max(1.4, $size * 0.095)))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $points = [System.Drawing.PointF[]]@(
      (New-Object System.Drawing.PointF([float]($size * 0.23), [float]($size * 0.54))),
      (New-Object System.Drawing.PointF([float]($size * 0.37), [float]($size * 0.54))),
      (New-Object System.Drawing.PointF([float]($size * 0.44), [float]($size * 0.37))),
      (New-Object System.Drawing.PointF([float]($size * 0.53), [float]($size * 0.68))),
      (New-Object System.Drawing.PointF([float]($size * 0.62), [float]($size * 0.46))),
      (New-Object System.Drawing.PointF([float]($size * 0.75), [float]($size * 0.46))),
      (New-Object System.Drawing.PointF([float]($size * 0.80), [float]($size * 0.54)))
    )
    $gfx.DrawLines($pen, $points)
    return $bmp
  } finally {
    if ($pen) { $pen.Dispose() }
    if ($brush) { $brush.Dispose() }
    $gfx.Dispose()
  }
}

function Get-PopupMetrics {
  $tm = New-Object SystemMonitorTray.TrayMetrics
  $tm.Subtitle = $script:subtitle
  $tm.CpuSub = $script:cpuSub
  $tm.NetSub = 'MB/s'
  $tm.VramTitle = '显存'

  $metrics = $null
  try {
    $metrics = Get-JsonUtf8 -Uri ($Url + '/api/metrics') -TimeoutSec 2
  } catch {}

  if (-not $metrics) {
    $notify.Text = '系统监控 · 未连接'
    return $tm
  }

  $tm.IsOnline = $true
  $tm.Status = '运行中'

  $cpuPercent = [double]$metrics.cpu.usagePercent
  $tm.CpuValue = ('{0:N1}%' -f $cpuPercent)
  $tm.CpuPct = [Math]::Max(0, [Math]::Min(100, $cpuPercent))

  $memPercent = [double]$metrics.memory.percent
  $tm.MemValue = ('{0:N1}%' -f $memPercent)
  $tm.MemSub = ('{0:N1} / {1:N1} GB' -f [double]$metrics.memory.usedGB, [double]$metrics.memory.totalGB)
  $tm.MemPct = [Math]::Max(0, [Math]::Min(100, $memPercent))

  $gpus = @($metrics.gpus)
  $gpu = @($gpus | Where-Object { $_.kind -eq 'discrete' })[0]
  if (-not $gpu) { $gpu = @($gpus | Where-Object { $_.kind -ne 'integrated' })[0] }
  if (-not $gpu) { $gpu = $gpus[0] }

  if ($gpu) {
    if ($null -ne $gpu.usagePercent) {
      $gpuPercent = [double]$gpu.usagePercent
      $tm.GpuValue = ('{0:N0}%' -f $gpuPercent)
      $tm.GpuPct = [Math]::Max(0, [Math]::Min(100, $gpuPercent))
    } else {
      $tm.GpuValue = '--'
    }

    $gpuSub = [string]$gpu.label
    if ($null -ne $gpu.temp) { $gpuSub += (' · {0}°C' -f [int]$gpu.temp) }
    $tm.GpuSub = $gpuSub

    if ([double]$gpu.vramTotalMB -gt 0) {
      $vramUsed = [double]$gpu.vramUsedMB / 1024
      $vramTotal = [double]$gpu.vramTotalMB / 1024
      $vramPercent = if ($vramTotal -gt 0) { $vramUsed / $vramTotal * 100 } else { 0 }
      $tm.VramTitle = '显存'
      $tm.VramValue = ('{0:N1} / {1:N1} GB' -f $vramUsed, $vramTotal)
      $tm.VramSub = ('{0:N0}% 已使用' -f $vramPercent)
      $tm.VramPct = [Math]::Max(0, [Math]::Min(100, $vramPercent))
    } elseif ([double]$gpu.sharedUsedMB -gt 0) {
      $tm.VramTitle = '共享内存'
      $tm.VramValue = ('{0:N1} GB' -f ([double]$gpu.sharedUsedMB / 1024))
      $tm.VramSub = '使用系统内存'
    } else {
      $tm.VramTitle = '显存'
      $tm.VramValue = '--'
    }
  } else {
    $tm.GpuValue = '--'
    $tm.GpuSub = '未检测到'
    $tm.VramValue = '--'
  }

  $tm.NetValue = ('↓{0:N2}  ↑{1:N2}' -f [double]$metrics.io.netDownMBs, [double]$metrics.io.netUpMBs)
  $tm.NetSub = 'MB/s'

  if ($metrics.power) {
    $powerPercent = [int]$metrics.power.percent
    $tm.PowerValue = ('{0}%' -f $powerPercent)
    $tm.PowerSub = if ($metrics.power.acConnected) { '充电中' } else { '使用电池' }
    $tm.PowerPct = [Math]::Max(0, [Math]::Min(100, $powerPercent))
  } else {
    $tm.PowerValue = '交流电'
    $tm.PowerSub = '未检测到电池'
  }

  $notify.Text = ('系统监控 · CPU {0:N0}% · 内存 {1:N0}%' -f $cpuPercent, $memPercent)
  return $tm
}

$sysInfo = $null
try {
  $sysInfo = Get-JsonUtf8 -Uri ($Url + '/api/system-info') -TimeoutSec 3
} catch {}

$script:subtitle = '实时性能监控'
if ($sysInfo -and $sysInfo.os -and $sysInfo.os.hostname) {
  $script:subtitle = ('{0} · 实时监控' -f $sysInfo.os.hostname)
}
$script:cpuSub = '实时占用'
if ($sysInfo -and $sysInfo.cpu -and $sysInfo.cpu.physicalCores -and $sysInfo.cpu.cores) {
  $script:cpuSub = ('{0} 核 / {1} 线程' -f [int]$sysInfo.cpu.physicalCores, [int]$sysInfo.cpu.cores)
}

$script:lastHidden = [DateTime]::MinValue

[System.Windows.Forms.Application]::EnableVisualStyles()
$ctx = New-Object System.Windows.Forms.ApplicationContext
$popup = New-Object SystemMonitorTray.ModernTrayPopup

$iconDpi = 96
try { $iconDpi = [SystemMonitorTray.NativeDpi]::GetDpiForSystem() } catch {}
$iconSize = [int][Math]::Round(16 * ($iconDpi / 96.0))
if ($iconSize -lt 16) { $iconSize = 16 }
if ($iconSize -gt 64) { $iconSize = 64 }
$iconBitmap = New-TrayIconBitmap $iconSize
$iconHandle = $iconBitmap.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($iconHandle)

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $icon
$notify.Text = '系统监控'
$notify.Visible = $true

$refresh = New-Object System.Windows.Forms.Timer
$refresh.Interval = 2000
$refresh.add_Tick({
  if (-not $popup.Visible) {
    $refresh.Stop()
    return
  }
  $popup.SetMetrics((Get-PopupMetrics))
})

$watch = New-Object System.Windows.Forms.Timer
$watch.Interval = 3000
$watch.add_Tick({
  if (-not (Get-Process -Id $ServerPid -ErrorAction SilentlyContinue)) {
    $refresh.Stop()
    $watch.Stop()
    $ctx.ExitThread()
  }
})

function Show-Popup {
  $popup.IsDark = Get-SystemThemeDark
  $popup.AutoStart = Get-AutoStartEnabled
  # 先取回开关状态再显示，避免面板上出现"先亮后灭"的跳变。
  $popup.IdlePause = Get-SamplerIdlePause
  $popup.ShowNearCursor()
  $popup.SetMetrics((Get-PopupMetrics))
  $refresh.Start()
}

function Toggle-Popup {
  if ($popup.Visible) {
    $popup.Hide()
    return
  }
  if (((Get-Date) - $script:lastHidden).TotalMilliseconds -lt 300) { return }
  Show-Popup
}

$popup.add_VisibleChanged({
  if ($popup.Visible) {
    $refresh.Start()
  } else {
    $refresh.Stop()
    $script:lastHidden = Get-Date
  }
})

$popup.add_OpenRequested({
  Start-Process $Url
})

$popup.add_ExitRequested({
  Stop-Server
  $ctx.ExitThread()
})

$popup.add_AutoStartToggled({
  try {
    Set-AutoStartEnabled ([bool]$popup.AutoStart)
  } catch {
    $popup.AutoStart = Get-AutoStartEnabled
    [void][System.Windows.Forms.MessageBox]::Show(
      ("无法修改开机启动设置：`n" + $_.Exception.Message),
      '系统监控',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning)
  }
})

$popup.add_IdlePauseToggled({
  try {
    $popup.IdlePause = Set-SamplerIdlePause ([bool]$popup.IdlePause)
  } catch {
    $popup.IdlePause = Get-SamplerIdlePause
    [void][System.Windows.Forms.MessageBox]::Show(
      ("无法修改采样设置：`n" + $_.Exception.Message),
      '系统监控',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Warning)
  }
})

$notify.add_MouseUp({ Toggle-Popup })
$notify.add_DoubleClick({
  $popup.Hide()
  Start-Process $Url
})

$watch.Start()
$refresh.Interval = 2000
$ErrorActionPreference = 'SilentlyContinue'

try {
  [System.Windows.Forms.Application]::Run($ctx)
} finally {
  $refresh.Stop()
  $watch.Stop()
  $popup.Hide()
  $popup.Dispose()
  $notify.Visible = $false
  $notify.Dispose()
  $icon.Dispose()
  try { [void][SystemMonitorTray.NativeDpi]::DestroyIcon($iconHandle) } catch {}
  $iconBitmap.Dispose()
  $ctx.Dispose()
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
}

exit 0
