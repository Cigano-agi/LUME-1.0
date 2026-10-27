using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

internal static class LumeAclTests
{
    private static RawSecurityDescriptor Descriptor(SecurityIdentifier owner, GenericAce ace, bool daclPresent, bool protectedDacl = false)
    {
        RawAcl acl = null;
        if (daclPresent)
        {
            acl = new RawAcl(2, ace == null ? 0 : 1);
            if (ace != null) acl.InsertAce(0, ace);
        }
        ControlFlags flags = daclPresent ? ControlFlags.DiscretionaryAclPresent : ControlFlags.None;
        if (protectedDacl) flags |= ControlFlags.DiscretionaryAclProtected;
        return new RawSecurityDescriptor(flags,
            owner, null, null, acl);
    }

    private static CommonAce Allow(SecurityIdentifier sid, uint mask, AceFlags flags)
    {
        return new CommonAce(flags, AceQualifier.AccessAllowed, unchecked((int)mask), sid, false, null);
    }

    private static bool Expect(bool accepted, RawSecurityDescriptor sd, SecurityIdentifier user, bool strict, bool root = false)
    {
        try { LumeAclPolicy.Check(sd, user, strict, root); return accepted; }
        catch (AclUntrustedException) { return !accepted; }
    }

    private static int Synthetic()
    {
        SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
        SecurityIdentifier other = new SecurityIdentifier(WellKnownSidType.WorldSid, null);
        SecurityIdentifier installer = (SecurityIdentifier)new NTAccount("NT SERVICE", "TrustedInstaller").Translate(typeof(SecurityIdentifier));
        int passed = 0;
        if (Expect(true, Descriptor(user, Allow(user, 0x10000000U, AceFlags.None), true), user, true)) passed++;
        if (Expect(false, Descriptor(other, null, true), user, true)) passed++;
        if (Expect(false, Descriptor(user, null, false), user, true)) passed++;
        if (Expect(false, Descriptor(user, Allow(other, 0x00000002U, AceFlags.None), true), user, true)) passed++;
        if (Expect(true, Descriptor(user, Allow(other, 0x00000002U, AceFlags.None), true), user, false)) passed++;
        if (Expect(false, Descriptor(user, Allow(other, 0x00000040U, AceFlags.None), true), user, false)) passed++;
        if (Expect(false, Descriptor(user, Allow(other, 0x10000000U, AceFlags.Inherited), true), user, false)) passed++;
        if (Expect(true, Descriptor(user, Allow(other, 0x10000000U, AceFlags.InheritOnly), true), user, true)) passed++;
        if (Expect(false, Descriptor(user, Allow(other, 0x40000000U, AceFlags.None), true), user, true)) passed++;
        if (Expect(false, Descriptor(user, Allow(other, 0x00040000U, AceFlags.None), true), user, false)) passed++;
        if (Expect(false, Descriptor(user, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, 0,
            other, true, new byte[] { 1, 2, 3, 4 }), true), user, true)) passed++;
        if (Expect(true, Descriptor(installer, null, true, true), user, false, true)) passed++;
        if (Expect(false, Descriptor(installer, null, true, true), user, false, false)) passed++;
        if (Expect(false, Descriptor(installer, null, true, false), user, false, true)) passed++;
        if (Expect(false, Descriptor(installer, null, true, true), user, true, true)) passed++;
        Console.Out.Write("SYNTHETIC:" + passed + "/15");
        return passed == 15 ? 0 : 1;
    }

    private static int Probe(string userData)
    {
        string full = Path.GetFullPath(userData);
        string root = Path.GetPathRoot(full);
        string[] pieces = full.Substring(root.Length).Split('\\');
        string current = root;
        SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
        for (int i = 0; i <= pieces.Length; i++)
        {
            if (i > 0) current = Path.Combine(current, pieces[i - 1]);
            try
            {
                FileAttributes attrs = File.GetAttributes(current);
                if ((attrs & FileAttributes.ReparsePoint) != 0) { Console.Out.Write((i == 0 ? "ROOT" : i == pieces.Length ? "PROFILE" : "ANCESTOR") + ":REPARSE"); return 1; }
                DirectorySecurity security = new DirectoryInfo(current).GetAccessControl(AccessControlSections.Access | AccessControlSections.Owner);
                LumeAclPolicy.Check(new RawSecurityDescriptor(security.GetSecurityDescriptorBinaryForm(), 0), user, i == pieces.Length, i == 0);
            }
            catch (AclUntrustedException e)
            {
                string ownerClass = "";
                if (e.Message == "OWNER")
                {
                    DirectorySecurity security = new DirectoryInfo(current).GetAccessControl(AccessControlSections.Owner);
                    SecurityIdentifier owner = security.GetOwner(typeof(SecurityIdentifier)) as SecurityIdentifier;
                    string sid = owner == null ? "" : owner.Value;
                    ownerClass = sid.StartsWith("S-1-5-80-", StringComparison.Ordinal) ? ":SERVICE_SID" :
                        sid.StartsWith("S-1-5-32-", StringComparison.Ordinal) ? ":BUILTIN_GROUP" :
                        sid.StartsWith("S-1-5-21-", StringComparison.Ordinal) ? ":LOCAL_OR_DOMAIN" : ":OTHER";
                }
                Console.Out.Write((i == 0 ? "ROOT" : i == pieces.Length ? "PROFILE" : "ANCESTOR") + ":" + e.Message + ownerClass + ":" + i);
                return 1;
            }
            catch { Console.Out.Write("INSPECTION_FAILED:" + i); return 1; }
        }
        Console.Out.Write("OK");
        return 0;
    }

    public static int Main(string[] args)
    {
        if (args.Length == 1 && args[0] == "--synthetic") return Synthetic();
        if (args.Length == 2 && args[0] == "--probe") return Probe(args[1]);
        return 1;
    }
}
