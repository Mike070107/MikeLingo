using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Text;
using System.Web.Script.Serialization;

internal static class Program
{
    private const string ExpectedName = "MikeLingo";
    private const string ExpectedKey = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAvcqn36UMTBTG0pwsDIJIE/DCe8lCR4OJq/5RTADq0nOGsXuBq2JBs2HoMN/F/e1EHCgDAz+S9LRS0bE+LfoRXifcCS/gzwik68YyViIdJOlUsZGUjaKLk+fjFtMwwBpphpiBgYboVDUaCWAM6RXUXgplmPAPPOLEMCNw3eoX1RMPiILrgthN37XTgatgQKsTlqqDPlv8PA5A24FXRYu8ZEMDCBSiCZXy7inNoOlgPibw3CY3B/CxBbGWxVtr3upr69NtH9KkrdI7W4cu8PQvMwi4QyS02y8hGeI+mDuG7PVkixt2ZpGmVdMjFRAjP3mtC93kceTolPkCddfDz685MQIDAQAB";
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private static void Main()
    {
        try
        {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;
            var request = ReadMessage();
            if (request == null || Get(request, "action") != "install") throw new Exception("不支持的更新请求");
            var version = Get(request, "version");
            var assetUrl = Get(request, "assetUrl");
            var assetName = Get(request, "assetName");
            ValidateRequest(version, assetUrl, assetName);
            Install(version, assetUrl);
            WriteMessage(new Dictionary<string, object> { { "ok", true }, { "version", version } });
        }
        catch (Exception ex)
        {
            WriteMessage(new Dictionary<string, object> { { "ok", false }, { "error", ex.Message } });
        }
    }

