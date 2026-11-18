// Paper Reader.exe: the one file to double-click.
// Lives at the top of the Paper Reader folder, beside app\ (program files), or inside it.
// - Not installed yet (no node_modules): offers to run setup.ps1 in a visible window, then starts.
// - Installed: runs Start-Paper-Reader.ps1 hidden (server + app window); errors show in a message box.
// Build with scripts\build-launcher.ps1 (uses the C# compiler that ships with Windows).
using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Windows.Forms;

[assembly: AssemblyTitle("Paper Reader")]
[assembly: AssemblyProduct("Paper Reader")]
[assembly: AssemblyDescription("AI paper reader launcher")]
[assembly: AssemblyVersion("1.0.0.0")]

static class Launcher
{
    const string Title = "Paper Reader";

    static string PowerShell()
    {
        return Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");
    }

    static string Quote(string path) { return "\"" + path + "\""; }

    [STAThread]
    static int Main()
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        // Program files are normally in the app\ folder beside this exe.
        string app = Path.Combine(root, "app");
        if (File.Exists(Path.Combine(app, "Start-Paper-Reader.ps1"))) root = app;
        if (!File.Exists(Path.Combine(root, "Start-Paper-Reader.ps1")))
        {
            MessageBox.Show("找不到程式檔案。請把 Paper Reader.exe 放在 Paper Reader 資料夾最上層（旁邊要有 app 資料夾）再執行。", Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        if (!Directory.Exists(Path.Combine(root, "node_modules")) && !Install(root)) return 1;
        return Start(root);
    }

    // First run: full setup (packages, build, MinerU, whole-paper translation, desktop shortcut).
    static bool Install(string root)
    {
        DialogResult answer = MessageBox.Show(
            "Paper Reader 還沒安裝。\n\n要現在安裝嗎？會開啟安裝視窗，安裝套件、PDF 解析（MinerU）與整篇翻譯工具，約需 2 GB 空間與數分鐘。\n\n電腦沒有 Node.js 的話，安裝程式會自動安裝。",
            Title, MessageBoxButtons.YesNo, MessageBoxIcon.Question);
        if (answer != DialogResult.Yes) return false;
        // cmd keeps the window open on failure so the error can be read.
        string command = "/c \"" + Quote(PowerShell()) + " -NoProfile -ExecutionPolicy Bypass -File " + Quote(Path.Combine(root, "setup.ps1"))
            + " -MinerU -Translate || pause\"";
        ProcessStartInfo info = new ProcessStartInfo("cmd.exe", command);
        info.WorkingDirectory = root;
        info.UseShellExecute = false;
        Process setup = Process.Start(info);
        setup.WaitForExit();
        if (setup.ExitCode != 0 || !Directory.Exists(Path.Combine(root, "node_modules")))
        {
            MessageBox.Show("安裝沒有完成，請查看安裝視窗中的錯誤訊息後再試一次。", Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return false;
        }
        return true;
    }

    // Normal start: hidden PowerShell; its error text (if any) is shown to the user.
    static int Start(string root)
    {
        ProcessStartInfo info = new ProcessStartInfo(PowerShell(),
            "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File " + Quote(Path.Combine(root, "Start-Paper-Reader.ps1")));
        info.WorkingDirectory = root;
        info.UseShellExecute = false;
        info.CreateNoWindow = true;
        info.RedirectStandardError = true;
        Process process = Process.Start(info);
        string error = process.StandardError.ReadToEnd();
        process.WaitForExit();
        if (process.ExitCode != 0)
        {
            MessageBox.Show("無法啟動 Paper Reader：\n\n" + error.Trim(), Title, MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        return 0;
    }
}
