using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Management;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using Microsoft.Win32.SafeHandles;

namespace SystemMonitorLauncher
{
    internal static class Program
    {
        private const string AppTitle = "系统监控";
        private const int DefaultPort = 3000;
        private const string PortEnvVar = "SM_PORT";

        private static string AppUrl { get { return "http://127.0.0.1:" + appPort + "/"; } }
        private static string MetricsUrl { get { return "http://127.0.0.1:" + appPort + "/api/metrics"; } }
        private static int appPort = DefaultPort;

        private const uint GenericRead = 0x80000000;
        private const uint GenericWrite = 0x40000000;
        private const uint FileShareReadWrite = 0x00000003;
        private const uint OpenExisting = 3;
        private const uint CreateAlways = 2;
        private const uint FileAttributeNormal = 0x00000080;
        private const int StartfUseStdHandles = 0x00000100;
        private const int StartfUseShowWindow = 0x00000001;
        private const short SwHide = 0;
        private const uint CreateNoWindow = 0x08000000;

        private static string appDir;
        private static bool silent;

        [STAThread]
        private static int Main(string[] args)
        {
            bool stop = false;
            int cliPort = 0;
            for (int i = 0; i < args.Length; i++)
            {
                string arg = args[i];
                if (string.Equals(arg, "--stop", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(arg, "/stop", StringComparison.OrdinalIgnoreCase))
                {
                    stop = true;
                }
                else if (string.Equals(arg, "--silent", StringComparison.OrdinalIgnoreCase) ||
                         string.Equals(arg, "/silent", StringComparison.OrdinalIgnoreCase))
                {
                    silent = true;
                }
                else if (arg.StartsWith("--port=", StringComparison.OrdinalIgnoreCase))
                {
                    cliPort = ParsePort(arg.Substring("--port=".Length), 0);
                }
                else if (string.Equals(arg, "--port", StringComparison.OrdinalIgnoreCase) &&
                         i + 1 < args.Length)
                {
                    cliPort = ParsePort(args[i + 1], 0);
                }
            }

            appPort = ResolvePort(cliPort);
            appDir = ResolveAppDir();

            using (Mutex mutex = new Mutex(false, "Local\\SystemMonitorLauncher"))
            {
                bool acquired = false;
                try
                {
                    acquired = mutex.WaitOne(5000);
                }
                catch (AbandonedMutexException)
                {
                    acquired = true;
                }
                if (!acquired) return 0;

                try
                {
                    if (stop) return StopRunning();
                    return Launch();
                }
                catch (Exception ex)
                {
                    Fail("系统监控启动失败：\n" + ex.Message);
                    return 1;
                }
                finally
                {
                    try { mutex.ReleaseMutex(); } catch { }
                }
            }
        }

        private static int Launch()
        {
            if (IsOurServerRunning())
            {
                if (!silent) OpenBrowser();
                return 0;
            }

            if (IsPortOccupied())
            {
                if (WaitForServer(3))
                {
                    if (!silent) OpenBrowser();
                    return 0;
                }
                Fail("端口 " + appPort + " 已被其他程序占用，系统监控无法启动。\n" +
                    "请关闭占用该端口的程序，或改用其他端口：node port.js set <端口>");
                return 2;
            }

            if (!File.Exists(Path.Combine(appDir, "server.js")))
            {
                Fail("安装文件不完整：未找到 server.js。\n请重新安装系统监控。");
                return 3;
            }

            string nodePath = ResolveNode();
            if (nodePath == null)
            {
                Fail("未找到 Node.js 运行时。\n请重新安装系统监控，或安装 Node.js 18 及以上版本。");
                return 4;
            }

            if (!StartServer(nodePath))
            {
                Fail("无法启动后台服务。\n日志：" + LogPath("server.err.log"));
                return 5;
            }

            if (!WaitForServer(20))
            {
                Fail("后台服务启动超时。\n请查看日志：" + LogPath("server.err.log"));
                return 6;
            }

            if (!silent) OpenBrowser();
            return 0;
        }

        private static string ResolveAppDir()
        {
            string exeDir = AppDomain.CurrentDomain.BaseDirectory.TrimEnd(
                Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (File.Exists(Path.Combine(exeDir, "server.js"))) return exeDir;

            DirectoryInfo parent = Directory.GetParent(exeDir);
            if (parent != null && File.Exists(Path.Combine(parent.FullName, "server.js")))
                return parent.FullName;

            return exeDir;
        }

        // 与 server.js 的 port.js 保持一致：--port > SM_PORT > %LOCALAPPDATA%\SystemMonitor\port.txt > 3000
        private static int ResolvePort(int cliPort)
        {
            if (cliPort > 0) return cliPort;

            int fromEnv = ParsePort(Environment.GetEnvironmentVariable(PortEnvVar), 0);
            if (fromEnv > 0) return fromEnv;

            try
            {
                string path = PortConfigPath();
                if (File.Exists(path))
                {
                    string firstLine = null;
                    using (StreamReader reader = new StreamReader(path, Encoding.UTF8))
                    {
                        firstLine = reader.ReadLine();
                    }
                    int fromFile = ParsePort(firstLine, 0);
                    if (fromFile > 0) return fromFile;
                }
            }
            catch (Exception ex)
            {
                Log("Failed to read port config: " + ex.Message);
            }

            return DefaultPort;
        }

        private static string PortConfigPath()
        {
            string overrideDir = Environment.GetEnvironmentVariable("SYSTEM_MONITOR_DATA_DIR");
            if (!string.IsNullOrEmpty(overrideDir)) return Path.Combine(overrideDir, "port.txt");

            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            if (string.IsNullOrEmpty(localAppData))
                localAppData = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                    "AppData", "Local");
            return Path.Combine(localAppData, "SystemMonitor", "port.txt");
        }

        private static int ParsePort(string raw, int fallback)
        {
            if (string.IsNullOrEmpty(raw)) return fallback;
            int value;
            if (!int.TryParse(raw.Trim(), out value)) return fallback;
            if (value < 1 || value > 65535) return fallback;
            return value;
        }

        private static string ResolveNode()
        {
            string bundled = Path.Combine(appDir, "runtime", "node", "node.exe");
            if (File.Exists(bundled)) return bundled;

            string pathVar = Environment.GetEnvironmentVariable("PATH");
            if (!string.IsNullOrEmpty(pathVar))
            {
                foreach (string entry in pathVar.Split(';'))
                {
                    string dirValue = entry.Trim().Trim('"');
                    if (dirValue.Length == 0) continue;
                    string candidate = Path.Combine(dirValue, "node.exe");
                    if (File.Exists(candidate)) return candidate;
                }
            }

            string programFiles = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
            string programFilesX86 = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86);
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

            string[] candidates = new string[]
            {
                Path.Combine(programFiles, "nodejs", "node.exe"),
                Path.Combine(programFilesX86, "nodejs", "node.exe"),
                Path.Combine(localAppData, "Programs", "nodejs", "node.exe"),
                Path.Combine(localAppData, "Microsoft", "WinGet", "Links", "node.exe"),
                Path.Combine(userProfile, ".lmstudio", ".internal", "utils", "node.exe"),
                Path.Combine(appData, "nvm", "current", "node.exe"),
                Path.Combine(userProfile, "scoop", "apps", "nodejs", "current", "node.exe")
            };

            foreach (string candidate in candidates)
            {
                if (File.Exists(candidate)) return candidate;
            }
            return null;
        }

