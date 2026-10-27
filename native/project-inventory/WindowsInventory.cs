using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

// One request per process. No file contents are read and no path below the
// selected root is opened by concatenating a path from the directory listing.
internal static class WindowsInventory
{
    private const int InputMax = 32 * 1024;
    private const int OutputMax = 4 * 1024 * 1024;
    private const int EntryMax = 20000;
    private const int FileMax = 5000;
    private const long FileBytesMax = 256L * 1024 * 1024;
    private const long TotalBytesMax = 512L * 1024 * 1024;
    private const int DepthMax = 64;
    private const int DeadlineMs = 10000;
    private const uint FileReadAttributes = 0x80;
    private const uint FileListDirectoryOrReadData = 0x1;
    private const uint Synchronize = 0x00100000;
    private const uint ShareAll = 0x7;
    private const uint FileOpen = 0x1;
    private const uint FileSynchronousIoNonalert = 0x20;
    private const uint FileOpenReparsePoint = 0x00200000;
    private const uint ObjCaseInsensitive = 0x40;
    private const uint AttributeReparsePoint = 0x400;
    private const uint FileTypeDisk = 1;
    private const int FileStandardInfo = 1;
    private const int FileAttributeTagInfo = 9;
    private const int FileIdBothDirectoryInfo = 10;
    private const int FileIdInfo = 18;
    private const int ErrorNoMoreFiles = 18;
    private const int ErrorHandleEof = 38;
    private const int DirectoryNameOffset = 104;