    private static Dictionary<string, object> ReadMessage()
    {
        var input = Console.OpenStandardInput();
        var lengthBytes = ReadExact(input, 4);
        if (lengthBytes == null) return null;
        int length = BitConverter.ToInt32(lengthBytes, 0);
        if (length <= 0 || length > 1024 * 1024) throw new Exception("更新请求大小异常");
        var payload = ReadExact(input, length);
        if (payload == null) throw new Exception("更新请求不完整");
        return Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(payload));
    }

    private static byte[] ReadExact(Stream stream, int count)
    {
        var data = new byte[count];
        int offset = 0;
        while (offset < count)
        {
            int read = stream.Read(data, offset, count - offset);
            if (read == 0) return null;
            offset += read;
        }
        return data;
    }

    private static void WriteMessage(object value)
    {
        var payload = Encoding.UTF8.GetBytes(Json.Serialize(value));
        var output = Console.OpenStandardOutput();
        var length = BitConverter.GetBytes(payload.Length);
        output.Write(length, 0, length.Length);
        output.Write(payload, 0, payload.Length);
        output.Flush();
    }

    private static string Get(Dictionary<string, object> obj, string key)
    {
        object value;
        return obj != null && obj.TryGetValue(key, out value) && value != null ? value.ToString() : "";
    }

    private static void ValidateRequest(string version, string assetUrl, string assetName)
    {
        Version parsed;
        if (!Version.TryParse(version, out parsed)) throw new Exception("目标版本号不合法");
        if (!String.Equals(assetName, "MikeLingo-v" + version + ".zip", StringComparison.OrdinalIgnoreCase)) throw new Exception("更新包名与版本不匹配");
        Uri uri;
        if (!Uri.TryCreate(assetUrl, UriKind.Absolute, out uri) || uri.Scheme != Uri.UriSchemeHttps) throw new Exception("更新地址不合法");
        var host = uri.Host.ToLowerInvariant();
        if (!(host == "github.com" || host.EndsWith(".github.com") || host == "objects.githubusercontent.com" || host == "release-assets.githubusercontent.com"))
            throw new Exception("拒绝从非 GitHub 域名下载");
    }

    private static void Install(string version, string assetUrl)
    {
        var appDir = AppDomain.CurrentDomain.BaseDirectory;
        var targetFile = Path.Combine(appDir, "install-path.txt");
        if (!File.Exists(targetFile)) throw new Exception("更新助手缺少安装目录配置");
        var target = Path.GetFullPath(File.ReadAllText(targetFile, Encoding.UTF8).Trim());
        var currentManifestPath = Path.Combine(target, "manifest.json");
        if (!File.Exists(currentManifestPath)) throw new Exception("已记录的 MikeLingo 安装目录已失效");
        var current = ReadManifest(currentManifestPath);
        AssertIdentity(current);
        var currentVersion = Get(current, "version");
        if (new Version(version).CompareTo(new Version(currentVersion)) <= 0) throw new Exception("目标版本必须高于当前版本");

        var work = Path.Combine(Path.GetTempPath(), "MikeLingoUpdater-" + Guid.NewGuid().ToString("N"));
        var zipPath = Path.Combine(work, "package.zip");
        var unpack = Path.Combine(work, "package");
        Directory.CreateDirectory(unpack);
        try
        {
            using (var client = new WebClient()) client.DownloadFile(assetUrl, zipPath);
            ExtractSafe(zipPath, unpack);
            var packageManifest = ReadManifest(Path.Combine(unpack, "manifest.json"));
            AssertIdentity(packageManifest);
            if (Get(packageManifest, "version") != version) throw new Exception("更新包版本与 Release 不一致");
            var backup = Path.Combine(appDir, "backup", currentVersion + "-" + DateTime.Now.ToString("yyyyMMddHHmmss"));
            Directory.CreateDirectory(backup);
            CopyDirectory(Path.Combine(target, "src"), Path.Combine(backup, "src"));
            CopyDirectory(Path.Combine(target, "icons"), Path.Combine(backup, "icons"));
            File.Copy(currentManifestPath, Path.Combine(backup, "manifest.json"), true);
            try
            {
                ReplaceDirectory(Path.Combine(unpack, "src"), Path.Combine(target, "src"));
                ReplaceDirectory(Path.Combine(unpack, "icons"), Path.Combine(target, "icons"));
                File.Copy(Path.Combine(unpack, "manifest.json"), currentManifestPath, true);
            }
            catch
            {
                ReplaceDirectory(Path.Combine(backup, "src"), Path.Combine(target, "src"));
                ReplaceDirectory(Path.Combine(backup, "icons"), Path.Combine(target, "icons"));
                File.Copy(Path.Combine(backup, "manifest.json"), currentManifestPath, true);
                throw;
            }
        }
        finally
        {
            try { if (Directory.Exists(work)) Directory.Delete(work, true); } catch { }
        }
    }

    private static Dictionary<string, object> ReadManifest(string path)
    {
        if (!File.Exists(path)) throw new Exception("更新包缺少 manifest.json");
        return Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path, Encoding.UTF8));
    }

    private static void AssertIdentity(Dictionary<string, object> manifest)
    {
        if (Get(manifest, "name") != ExpectedName || Get(manifest, "key") != ExpectedKey) throw new Exception("更新包身份校验失败");
    }

    private static void ExtractSafe(string zipPath, string destination)
    {
        var root = Path.GetFullPath(destination) + Path.DirectorySeparatorChar;
        using (var archive = ZipFile.OpenRead(zipPath))
        {
            foreach (var entry in archive.Entries)
            {
                var name = entry.FullName.Replace('/', Path.DirectorySeparatorChar);
                if (!(name == "manifest.json" || name.StartsWith("src" + Path.DirectorySeparatorChar) || name.StartsWith("icons" + Path.DirectorySeparatorChar)))
                    throw new Exception("更新包含有不允许的路径");
                var output = Path.GetFullPath(Path.Combine(destination, name));
                if (!output.StartsWith(root, StringComparison.OrdinalIgnoreCase)) throw new Exception("更新包路径越界");
                if (String.IsNullOrEmpty(entry.Name)) { Directory.CreateDirectory(output); continue; }
                Directory.CreateDirectory(Path.GetDirectoryName(output));
                entry.ExtractToFile(output, true);
            }
        }
    }

    private static void ReplaceDirectory(string source, string destination)
    {
        if (!Directory.Exists(source)) throw new Exception("更新包缺少 " + Path.GetFileName(source));
        var incoming = destination + ".update";
        if (Directory.Exists(incoming)) Directory.Delete(incoming, true);
        CopyDirectory(source, incoming);
        if (Directory.Exists(destination)) Directory.Delete(destination, true);
        Directory.Move(incoming, destination);
    }

    private static void CopyDirectory(string source, string destination)
    {
        Directory.CreateDirectory(destination);
        foreach (var file in Directory.GetFiles(source)) File.Copy(file, Path.Combine(destination, Path.GetFileName(file)), true);
        foreach (var dir in Directory.GetDirectories(source)) CopyDirectory(dir, Path.Combine(destination, Path.GetFileName(dir)));
    }
}