        private static bool StartServer(string nodePath)
        {
            string serverScript = Path.Combine(appDir, "server.js");
            string outLog = LogPath("server.log");
            string errLog = LogPath("server.err.log");

            SafeFileHandle outHandle = OpenInheritable(outLog, GenericWrite, CreateAlways);
            SafeFileHandle errHandle = OpenInheritable(errLog, GenericWrite, CreateAlways);
            SafeFileHandle nulHandle = OpenInheritable("NUL", GenericRead, OpenExisting);

            try
            {
                if (outHandle.IsInvalid || errHandle.IsInvalid || nulHandle.IsInvalid)
                {
                    Log("Unable to open log files in " + appDir);
                    return false;
                }

                STARTUPINFO startup = new STARTUPINFO();
                startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                startup.dwFlags = StartfUseStdHandles | StartfUseShowWindow;
                startup.wShowWindow = SwHide;
                startup.hStdInput = nulHandle.DangerousGetHandle();
                startup.hStdOutput = outHandle.DangerousGetHandle();
                startup.hStdError = errHandle.DangerousGetHandle();

                StringBuilder commandLine = new StringBuilder();
                commandLine.Append('"').Append(nodePath).Append("\" \"")
                    .Append(serverScript).Append('"')
                    .Append(" --port ").Append(appPort);

                PROCESS_INFORMATION processInfo;
                bool started = CreateProcess(
                    nodePath,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    true,
                    CreateNoWindow,
                    IntPtr.Zero,
                    appDir,
                    ref startup,
                    out processInfo);

                if (!started)
                {
                    Log("CreateProcess failed with error " + Marshal.GetLastWin32Error());
                    return false;
                }

                CloseHandle(processInfo.hThread);
                CloseHandle(processInfo.hProcess);
                return true;
            }
            finally
            {
                outHandle.Dispose();
                errHandle.Dispose();
                nulHandle.Dispose();
            }
        }

