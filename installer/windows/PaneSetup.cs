// PaneSetup: the Windows installer for Pane apps.
//
// One generic program. `pane build` attaches the app to its end (see
// lib/installer-payload.js), so the same compiled file serves every app:
//   [PaneSetup.exe][config length: 4 bytes][config: key=value lines]
//   [app.paneapp][payload length: 8 bytes]["PANESET1"]
//
// It installs Pane first when the computer lacks the version the app was built
// with (downloaded from Pane's distribution, and refused unless its .sig
// verifies against one of Pane's public keys, which `pane build` puts in the
// config as releaseKeys=<n>.<e>,...), then installs the app with Pane's own
// command and opens it.
//
// Written for the C# 5 compiler that ships with Windows (csc.exe in
// %WINDIR%\Microsoft.NET\Framework64\v4.0.30319), so no SDK is needed.
// Build: node installer/windows/build.js
//
// PaneSetup.exe /quiet   installs without any window (exit code 0 = success)

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;

[assembly: AssemblyTitle("Pane Setup")]
[assembly: AssemblyProduct("Pane")]
[assembly: AssemblyDescription("Installs a Pane app, and Pane itself if needed")]

static class PaneSetup
{
    const int ExitNeedsNewerPane = 3;
    static readonly byte[] Magic = Encoding.ASCII.GetBytes("PANESET1");

    static bool quiet;
    static string logFile;
    static Form form;
    static Label status;
    static ProgressBar bar;