    private static readonly Encoding Utf8 = new UTF8Encoding(false, true);
    private static readonly HashSet<string> Forbidden = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        ".git", ".codex", ".claude", ".agents", ".env", ".npmrc", ".netrc", ".ssh", ".aws",
        ".kube", ".gnupg", ".docker", ".pypirc", ".gitconfig", "agents.md", "claude.md",
        "credentials.json", "id_rsa", "id_ed25519"
    };
    private static readonly Regex SecretName = new Regex(
        @"^(?:.*\.(?:pem|p12|pfx|key|kdbx)|(?:secrets?|credentials?|tokens?)(?:[._-]|$))",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex AgentsName = new Regex(@"^agents(?:[._-].*)?\.md$",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    [StructLayout(LayoutKind.Sequential)]
    private struct UnicodeString
    {
        public ushort Length;
        public ushort MaximumLength;
        public IntPtr Buffer;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ObjectAttributes
    {
        public int Length;
        public IntPtr RootDirectory;
        public IntPtr ObjectName;
        public uint Attributes;
        public IntPtr SecurityDescriptor;
        public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoStatusBlock
    {
        public IntPtr Status;
        public IntPtr Information;
    }

    [DllImport("ntdll.dll", ExactSpelling = true)]
    private static extern int NtCreateFile(out SafeFileHandle handle, uint desiredAccess,
        ref ObjectAttributes attributes, out IoStatusBlock statusBlock, IntPtr allocationSize,
        uint fileAttributes, uint shareAccess, uint createDisposition, uint createOptions,
        IntPtr eaBuffer, uint eaLength);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass,
        [Out] byte[] buffer, uint bufferSize);

    [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
    private static extern uint GetFileType(SafeFileHandle handle);

    private sealed class UnsafeEntryException : Exception { }
    private sealed class InventoryException : Exception { }

    private sealed class FileRow
    {
        public string path { get; set; }
        public long bytes { get; set; }
    }

    private sealed class Response
    {
        public int version { get; set; }
        public List<FileRow> files { get; set; }
        public int omitted { get; set; }
    }

    private sealed class Inventory
    {
        private readonly Stopwatch clock = Stopwatch.StartNew();
        private readonly List<FileRow> files = new List<FileRow>();
        private readonly HashSet<string> seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private int entries;
        private int omitted;
        private long totalBytes;
        private ulong rootVolume;

        private void Deadline()
        {
            if (clock.ElapsedMilliseconds > DeadlineMs) throw new InventoryException();
        }

        internal Response Run(string selected)
        {
            string[] components = ValidateRoot(selected);
            string volumeRoot = @"\??\" + selected.Substring(0, 2) + @"\";
            using (SafeFileHandle volume = Open(null, volumeRoot))
            {
                HandleInfo volumeInfo = Inspect(volume);
                if (!volumeInfo.Directory) throw new InventoryException();
                rootVolume = volumeInfo.Volume;
                SafeFileHandle current = volume;
                var ancestors = new List<SafeFileHandle>();
                try
                {
                    for (int index = 0; index < components.Length; ++index)
                    {
                        Deadline();
                        if (index == components.Length - 1) Hook("before-root-open");
                        string component = components[index];
                        SafeFileHandle child = Open(current, component);
                        ancestors.Add(child);
                        HandleInfo info = Inspect(child);
                        if (!info.Directory || info.Volume != rootVolume) throw new InventoryException();
                        current = child;
                    }
                    Hook("after-root-open");
                    Enumerate(current, "", 0);
                }
                finally
                {
                    for (int i = ancestors.Count - 1; i >= 0; --i) ancestors[i].Dispose();
                }
            }
            files.Sort((a, b) => StringComparer.Ordinal.Compare(a.path, b.path));
            return new Response { version = 1, files = files, omitted = omitted };
        }

        private void Enumerate(SafeFileHandle directory, string prefix, int depth)
        {
            if (depth >= DepthMax) throw new InventoryException();
            Deadline();
            Hook("before-enumerate");
            byte[] buffer = new byte[64 * 1024];
            while (true)
            {
                Deadline();
                Array.Clear(buffer, 0, buffer.Length);
                if (!GetFileInformationByHandleEx(directory, FileIdBothDirectoryInfo, buffer, (uint)buffer.Length))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == ErrorNoMoreFiles || error == ErrorHandleEof) break;
                    throw new InventoryException();
                }
                int offset = 0;
                while (true)
                {
                    Deadline();
                    if (offset < 0 || offset > buffer.Length - DirectoryNameOffset) throw new InventoryException();
                    uint next = BitConverter.ToUInt32(buffer, offset);
                    uint nameBytes = BitConverter.ToUInt32(buffer, offset + 60);
                    if (nameBytes == 0 || (nameBytes & 1) != 0 || nameBytes > 510 ||
                        nameBytes > buffer.Length - offset - DirectoryNameOffset) throw new InventoryException();
                    string name = Encoding.Unicode.GetString(buffer, offset + DirectoryNameOffset, (int)nameBytes);
                    if (name != "." && name != "..") Visit(directory, prefix, depth, name);
                    if (next == 0) break;
                    if ((next & 7) != 0 || next < DirectoryNameOffset + nameBytes ||
                        next > buffer.Length - offset) throw new InventoryException();
                    offset += (int)next;
                }
            }
        }

        private void Visit(SafeFileHandle parent, string prefix, int depth, string name)
        {
            if (++entries > EntryMax) throw new InventoryException();
            string relative = prefix.Length == 0 ? name : prefix + "/" + name;
            if (!Allowed(name) || String.Equals(relative, "manifesto.json", StringComparison.OrdinalIgnoreCase)) { ++omitted; return; }
            if (Utf8.GetByteCount(relative) > 4096) throw new InventoryException();
            Deadline();
            Hook("before-child-open");
            try
            {
                using (SafeFileHandle child = Open(parent, name))
                {
                    Hook("after-child-open");
                    HandleInfo info = Inspect(child);
                    if (info.Volume != rootVolume) throw new UnsafeEntryException();
                    if (info.Directory)
                    {
                        if (depth + 1 >= DepthMax) throw new InventoryException();
                        Enumerate(child, relative, depth + 1);
                    }
                    else
                    {
                        if (info.Links != 1 || info.Size < 0) throw new UnsafeEntryException();
                        if (info.Size > FileBytesMax || files.Count >= FileMax ||
                            totalBytes + info.Size > TotalBytesMax) throw new InventoryException();
                        string key = relative.Normalize(NormalizationForm.FormC);
                        if (!seen.Add(key)) throw new InventoryException();
                        files.Add(new FileRow { path = relative, bytes = info.Size });
                        totalBytes += info.Size;
                    }
                }
            }
            catch (UnsafeEntryException) { ++omitted; }
        }
    }

    private sealed class HandleInfo
    {
        public bool Directory;
        public uint Links;
        public long Size;
        public ulong Volume;
    }

    private static HandleInfo Inspect(SafeFileHandle handle)
    {
        if (handle == null || handle.IsInvalid || GetFileType(handle) != FileTypeDisk)
            throw new UnsafeEntryException();
        byte[] tag = Query(handle, FileAttributeTagInfo, 8);
        if ((BitConverter.ToUInt32(tag, 0) & AttributeReparsePoint) != 0 ||
            BitConverter.ToUInt32(tag, 4) != 0) throw new UnsafeEntryException();
        byte[] standard = Query(handle, FileStandardInfo, 24);
        byte[] id = Query(handle, FileIdInfo, 24);
        if (standard[20] != 0) throw new UnsafeEntryException();
        return new HandleInfo {
            Size = BitConverter.ToInt64(standard, 8),
            Links = BitConverter.ToUInt32(standard, 16),
            Directory = standard[21] != 0,
            Volume = BitConverter.ToUInt64(id, 0)
        };
    }

    private static byte[] Query(SafeFileHandle handle, int infoClass, int size)
    {
        byte[] result = new byte[size];
        if (!GetFileInformationByHandleEx(handle, infoClass, result, (uint)size))
            throw new UnsafeEntryException();
        return result;
    }

    private static SafeFileHandle Open(SafeFileHandle parent, string name)
    {
        if (name.Length == 0 || name.Length > 32760 || name.IndexOf('\0') >= 0)
            throw new UnsafeEntryException();
        IntPtr chars = IntPtr.Zero;
        IntPtr unicodePointer = IntPtr.Zero;
        SafeFileHandle handle = null;
        try
        {
            chars = Marshal.StringToHGlobalUni(name);
            var unicode = new UnicodeString {
                Length = checked((ushort)(name.Length * 2)),
                MaximumLength = checked((ushort)((name.Length + 1) * 2)),
                Buffer = chars
            };
            unicodePointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString)));
            Marshal.StructureToPtr(unicode, unicodePointer, false);
            var attributes = new ObjectAttributes {
                Length = Marshal.SizeOf(typeof(ObjectAttributes)),
                RootDirectory = parent == null ? IntPtr.Zero : parent.DangerousGetHandle(),
                ObjectName = unicodePointer,
                Attributes = ObjCaseInsensitive
            };
            IoStatusBlock io;
            int status = NtCreateFile(out handle, FileReadAttributes | FileListDirectoryOrReadData | Synchronize,
                ref attributes, out io, IntPtr.Zero, 0, ShareAll, FileOpen,
                FileSynchronousIoNonalert | FileOpenReparsePoint, IntPtr.Zero, 0);
            if (status < 0 || handle == null || handle.IsInvalid) throw new UnsafeEntryException();
            return handle;
        }
        catch
        {
            if (handle != null) handle.Dispose();
            throw;
        }
        finally
        {
            if (unicodePointer != IntPtr.Zero) Marshal.FreeHGlobal(unicodePointer);
            if (chars != IntPtr.Zero) Marshal.FreeHGlobal(chars);
        }
    }

    private static bool Allowed(string name)
    {
        if (String.IsNullOrEmpty(name) || name == "." || name == ".." || name.EndsWith(".") ||
            name.EndsWith(" ") || name.IndexOfAny(new[] { '\\', '/', '<', '>', ':', '"', '|', '?', '*' }) >= 0 ||
            Forbidden.Contains(name) || name.StartsWith(".env.", StringComparison.OrdinalIgnoreCase) ||
            AgentsName.IsMatch(name) || SecretName.IsMatch(name)) return false;
        foreach (char c in name) if (Char.IsControl(c)) return false;
        string stem = name.Split('.')[0];
        if (Regex.IsMatch(stem, @"^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)) return false;
        return true;
    }

    private static string[] ValidateRoot(string root)
    {
        if (String.IsNullOrEmpty(root) || root.Length > 4096 || root.IndexOf('/') >= 0 ||
            !Regex.IsMatch(root, @"\A[A-Za-z]:\\")) throw new InventoryException();
        string remainder = root.Substring(3);
        if (remainder.EndsWith("\\", StringComparison.Ordinal)) remainder = remainder.Substring(0, remainder.Length - 1);
        if (remainder.Length == 0) return new string[0];
        string[] parts = remainder.Split('\\');
        foreach (string part in parts) if (!Allowed(part)) throw new InventoryException();
        return parts;
    }

    private static byte[] ReadFrame()
    {
        Stream stream = Console.OpenStandardInput();
        byte[] header = ReadExactly(stream, 4);
        uint length = ((uint)header[0] << 24) | ((uint)header[1] << 16) | ((uint)header[2] << 8) | header[3];
        if (length == 0 || length > InputMax) throw new InventoryException();
        byte[] payload = ReadExactly(stream, (int)length);
        if (stream.ReadByte() != -1) throw new InventoryException();
        return payload;
    }

    private static byte[] ReadExactly(Stream stream, int length)
    {
        byte[] bytes = new byte[length];
        int offset = 0;
        while (offset < length)
        {
            int read = stream.Read(bytes, offset, length - offset);
            if (read <= 0) throw new InventoryException();
            offset += read;
        }
        return bytes;
    }

    private sealed class JsonInput
    {
        private readonly string value;
        private int offset;

        internal JsonInput(byte[] frame) { value = Utf8.GetString(frame); }

        private void Space()
        {
            while (offset < value.Length && (value[offset] == ' ' || value[offset] == '\t' ||
                value[offset] == '\r' || value[offset] == '\n')) ++offset;
        }

        private void Take(char expected)
        {
            if (offset >= value.Length || value[offset++] != expected) throw new InventoryException();
        }

        private char UnicodeEscape()
        {
            if (offset + 4 > value.Length) throw new InventoryException();
            int code = 0;
            for (int i = 0; i < 4; ++i)
            {
                char digit = value[offset++];
                int hex = digit >= '0' && digit <= '9' ? digit - '0' :
                    digit >= 'A' && digit <= 'F' ? digit - 'A' + 10 :
                    digit >= 'a' && digit <= 'f' ? digit - 'a' + 10 : -1;
                if (hex < 0) throw new InventoryException();
                code = code * 16 + hex;
            }
            return (char)code;
        }

        private string String()
        {
            Take('"');
            var result = new StringBuilder();
            while (offset < value.Length)
            {
                char character = value[offset++];
                if (character == '"')
                {
                    string text = result.ToString();
                    for (int i = 0; i < text.Length; ++i)
                    {
                        if (Char.IsHighSurrogate(text[i])) {
                            if (++i >= text.Length || !Char.IsLowSurrogate(text[i])) throw new InventoryException();
                        } else if (Char.IsLowSurrogate(text[i])) throw new InventoryException();
                    }
                    return text;
                }
                if (character == '\\')
                {
                    if (offset >= value.Length) throw new InventoryException();
                    switch (value[offset++])
                    {
                        case '"': result.Append('"'); break;
                        case '\\': result.Append('\\'); break;
                        case '/': result.Append('/'); break;
                        case 'b': result.Append('\b'); break;
                        case 'f': result.Append('\f'); break;
                        case 'n': result.Append('\n'); break;
                        case 'r': result.Append('\r'); break;
                        case 't': result.Append('\t'); break;
                        case 'u': result.Append(UnicodeEscape()); break;
                        default: throw new InventoryException();
                    }
                }
                else
                {
                    if (character < 0x20) throw new InventoryException();
                    result.Append(character);
                }
            }
            throw new InventoryException();
        }

        internal string Root()
        {
            Space(); Take('{'); Space();
            bool version = false, root = false;
            string selected = null;
            while (offset < value.Length && value[offset] != '}')
            {
                string key = String();
                Space(); Take(':'); Space();
                if (key == "version" && !version) {
                    Take('1'); version = true;
                } else if (key == "root" && !root) {
                    selected = String(); root = true;
                } else throw new InventoryException();
                Space();
                if (offset < value.Length && value[offset] == '}') break;
                Take(','); Space();
                if (offset >= value.Length || value[offset] == '}') throw new InventoryException();
            }
            Take('}'); Space();
            if (!version || !root || offset != value.Length) throw new InventoryException();
            return selected;
        }
    }

    private static string ParseRoot(byte[] frame)
    {
        return new JsonInput(frame).Root();
    }

    private static void WriteFrame(Response result)
    {
        byte[] payload = Utf8.GetBytes(new JavaScriptSerializer { MaxJsonLength = OutputMax }.Serialize(result));
        if (payload.Length == 0 || payload.Length > OutputMax) throw new InventoryException();
        byte[] header = { (byte)(payload.Length >> 24), (byte)(payload.Length >> 16),
            (byte)(payload.Length >> 8), (byte)payload.Length };
        Stream output = Console.OpenStandardOutput();
        output.Write(header, 0, header.Length);
        output.Write(payload, 0, payload.Length);
        output.Flush();
    }

    private static void Hook(string name)
    {
#if TEST_HOOKS
        if (Environment.GetEnvironmentVariable("LUME_INVENTORY_TEST_HOOK") != name) return;
        string directory = Environment.GetEnvironmentVariable("LUME_INVENTORY_TEST_HOOK_DIR");
        if (String.IsNullOrEmpty(directory)) throw new InventoryException();
        string reached = Path.Combine(directory, name + ".reached");
        string release = Path.Combine(directory, name + ".release");
        File.WriteAllText(reached, "1");
        var wait = Stopwatch.StartNew();
        while (!File.Exists(release))
        {
            if (wait.ElapsedMilliseconds > 5000) throw new InventoryException();
            Thread.Sleep(10);
        }
#endif
    }

    public static int Main(string[] args)
    {
        try
        {
            if (args.Length != 0 || IntPtr.Size != 8 ||
                Marshal.SizeOf(typeof(UnicodeString)) != 16 ||
                Marshal.SizeOf(typeof(ObjectAttributes)) != 48 ||
                Marshal.SizeOf(typeof(IoStatusBlock)) != 16) return 2;
            string root = ParseRoot(ReadFrame());
            WriteFrame(new Inventory().Run(root));
            return 0;
        }
        catch { return 2; } // No absolute paths, exception strings or partial list on stderr.
    }
}