        private static bool IsOurServerRunning()
        {
            try
            {
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(MetricsUrl);
                request.Method = "GET";
                request.Timeout = 700;
                request.ReadWriteTimeout = 700;
                request.Proxy = null;
                request.KeepAlive = false;

                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                using (Stream stream = response.GetResponseStream())
                using (StreamReader reader = new StreamReader(stream, Encoding.UTF8))
                {
                    string body = reader.ReadToEnd();
                    return body.IndexOf("\"cpu\"", StringComparison.OrdinalIgnoreCase) >= 0 &&
                           body.IndexOf("\"memory\"", StringComparison.OrdinalIgnoreCase) >= 0;
                }
            }
            catch
            {
                return false;
            }
        }

        private static bool IsPortOccupied()
        {
            try
            {
                using (TcpClient client = new TcpClient())
                {
                    IAsyncResult result = client.BeginConnect(IPAddress.Loopback, appPort, null, null);
                    bool connected = result.AsyncWaitHandle.WaitOne(400);
                    if (!connected) return false;
                    try
                    {
                        client.EndConnect(result);
                        return true;
                    }
                    catch
                    {
                        return false;
                    }
                }
            }
            catch
            {
                return false;
            }
        }

        private static bool WaitForServer(int seconds)
        {
            Stopwatch watch = Stopwatch.StartNew();
            while (watch.Elapsed.TotalSeconds < seconds)
            {
                if (IsOurServerRunning()) return true;
                Thread.Sleep(250);
            }
            return false;
        }

        private static int StopRunning()
        {
            List<int> pids = FindServerProcesses();
            bool wasRunning = pids.Count > 0 || IsOurServerRunning();

            foreach (int pid in pids)
            {
                try
                {
                    using (Process process = Process.GetProcessById(pid))
                    {
                        process.Kill();
                        process.WaitForExit(5000);
                    }
                }
                catch (ArgumentException)
                {
                }
                catch (Exception ex)
                {
                    Log("Failed to stop pid " + pid + ": " + ex.Message);
                }
            }

            Stopwatch watch = Stopwatch.StartNew();
            while (watch.ElapsedMilliseconds < 6000 && IsOurServerRunning())
                Thread.Sleep(200);

            if (wasRunning) Thread.Sleep(3500);
            return IsOurServerRunning() ? 1 : 0;
        }