    [STAThread]
    static int Main(string[] args)
    {
        quiet = Array.Exists(args, a => a.Equals("/quiet", StringComparison.OrdinalIgnoreCase) || a == "--quiet");
        logFile = Path.Combine(Path.GetTempPath(), "pane-setup.log");
        File.WriteAllText(logFile, "Pane Setup " + DateTime.Now.ToString("s") + Environment.NewLine);

        Dictionary<string, string> config;
        byte[] paneapp;
        try
        {
            ReadPayload(out config, out paneapp);
        }
        catch (Exception e)
        {
            return Fail("This installer is damaged: " + e.Message);
        }
        if (quiet) return Install(config, paneapp);

        string name = Get(config, "name", "the app");
        Application.EnableVisualStyles();
        form = new Form
        {
            Text = "Install " + name,
            ClientSize = new Size(440, 118),
            FormBorderStyle = FormBorderStyle.FixedDialog,
            MaximizeBox = false,
            MinimizeBox = false,
            StartPosition = FormStartPosition.CenterScreen,
            ShowIcon = true,
        };
        try { form.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
        var title = new Label
        {
            Text = "Installing " + name,
            Font = new Font(SystemFonts.MessageBoxFont.FontFamily, 12f, FontStyle.Bold),
            Location = new Point(20, 16),
            Size = new Size(400, 26),
        };
        status = new Label { Text = "Starting…", Location = new Point(20, 48), Size = new Size(400, 20) };
        bar = new ProgressBar { Location = new Point(20, 76), Size = new Size(400, 18), Style = ProgressBarStyle.Marquee };
        form.Controls.AddRange(new Control[] { title, status, bar });

        int code = 1;
        form.Shown += delegate
        {
            var worker = new Thread(() =>
            {
                code = Install(config, paneapp);
                form.BeginInvoke((MethodInvoker)delegate { form.Close(); });
            });
            worker.IsBackground = true;
            worker.Start();
        };
        Application.Run(form);
        return code;
    }

    static int Install(Dictionary<string, string> config, byte[] paneapp)
    {
        string name = Get(config, "name", "the app");
        try
        {
            string version = Get(config, "paneVersion", "");
            string dist = Get(config, "distUrl", "");
            string envDist = Environment.GetEnvironmentVariable("PANE_DIST_URL");
            if (!string.IsNullOrEmpty(envDist)) dist = envDist;
            string home = Environment.GetEnvironmentVariable("PANE_HOME");
            if (string.IsNullOrEmpty(home))
                home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Pane");
            string pane = Path.Combine(home, "bin", "pane.cmd");

            string work = Path.Combine(Path.GetTempPath(), "pane-setup-" + Guid.NewGuid().ToString("N").Substring(0, 8));
            Directory.CreateDirectory(work);
            try
            {
                string package = Path.Combine(work, Path.GetFileName(Get(config, "package", "app.paneapp")));
                File.WriteAllBytes(package, paneapp);

                if (File.Exists(pane)) Status("Pane is already installed.");
                else InstallPane(version, dist, work, name, Get(config, "releaseKeys", ""));

                Status("Installing " + name + "…");
                string output;
                int code = RunPane(pane, package, out output);
                if (code == ExitNeedsNewerPane)
                {
                    Status(name + " needs a newer Pane.");
                    InstallPane(version, dist, work, name, Get(config, "releaseKeys", ""));
                    code = RunPane(pane, package, out output);
                }
                if (code != 0) return Fail(name + " could not be installed." + Environment.NewLine + Environment.NewLine + output.Trim());

                string launcher = LauncherFrom(output);
                Log("installed; launcher: " + launcher);
                if (!quiet && launcher != null && File.Exists(launcher))
                    Process.Start(new ProcessStartInfo(launcher) { UseShellExecute = true });
                return 0;
            }
            finally
            {
                try { Directory.Delete(work, true); } catch { }
            }
        }
        catch (Exception e)
        {
            return Fail(e.Message);
        }
    }

    // Downloads the Pane version the app was built with, checks its signature,
    // installs it.
    static void InstallPane(string version, string dist, string work, string name, string releaseKeys)
    {
        if (version == "") throw new Exception("This installer does not say which Pane version it needs.");
        if (dist == "")
            throw new Exception(name + " needs Pane " + version + ", and this installer does not know where to download it.");
        if (releaseKeys == "")
            throw new Exception(name + "'s installer has no key to check Pane's download, so it will not download Pane.");
        bool local = dist.StartsWith("http://127.0.0.1", StringComparison.OrdinalIgnoreCase)
                  || dist.StartsWith("http://localhost", StringComparison.OrdinalIgnoreCase);
        if (!dist.StartsWith("https://", StringComparison.OrdinalIgnoreCase) && !local)
            throw new Exception("Pane's download address must use https: " + dist);

        ServicePointManager.SecurityProtocol |= (SecurityProtocolType)3072; // TLS 1.2
        string file = "pane-runtime-" + version + "-win32-" + Arch() + ".tar.gz";
        string url = dist.TrimEnd('/') + "/v" + version + "/" + file;
        string archive = Path.Combine(work, file);

        Download(url, archive, "Downloading Pane " + version);
        byte[] signature;
        try
        {
            using (var client = new WebClient()) signature = client.DownloadData(url + ".sig");
        }
        catch (WebException)
        {
            throw new Exception("Could not download Pane's signature from " + url + ".sig. Nothing was installed.");
        }
        byte[] hash;
        using (var sha = SHA256.Create())
        using (var stream = File.OpenRead(archive))
            hash = sha.ComputeHash(stream);
        if (!VerifyRelease(hash, signature, releaseKeys))
            throw new Exception("The Pane download is not signed by Pane (signature check failed). Nothing was installed.");

        Status("Installing Pane " + version + "…");
        Marquee();
        string unpack = Path.Combine(work, "runtime");
        Directory.CreateDirectory(unpack);
        RunOrThrow(Path.Combine(Environment.SystemDirectory, "tar.exe"), Quote("-xzf") + " " + Quote(archive) + " -C " + Quote(unpack), null, "Unpacking Pane");
        var env = new Dictionary<string, string> { { "ELECTRON_RUN_AS_NODE", "1" } };
        string electron = Path.Combine(unpack, "node_modules", "electron", "dist", "electron.exe");
        RunOrThrow(electron, Quote(Path.Combine(unpack, "bin", "pane.js")) + " setup", env, "Installing Pane");
    }

    static void Download(string url, string target, string label)
    {
        Log("GET " + url);
        var request = (HttpWebRequest)WebRequest.Create(url);
        request.UserAgent = "PaneSetup";
        using (var response = (HttpWebResponse)request.GetResponse())
        using (var input = response.GetResponseStream())
        using (var output = File.Create(target))
        {
            long total = response.ContentLength;
            long done = 0;
            var buffer = new byte[81920];
            int read;
            int lastPercent = -1;
            while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                output.Write(buffer, 0, read);
                done += read;
                if (total > 0)
                {
                    int percent = (int)(done * 100 / total);
                    if (percent != lastPercent)
                    {
                        lastPercent = percent;
                        Progress(percent, label + " (" + (done / 1048576) + " of " + (total / 1048576) + " MB)");
                    }
                }
            }
        }
    }

    // Runs `pane install <package>` and returns its exit code and output.
    static int RunPane(string pane, string package, out string output)
    {
        var psi = new ProcessStartInfo("cmd.exe", "/c \"" + Quote(pane) + " install " + Quote(package) + "\"");
        return Run(psi, null, out output);
    }

    static void RunOrThrow(string exe, string args, Dictionary<string, string> env, string what)
    {
        string output;
        int code = Run(new ProcessStartInfo(exe, args), env, out output);
        if (code != 0) throw new Exception(what + " failed (exit code " + code + ")." + Environment.NewLine + output.Trim());
    }

    static int Run(ProcessStartInfo psi, Dictionary<string, string> env, out string output)
    {
        psi.UseShellExecute = false;
        psi.CreateNoWindow = true;
        psi.RedirectStandardOutput = true;
        psi.RedirectStandardError = true;
        if (env != null) foreach (var kv in env) psi.EnvironmentVariables[kv.Key] = kv.Value;
        Log("run " + psi.FileName + " " + psi.Arguments);
        var text = new StringBuilder();
        using (var p = new Process { StartInfo = psi })
        {
            p.OutputDataReceived += (s, e) => { if (e.Data != null) lock (text) text.AppendLine(e.Data); };
            p.ErrorDataReceived += (s, e) => { if (e.Data != null) lock (text) text.AppendLine(e.Data); };
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            p.WaitForExit();
            output = text.ToString();
            Log(output);
            return p.ExitCode;
        }
    }

