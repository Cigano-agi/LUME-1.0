using System;
using System.Globalization;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

internal sealed class AclInputException : Exception { }
internal sealed class AclUntrustedException : Exception
{
    internal AclUntrustedException(string reason) : base(reason) { }
}

internal static class LumeAclPolicy
{
    private const uint ReplaceMask = 0x100D0040U; // GENERIC_ALL, DELETE, DELETE_CHILD, WRITE_DAC, WRITE_OWNER
    private const uint WriteMask = 0x40000116U;   // GENERIC_WRITE, data/add, append, EA, attributes

    internal static void Check(RawSecurityDescriptor descriptor, SecurityIdentifier current, bool strict)
    {
        Check(descriptor, current, strict, false);
    }

    internal static void Check(RawSecurityDescriptor descriptor, SecurityIdentifier current, bool strict, bool root)
    {
        if (descriptor == null || current == null ||
            (descriptor.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0 ||
            descriptor.DiscretionaryAcl == null || descriptor.Owner == null)
            throw new AclUntrustedException("DACL_OR_OWNER_MISSING");
        if (!Trusted(descriptor.Owner, current) && !ProtectedRootOwner(descriptor, strict, root))
            throw new AclUntrustedException("OWNER");
        foreach (GenericAce entry in descriptor.DiscretionaryAcl)
        {
            CommonAce ace = entry as CommonAce;
            if (ace == null || ace.SecurityIdentifier == null || ace.IsCallback || ace.OpaqueLength != 0)
                throw new AclUntrustedException("ACE_UNKNOWN");
            if (ace.AceType == AceType.AccessDenied && ace.AceQualifier == AceQualifier.AccessDenied) continue;
            if (ace.AceType != AceType.AccessAllowed || ace.AceQualifier != AceQualifier.AccessAllowed)
                throw new AclUntrustedException("ACE_UNKNOWN");
            if ((ace.AceFlags & AceFlags.InheritOnly) != 0) continue;
            if (Trusted(ace.SecurityIdentifier, current)) continue;
            uint rights = unchecked((uint)ace.AccessMask);
            if ((rights & ReplaceMask) != 0 || (strict && (rights & WriteMask) != 0))
                throw new AclUntrustedException((rights & ReplaceMask) != 0 ? "REPLACE_RIGHT" : "WRITE_RIGHT");
        }
    }

    private static bool Trusted(SecurityIdentifier sid, SecurityIdentifier current)
    {
        return sid.Equals(current) ||
            sid.Equals(new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null)) ||
            sid.Equals(new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null));
    }

    private static bool ProtectedRootOwner(RawSecurityDescriptor descriptor, bool strict, bool root)
    {
        if (!root || strict || (descriptor.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0)
            return false;
        try
        {
            SecurityIdentifier installer = (SecurityIdentifier)new NTAccount("NT SERVICE", "TrustedInstaller")
                .Translate(typeof(SecurityIdentifier));
            return descriptor.Owner.Equals(installer);
        }
        catch { return false; }
    }
}

internal static class LumeAcl
{
    private const int MaxPaths = 32;
    private const int MaxUtf8Bytes = 16 * 1024;

    private static string Canonical(string value)
    {
        if (String.IsNullOrEmpty(value) || value.Length < 3 ||
            !Char.IsLetter(value[0]) || value[1] != ':' || value[2] != '\\' ||
            value.IndexOf('/') >= 0 || value.IndexOf('\0') >= 0)
            throw new AclInputException();
        string[] components = value.Substring(3).Split('\\');
        for (int i = 0; i < components.Length; i++)
        {
            if (components[i].Length == 0 && !(components.Length == 1 && i == 0)) throw new AclInputException();
            if (components[i] == "." || components[i] == ".." ||
                components[i].EndsWith(".", StringComparison.Ordinal) ||
                components[i].EndsWith(" ", StringComparison.Ordinal) ||
                components[i].IndexOf(':') >= 0)
                throw new AclInputException();
        }
        string full = Path.GetFullPath(value);
        if (!String.Equals(full, value, StringComparison.OrdinalIgnoreCase)) throw new AclInputException();
        return full;
    }

    private static string[] Chain(string target)
    {
        string root = Path.GetPathRoot(target);
        string tail = target.Substring(root.Length);
        if (tail.Length == 0) return new string[] { root };
        string[] parts = tail.Split('\\');
        string[] chain = new string[parts.Length + 1];
        chain[0] = root;
        for (int i = 0; i < parts.Length; i++) chain[i + 1] = Path.Combine(chain[i], parts[i]);
        return chain;
    }

    private static void Inspect(string path, bool final, bool strict, bool root, SecurityIdentifier current)
    {
        FileAttributes attributes = File.GetAttributes(path);
        if ((attributes & FileAttributes.ReparsePoint) != 0) throw new AclUntrustedException("REPARSE");
        bool directory = (attributes & FileAttributes.Directory) != 0;
        if (!final && !directory) throw new AclUntrustedException("INTERMEDIATE_FILE");
        FileSystemSecurity security = directory
            ? (FileSystemSecurity)new DirectoryInfo(path).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner)
            : new FileInfo(path).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner);
        RawSecurityDescriptor descriptor = new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0);
        LumeAclPolicy.Check(descriptor, current, strict, root);
    }

    private static void Run(string[] args)
    {
        if (Environment.OSVersion.Platform != PlatformID.Win32NT) throw new PlatformNotSupportedException();
        if (args.Length < 4 || args.Length > MaxPaths + 3 || args[0] != "--check") throw new AclInputException();
        int strictFrom;
        if (!Int32.TryParse(args[2], NumberStyles.None, CultureInfo.InvariantCulture, out strictFrom)) throw new AclInputException();
        int count = args.Length - 3;
        if (strictFrom < 0 || strictFrom >= count) throw new AclInputException();
        int bytes = Encoding.UTF8.GetByteCount(args[1]);
        for (int i = 3; i < args.Length; i++) bytes += Encoding.UTF8.GetByteCount(args[i]);
        if (bytes > MaxUtf8Bytes) throw new AclInputException();
        string userData = Canonical(args[1]);
        string target = Canonical(args[args.Length - 1]);
        string[] expected = Chain(target);
        if (expected.Length != count || !String.Equals(expected[strictFrom], userData, StringComparison.OrdinalIgnoreCase))
            throw new AclInputException();
        for (int i = 0; i < count; i++)
            if (!String.Equals(expected[i], Canonical(args[i + 3]), StringComparison.OrdinalIgnoreCase))
                throw new AclInputException();
        FileAttributes userDataAttributes = File.GetAttributes(userData);
        if ((userDataAttributes & FileAttributes.Directory) == 0) throw new AclInputException();
        if ((userDataAttributes & FileAttributes.ReparsePoint) != 0) throw new AclUntrustedException("REPARSE");
        SecurityIdentifier current = WindowsIdentity.GetCurrent().User;
        if (current == null) throw new IOException();
        for (int i = 0; i < count; i++) Inspect(expected[i], i == count - 1, i >= strictFrom, i == 0, current);
    }

    public static int Main(string[] args)
    {
        string code;
        try { Run(args); code = "OK"; }
        catch (AclInputException) { code = "INVALID_INPUT"; }
        catch (AclUntrustedException) { code = "ACL_UNTRUSTED"; }
        catch (PlatformNotSupportedException) { code = "UNSUPPORTED"; }
        catch { code = "INSPECTION_FAILED"; }
        Console.Out.Write("{\"ok\":" + (code == "OK" ? "true" : "false") + ",\"code\":\"" + code + "\"}");
        return code == "OK" ? 0 : 1;
    }
}