        private static List<int> FindServerProcesses()
        {
            List<int> result = new List<int>();
            string serverScript = Path.Combine(appDir, "server.js");
            string bundledNode = Path.Combine(appDir, "runtime", "node", "node.exe");

            try
            {
                using (ManagementObjectSearcher searcher = new ManagementObjectSearcher(
                    "SELECT ProcessId, CommandLine, ExecutablePath FROM Win32_Process WHERE Name = 'node.exe'"))
                using (ManagementObjectCollection items = searcher.Get())
                {
                    foreach (ManagementObject item in items)
                    {
                        using (item)
                        {
                            int pid;
                            try
                            {
                                pid = Convert.ToInt32(item["ProcessId"]);
                            }
                            catch
                            {
                                continue;
                            }

                            string commandLine = Convert.ToString(item["CommandLine"]);
                            string executable = Convert.ToString(item["ExecutablePath"]);

                            bool ours = commandLine != null &&
                                commandLine.IndexOf(serverScript, StringComparison.OrdinalIgnoreCase) >= 0;

                            if (!ours && executable != null &&
                                executable.Equals(bundledNode, StringComparison.OrdinalIgnoreCase) &&
                                commandLine != null &&
                                commandLine.IndexOf("server.js", StringComparison.OrdinalIgnoreCase) >= 0)
                            {
                                ours = true;
                            }

                            if (ours && !result.Contains(pid)) result.Add(pid);
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Log("WMI query failed: " + ex.Message);
            }

            return result;
        }

        private static void OpenBrowser()
        {
            try
            {
                Process.Start(new ProcessStartInfo(AppUrl) { UseShellExecute = true });
            }
            catch
            {
            }
        }

        private static void Fail(string message)
        {
            Log("ERROR: " + message.Replace("\r", " ").Replace("\n", " "));
            if (!silent)
                MessageBox.Show(message, AppTitle, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }

        private static string LogPath(string name)
        {
            return Path.Combine(appDir, name);
        }

        private static void Log(string message)
        {
            try
            {
                string path = LogPath("launcher.log");
                File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "  " + message + Environment.NewLine);
            }
            catch
            {
            }
        }

        private static SafeFileHandle OpenInheritable(string path, uint access, uint creation)
        {
            SECURITY_ATTRIBUTES security = new SECURITY_ATTRIBUTES();
            security.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            security.lpSecurityDescriptor = IntPtr.Zero;
            security.bInheritHandle = true;

            return CreateFile(
                path,
                access,
                FileShareReadWrite,
                ref security,
                creation,
                FileAttributeNormal,
                IntPtr.Zero);
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_ATTRIBUTES
        {
            public int nLength;
            public IntPtr lpSecurityDescriptor;
            [MarshalAs(UnmanagedType.Bool)]
            public bool bInheritHandle;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        private struct STARTUPINFO
        {
            public int cb;
            public string lpReserved;
            public string lpDesktop;
            public string lpTitle;
            public int dwX;
            public int dwY;
            public int dwXSize;
            public int dwYSize;
            public int dwXCountChars;
            public int dwYCountChars;
            public int dwFillAttribute;
            public int dwFlags;
            public short wShowWindow;
            public short cbReserved2;
            public IntPtr lpReserved2;
            public IntPtr hStdInput;
            public IntPtr hStdOutput;
            public IntPtr hStdError;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct PROCESS_INFORMATION
        {
            public IntPtr hProcess;
            public IntPtr hThread;
            public int dwProcessId;
            public int dwThreadId;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern SafeFileHandle CreateFile(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            ref SECURITY_ATTRIBUTES securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern bool CreateProcess(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref STARTUPINFO startupInfo,
            out PROCESS_INFORMATION processInformation);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