    static string LauncherFrom(string output)
    {
        foreach (var line in output.Split('\n'))
        {
            string t = line.Trim();
            if (t.StartsWith("launcher:", StringComparison.Ordinal)) return t.Substring("launcher:".Length).Trim();
        }
        return null;
    }

    // keys: "<n>.<e>,<n>.<e>" (RSA modulus and exponent, base64url). True when
    // any key verifies the RSA PKCS#1 v1.5 SHA-256 signature over the hash.
    static bool VerifyRelease(byte[] sha256, byte[] signature, string keys)
    {
        foreach (string key in keys.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
        {
            string[] parts = key.Split('.');
            if (parts.Length != 2) continue;
            try
            {
                using (var rsa = new RSACryptoServiceProvider())
                {
                    rsa.ImportParameters(new RSAParameters { Modulus = Base64Url(parts[0]), Exponent = Base64Url(parts[1]) });
                    if (rsa.VerifyHash(sha256, CryptoConfig.MapNameToOID("SHA256"), signature)) return true;
                }
            }
            catch (CryptographicException e)
            {
                Log("release key check failed: " + e.Message);
            }
        }
        return false;
    }

    static byte[] Base64Url(string s)
    {
        string b = s.Replace('-', '+').Replace('_', '/');
        switch (b.Length % 4) { case 2: b += "=="; break; case 3: b += "="; break; }
        return Convert.FromBase64String(b);
    }

    static void ReadPayload(out Dictionary<string, string> config, out byte[] paneapp)
    {
        string self = Assembly.GetExecutingAssembly().Location;
        using (var f = File.OpenRead(self))
        {
            if (f.Length < 16) throw new Exception("too small");
            var tail = new byte[16];
            f.Seek(-16, SeekOrigin.End);
            ReadExactly(f, tail);
            for (int i = 0; i < 8; i++) if (tail[8 + i] != Magic[i]) throw new Exception("no app is attached");
            long size = BitConverter.ToInt64(tail, 0);
            long start = f.Length - 16 - size;
            if (size < 4 || start < 0) throw new Exception("bad size");
            f.Seek(start, SeekOrigin.Begin);
            var lenBytes = new byte[4];
            ReadExactly(f, lenBytes);
            int textLen = BitConverter.ToInt32(lenBytes, 0);
            var textBytes = new byte[textLen];
            ReadExactly(f, textBytes);
            paneapp = new byte[size - 4 - textLen];
            ReadExactly(f, paneapp);
            config = new Dictionary<string, string>();
            foreach (var line in Encoding.UTF8.GetString(textBytes).Split('\n'))
            {
                int eq = line.IndexOf('=');
                if (eq > 0) config[line.Substring(0, eq)] = line.Substring(eq + 1);
            }
        }
    }

    static void ReadExactly(Stream s, byte[] buffer)
    {
        int off = 0;
        while (off < buffer.Length)
        {
            int n = s.Read(buffer, off, buffer.Length - off);
            if (n <= 0) throw new Exception("unexpected end of file");
            off += n;
        }
    }

    static string Arch()
    {
        string a = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITEW6432");
        if (string.IsNullOrEmpty(a)) a = Environment.GetEnvironmentVariable("PROCESSOR_ARCHITECTURE") ?? "";
        return a.ToUpperInvariant().Contains("ARM64") ? "arm64" : "x64";
    }

    static string Get(Dictionary<string, string> c, string key, string fallback)
    {
        string v;
        return c.TryGetValue(key, out v) && v != "" ? v : fallback;
    }

    static string Quote(string s) { return "\"" + s + "\""; }

    static void Log(string text)
    {
        try { File.AppendAllText(logFile, text + Environment.NewLine); } catch { }
    }

    static void Status(string text)
    {
        Log(text);
        if (form != null) form.BeginInvoke((MethodInvoker)delegate { status.Text = text; });
    }

    static void Progress(int percent, string text)
    {
        if (form == null) return;
        form.BeginInvoke((MethodInvoker)delegate
        {
            bar.Style = ProgressBarStyle.Continuous;
            bar.Value = Math.Max(0, Math.Min(100, percent));
            status.Text = text;
        });
    }

    static void Marquee()
    {
        if (form != null) form.BeginInvoke((MethodInvoker)delegate { bar.Style = ProgressBarStyle.Marquee; });
    }

    static int Fail(string message)
    {
        Log("FAILED: " + message);
        if (!quiet) MessageBox.Show(message, "Installation failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
        return 1;
    }
}
